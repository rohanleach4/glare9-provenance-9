import { join } from "node:path";

import {
  canonicalEventBytes,
  compressBlock,
  createRoutingPolicy,
  decompressBlock,
  domainHash,
  eventHashHex,
  fromHex,
  G9pError,
  LocalFilesystemSealedStorage,
  requireSealedStorage,
  routeEvent,
  toHex,
  validateEvent,
  verifyRoutingEpochBytes,
  verifyCheckpointBytes,
  verifySegmentBytes,
  writeRoutingEpoch,
  writeCheckpoint,
  writeSegment,
} from "@glare9/provenance";

import { DurableIntake } from "./durable-intake.js";
import { ActiveSegmentStore } from "./active-segment-store.js";

const DEFAULT_LIFECYCLE = Object.freeze({
  blockMaxBytes: 1024 * 1024,
  blockMaxRecords: 1_000,
  segmentMaxBytes: 32 * 1024 * 1024,
  segmentMaxRecords: 10_000,
  segmentMaxAgeMs: 30_000,
  maxAcceptedEvents: 100_000,
  maxAcceptedBytes: 1024 * 1024 * 1024,
  maxActiveBlockBytes: 16 * 1024 * 1024,
});

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new G9pError("LEDGER_LIFECYCLE_CONFIG", `${name} must be a positive safe integer`);
  }
  return value;
}

function lifecycleConfig(options = {}) {
  const config = {};
  for (const [name, fallback] of Object.entries(DEFAULT_LIFECYCLE)) {
    config[name] = positiveInteger(options[name] ?? fallback, name);
  }
  if (config.blockMaxBytes < 1024) {
    throw new G9pError("LEDGER_LIFECYCLE_CONFIG", "blockMaxBytes must be at least 1,024 bytes");
  }
  if (config.blockMaxBytes > 64 * 1024 * 1024 || config.segmentMaxBytes > 64 * 1024 * 1024
    || config.segmentMaxRecords > 100_000) {
    throw new G9pError("LEDGER_LIFECYCLE_CONFIG", "Block and segment limits exceed the supported provisional-state bounds");
  }
  if (config.segmentMaxBytes < config.blockMaxBytes || config.segmentMaxRecords < config.blockMaxRecords) {
    throw new G9pError("LEDGER_LIFECYCLE_CONFIG", "Segment limits must be at least their corresponding block limits");
  }
  if (config.maxActiveBlockBytes < config.blockMaxBytes) {
    throw new G9pError("LEDGER_LIFECYCLE_CONFIG", "maxActiveBlockBytes must be at least blockMaxBytes");
  }
  return Object.freeze(config);
}

function framedEventBytes(event) {
  const bytes = canonicalEventBytes(event);
  const framed = Buffer.allocUnsafe(4 + bytes.byteLength);
  framed.writeUInt32BE(bytes.byteLength, 0);
  Buffer.from(bytes).copy(framed, 4);
  return framed;
}

function ledgerDirectoryName(ledgerId) {
  return toHex(domainHash("ledger-directory-v1", Buffer.from(ledgerId, "utf8")));
}

function stateKey(ledgerId, epochNumber, shardId) {
  return `${ledgerId}\0${epochNumber}\0${shardId}`;
}

function segmentFileName(segmentNumber) {
  return `segment-${segmentNumber.toString().padStart(12, "0")}.g9p`;
}

function routingEpochFileName(epochNumber) {
  return `epoch-${epochNumber.toString().padStart(12, "0")}.g9p`;
}

function checkpointFileName(checkpointNumber) {
  return `checkpoint-${checkpointNumber.toString().padStart(12, "0")}.g9p`;
}

function epochDirectoryName(epochNumber) {
  return `epoch-${epochNumber.toString().padStart(12, "0")}`;
}

function epochStorageKey(ledgerDirectory, epochNumber) {
  return `${ledgerDirectory}\0${epochNumber}`;
}

function ledgerEpochKey(ledgerId, epochNumber) {
  return `${ledgerId}\0${epochNumber}`;
}

function routingPoliciesEqual(left, right) {
  return left.id === right.id
    && left.version === right.version
    && left.shardCount === right.shardCount;
}

export class LocalLedger {
  constructor({
    dataDirectory,
    signer,
    topologyAuthority,
    checkpointPublisher = signer,
    shardCount = 1,
    adoptLegacyRoutingHistory = false,
    lifecycle,
    sealedStorage,
    testFaultInjector,
  }) {
    if (topologyAuthority?.algorithm !== "ed25519" || !topologyAuthority.privateKey || !(topologyAuthority.publicKeyDer instanceof Uint8Array)) {
      throw new G9pError("LEDGER_TOPOLOGY_AUTHORITY", "A local Ed25519 topology authority is required");
    }
    if (checkpointPublisher?.algorithm !== "ed25519" || !checkpointPublisher.privateKey || !(checkpointPublisher.publicKeyDer instanceof Uint8Array)) {
      throw new G9pError("LEDGER_CHECKPOINT_PUBLISHER", "A distinct-capable Ed25519 checkpoint publisher is required");
    }
    this.dataDirectory = dataDirectory;
    this.intakeDirectory = join(dataDirectory, "intake");
    this.activeStateDirectory = join(dataDirectory, "provisional");
    this.signer = signer;
    this.topologyAuthority = topologyAuthority;
    this.checkpointPublisher = checkpointPublisher;
    this.adoptLegacyRoutingHistory = adoptLegacyRoutingHistory;
    this.testFaultInjector = testFaultInjector;
    this.sealedStorage = requireSealedStorage(sealedStorage
      ?? new LocalFilesystemSealedStorage(dataDirectory, { testFaultInjector }));
    this.defaultRoutingPolicy = createRoutingPolicy(shardCount);
    this.lifecycle = lifecycleConfig(lifecycle);
    this.routingEpochs = new Map();
    this.routingEpochDirectories = new Map();
    this.routingHistory = new Map();
    this.ledgerSegmentFormats = new Map();
    this.eventIndex = new Map();
    this.pendingIndex = new Map();
    this.provisionalIndex = new Map();
    this.shardStates = new Map();
    this.activeSegments = new Map();
    this.assignedPendingIds = new Set();
    this.pendingBytes = 0;
    this.activeBlockBytes = 0;
    this.intake = new DurableIntake(this.intakeDirectory, { testFaultInjector });
    this.activeStore = new ActiveSegmentStore(this.activeStateDirectory, { testFaultInjector });
    this.operationTail = Promise.resolve();
    this.ageTimer = undefined;
    this.backgroundError = null;
  }

  async initialize() {
    await this.sealedStorage.initialize();
    await this.#loadRoutingEpochs();
    const historicalLedgers = new Set();
    const histories = new Map();
    for (const key of await this.sealedStorage.list("segments/")) {
      const v1 = /^segments\/([0-9a-f]{64})\/(shard-[0-9]{4})\/(segment-[0-9]{12}\.g9p)$/u.exec(key);
      const v2 = /^segments\/([0-9a-f]{64})\/(epoch-([0-9]{12}))\/(shard-[0-9]{4})\/(segment-[0-9]{12}\.g9p)$/u.exec(key);
      if (v1 === null && v2 === null) {
        throw new G9pError("LEDGER_SEGMENT_FILE", `Unexpected sealed segment storage key ${key}`);
      }
      const ledgerDirectory = (v1 ?? v2)[1];
      const epochNumber = v1 === null ? Number(v2[3]) : null;
      const shardId = v1?.[2] ?? v2[4];
      const groupKey = `${ledgerDirectory}\0${epochNumber ?? "legacy"}\0${shardId}`;
      const group = histories.get(groupKey) ?? { ledgerDirectory, epochNumber, shardId, keys: [] };
      group.keys.push(key);
      histories.set(groupKey, group);
    }
    for (const history of [...histories.values()].sort((left, right) => left.keys[0].localeCompare(right.keys[0]))) {
      const routingEpoch = history.epochNumber === null
        ? null
        : this.routingEpochDirectories.get(epochStorageKey(history.ledgerDirectory, history.epochNumber));
      if (history.epochNumber !== null && routingEpoch === undefined) {
        throw new G9pError("LEDGER_ROUTING_EPOCH", `Segment storage prefix for epoch ${history.epochNumber} has no matching signed routing epoch`);
      }
      const ledgerId = await this.#loadShardHistory({ ...history, routingEpoch });
      if (ledgerId !== undefined) historicalLedgers.add(ledgerId);
    }
    for (const ledgerId of historicalLedgers) {
      if (!this.routingEpochs.has(ledgerId) && !this.adoptLegacyRoutingHistory) {
        throw new G9pError(
          "LEDGER_ROUTING_HISTORY_MISSING",
          `Ledger ${ledgerId} has version 1 segment history but no signed routing epoch; enable explicit legacy routing adoption for one reviewed migration startup`,
        );
      }
      await this.#ensureGenesisRoutingEpoch(ledgerId, "Adopt existing G9P format version 1 history as routing epoch zero");
    }
    this.#verifyTransitionHeads();
    await this.#loadCheckpoints();
    await this.#loadDurableIntake();
    await this.#loadActiveSegments();
    await this.#drainAccepted();
    this.#startAgeTimer();
    return this;
  }

  async #loadDurableIntake() {
    for (const record of await this.intake.initialize()) {
      const existing = this.eventIndex.get(record.event.eventId);
      if (existing !== undefined) {
        if (existing.recordHash !== record.recordHash) {
          throw new G9pError("EVENT_ID_CONFLICT", `Durable intake event ID ${record.event.eventId} conflicts with sealed history`);
        }
        await this.intake.remove(record);
        continue;
      }
      const pending = this.pendingIndex.get(record.event.eventId);
      if (pending !== undefined) {
        if (pending.recordHash !== record.recordHash) {
          throw new G9pError("EVENT_ID_CONFLICT", `Durable intake contains conflicting content for event ID ${record.event.eventId}`);
        }
        throw new G9pError("INTAKE_DUPLICATE", `Durable intake contains duplicate records for event ID ${record.event.eventId}`);
      }
      record.eventBytes = canonicalEventBytes(record.event).byteLength;
      this.pendingIndex.set(record.event.eventId, record);
      this.pendingBytes += record.eventBytes;
    }
  }

  async #loadActiveSegments() {
    for (const stored of await this.activeStore.initialize()) {
      const key = stateKey(stored.ledgerId, stored.epochNumber, stored.shardId);
      if (this.activeSegments.has(key)) {
        throw new G9pError("ACTIVE_STATE_DUPLICATE", `More than one active segment exists for ${stored.ledgerId} epoch ${stored.epochNumber} ${stored.shardId}`);
      }
      const routingEpoch = this.routingEpochs.get(stored.ledgerId);
      const state = this.shardStates.get(key);
      const references = stored.blocks.flatMap((block) => block.records);
      const allReferencesSealed = references.every((reference) => {
        const sealed = this.eventIndex.get(reference.eventId);
        return sealed !== undefined && sealed.recordHash === reference.recordHash;
      });
      if (allReferencesSealed) {
        await this.activeStore.remove(stored);
        continue;
      }
      const expectedFormat = this.ledgerSegmentFormats.get(ledgerEpochKey(stored.ledgerId, stored.epochNumber)) ?? 2;
      const expectedSegmentNumber = state?.nextSegmentNumber ?? 0;
      const expectedPrevious = state?.previousSegmentHash ?? null;
      const previousMatches = stored.previousSegmentHash === null
        ? expectedPrevious === null
        : expectedPrevious !== null && Buffer.from(stored.previousSegmentHash).equals(Buffer.from(expectedPrevious));
      if (routingEpoch?.epochNumber !== stored.epochNumber
        || stored.ledgerDirectory !== ledgerDirectoryName(stored.ledgerId)
        || stored.segmentNumber !== expectedSegmentNumber
        || stored.formatVersion !== expectedFormat
        || !previousMatches) {
        throw new G9pError("ACTIVE_STATE_POSITION", `Active segment state for ${stored.ledgerId} does not match verified ledger history`);
      }

      const seen = new Set();
      const blocks = [];
      let recordCount = 0;
      let byteCount = 0;
      let allSealed = true;
      for (const block of stored.blocks) {
        const records = [];
        for (const reference of block.records) {
          if (seen.has(reference.eventId) || this.assignedPendingIds.has(reference.eventId)) {
            throw new G9pError("ACTIVE_STATE_DUPLICATE", `Event ${reference.eventId} appears more than once in provisional state`);
          }
          seen.add(reference.eventId);
          const pending = this.pendingIndex.get(reference.eventId);
          if (pending === undefined) {
            const sealed = this.eventIndex.get(reference.eventId);
            if (sealed === undefined || sealed.recordHash !== reference.recordHash) {
              throw new G9pError("ACTIVE_STATE_RECORD", `Provisional event ${reference.eventId} has no matching durable intake or sealed record`);
            }
            continue;
          }
          allSealed = false;
          if (pending.recordHash !== reference.recordHash) {
            throw new G9pError("ACTIVE_STATE_RECORD", `Provisional event ${reference.eventId} conflicts with durable intake`);
          }
          const route = routeEvent(pending.event, routingEpoch.routingPolicy);
          if (route.shardId !== stored.shardId) {
            throw new G9pError("ACTIVE_STATE_SHARD", `Provisional event ${reference.eventId} no longer routes to its recorded shard`);
          }
          records.push(pending);
          this.assignedPendingIds.add(reference.eventId);
          byteCount += pending.eventBytes + 4;
          recordCount += 1;
        }
        if (records.length > 0) {
          const uncompressed = Buffer.concat(records.map((pending) => framedEventBytes(pending.event)));
          if (block.uncompressedLength !== uncompressed.byteLength
            || block.uncompressedLength > this.lifecycle.maxActiveBlockBytes
            || !Buffer.from(block.recordsHash).equals(Buffer.from(domainHash("record-block-v1", uncompressed)))) {
            throw new G9pError("ACTIVE_STATE_BLOCK", `Provisional block ${block.blockIndex} commitments do not match durable intake`);
          }
          const recovered = decompressBlock(block.data, block.uncompressedLength, block.uncompressedLength);
          if (!Buffer.from(recovered).equals(uncompressed)) {
            throw new G9pError("ACTIVE_STATE_BLOCK", `Provisional block ${block.blockIndex} compressed bytes do not match durable intake`);
          }
          blocks.push({
            records,
            uncompressedLength: block.uncompressedLength,
            recordsHash: Uint8Array.from(block.recordsHash),
            data: Uint8Array.from(block.data),
          });
        }
      }
      if (allSealed) {
        await this.activeStore.remove(stored);
        continue;
      }
      if (recordCount === 0 || blocks.length !== stored.blocks.length) {
        throw new G9pError("ACTIVE_STATE_RECORD", "Active segment state mixes sealed and unsealed records");
      }
      const active = {
        key,
        ledgerId: stored.ledgerId,
        shardId: stored.shardId,
        epochNumber: stored.epochNumber,
        formatVersion: stored.formatVersion,
        directory: state?.directory ?? this.#segmentPrefix(stored.ledgerId, stored.epochNumber, stored.shardId, stored.formatVersion),
        segmentNumber: stored.segmentNumber,
        previousSegmentHash: expectedPrevious,
        openedAt: stored.openedAt,
        blocks,
        activeBlock: [],
        activeBlockBytes: 0,
        recordCount,
        byteCount,
        statePath: stored.path,
      };
      this.activeSegments.set(key, active);
      this.#rebuildProvisionalReceipts(active);
    }
  }

  async #loadShardHistory({ ledgerDirectory, shardId, keys, routingEpoch }) {
    let previousSegmentHash = null;
    let ledgerId;
    let expectedSegmentNumber = 0;
    const formatVersion = routingEpoch === null ? 1 : 2;
    const storagePrefix = keys[0].slice(0, keys[0].lastIndexOf("/"));

    for (const key of [...keys].sort()) {
      const fileName = key.slice(key.lastIndexOf("/") + 1);
      const verified = await verifySegmentBytes(await this.sealedStorage.read(key), {
        source: key,
        trustedKeyIds: new Set([this.signer.keyId]),
        requireTrustedSigner: true,
        expectedPreviousSegmentHash: previousSegmentHash,
        expectedShardId: shardId,
        ...(routingEpoch === null ? {} : {
          expectedRoutingEpochNumber: routingEpoch.epochNumber,
          expectedRoutingEpochHash: fromHex(routingEpoch.epochHash, 32),
        }),
      });
      if (verified.formatVersion !== formatVersion) {
        throw new G9pError("LEDGER_SEGMENT_FORMAT", `Segment ${key} uses format version ${verified.formatVersion} but its storage key requires version ${formatVersion}`);
      }
      if (verified.segmentNumber !== expectedSegmentNumber) {
        throw new G9pError("LEDGER_SEGMENT_SEQUENCE", `Expected segment ${expectedSegmentNumber} in ${storagePrefix} but found ${verified.segmentNumber}`);
      }
      ledgerId ??= verified.ledgerId;
      if (verified.ledgerId !== ledgerId || ledgerDirectoryName(verified.ledgerId) !== ledgerDirectory) {
        throw new G9pError("LEDGER_DIRECTORY", `Segment ${key} is stored under the wrong ledger storage prefix`);
      }
      const epochNumber = routingEpoch?.epochNumber ?? 0;
      const signedEpoch = routingEpoch
        ?? this.routingEpochDirectories.get(epochStorageKey(ledgerDirectory, 0));
      const expectedPolicy = signedEpoch?.routingPolicy ?? this.defaultRoutingPolicy;
      if (!routingPoliciesEqual(verified.routingPolicy, expectedPolicy)) {
        throw new G9pError(
          "LEDGER_ROUTING_POLICY",
          `Ledger ${verified.ledgerId} epoch ${epochNumber} history does not match its signed routing policy`,
        );
      }
      this.#recordLedgerSegmentFormat(verified.ledgerId, epochNumber, formatVersion);

      verified.events.forEach((event, recordIndex) => {
        const recordHash = eventHashHex(event);
        const existing = this.eventIndex.get(event.eventId);
        if (existing !== undefined && existing.recordHash !== recordHash) {
          throw new G9pError("EVENT_ID_CONFLICT", `Event ID ${event.eventId} has conflicting historical content`);
        }
        this.eventIndex.set(event.eventId, {
          eventId: event.eventId,
          status: "sealed",
          ledgerId: event.ledgerId,
          shardId,
          routingEpochNumber: epochNumber,
          segmentNumber: verified.segmentNumber,
          recordIndex,
          recordHash,
          segmentHash: verified.segmentHash,
          signerKeyId: verified.signerKeyId,
        });
      });

      previousSegmentHash = fromHex(verified.segmentHash, 32);
      expectedSegmentNumber += 1;
    }

    if (ledgerId !== undefined) {
      const epochNumber = routingEpoch?.epochNumber ?? 0;
      this.shardStates.set(stateKey(ledgerId, epochNumber, shardId), {
        ledgerId,
        shardId,
        epochNumber,
        formatVersion,
        directory: storagePrefix,
        nextSegmentNumber: expectedSegmentNumber,
        previousSegmentHash,
      });
    }
    return ledgerId;
  }

  #recordLedgerSegmentFormat(ledgerId, epochNumber, formatVersion) {
    const key = ledgerEpochKey(ledgerId, epochNumber);
    const existing = this.ledgerSegmentFormats.get(key);
    if (existing !== undefined && existing !== formatVersion) {
      throw new G9pError("LEDGER_SEGMENT_FORMAT", `Ledger ${ledgerId} epoch ${epochNumber} contains mixed segment formats`);
    }
    this.ledgerSegmentFormats.set(key, formatVersion);
  }

  #verifyTransitionHeads() {
    for (const [ledgerId, history] of this.routingHistory) {
      for (let epochNumber = 1; epochNumber < history.length; epochNumber += 1) {
        const descriptor = history[epochNumber];
        for (const head of descriptor.previousShardHeads) {
          const state = this.shardStates.get(stateKey(ledgerId, epochNumber - 1, head.shardId));
          const expectedSegmentNumber = state === undefined ? null : state.nextSegmentNumber - 1;
          const expectedSegmentHash = state?.previousSegmentHash ?? null;
          if (head.segmentNumber !== expectedSegmentNumber) {
            throw new G9pError("LEDGER_TRANSITION_HEAD", `Routing epoch ${epochNumber} records the wrong final segment for ${head.shardId}`);
          }
          const hashesMatch = head.segmentHash === null
            ? expectedSegmentHash === null
            : expectedSegmentHash !== null && Buffer.from(head.segmentHash, "hex").equals(Buffer.from(expectedSegmentHash));
          if (!hashesMatch) {
            throw new G9pError("LEDGER_TRANSITION_HEAD", `Routing epoch ${epochNumber} records the wrong final hash for ${head.shardId}`);
          }
        }
      }
    }
  }

  async #loadCheckpoints() {
    const ledgers = new Map();
    for (const key of await this.sealedStorage.list("checkpoints/")) {
      const match = /^checkpoints\/([0-9a-f]{64})\/(checkpoint-[0-9]{12}\.g9p)$/u.exec(key);
      if (match === null) throw new G9pError("LEDGER_CHECKPOINT_FILE", `Unexpected sealed checkpoint storage key ${key}`);
      const keys = ledgers.get(match[1]) ?? [];
      keys.push(key);
      ledgers.set(match[1], keys);
    }
    for (const [ledgerDirectory, keys] of [...ledgers.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      let previousCheckpointHash = null;
      let ledgerId;
      for (let checkpointNumber = 0; checkpointNumber < keys.length; checkpointNumber += 1) {
        const key = [...keys].sort()[checkpointNumber];
        if (key !== `checkpoints/${ledgerDirectory}/${checkpointFileName(checkpointNumber)}`) {
          throw new G9pError("CHECKPOINT_SEQUENCE", `Checkpoint storage for ${ledgerDirectory} is not contiguous`);
        }
        const verified = await verifyCheckpointBytes(await this.sealedStorage.read(key), {
          trustedKeyIds: [this.checkpointPublisher.keyId],
          requireTrustedSigner: true,
        });
        ledgerId ??= verified.ledgerId;
        if (verified.ledgerId !== ledgerId || ledgerDirectoryName(verified.ledgerId) !== ledgerDirectory
          || verified.checkpointNumber !== checkpointNumber || verified.previousCheckpointHash !== previousCheckpointHash) {
          throw new G9pError("CHECKPOINT_SEQUENCE", `Checkpoint ${key} does not continue its ledger checkpoint chain`);
        }
        const routingEpoch = this.routingEpochDirectories.get(epochStorageKey(ledgerDirectory, verified.routingEpochNumber));
        if (routingEpoch === undefined || routingEpoch.epochHash !== verified.routingEpochHash
          || routingEpoch.routingPolicy.shardCount !== verified.shardHeads.length) {
          throw new G9pError("CHECKPOINT_ROUTING", `Checkpoint ${key} does not match verified routing history`);
        }
        for (const head of verified.shardHeads) {
          if (head.segmentNumber === null) continue;
          const segmentKey = `segments/${ledgerDirectory}/${epochDirectoryName(head.epochNumber)}/${head.shardId}/${segmentFileName(head.segmentNumber)}`;
          const segment = await verifySegmentBytes(await this.sealedStorage.read(segmentKey), {
            trustedKeyIds: new Set([this.signer.keyId]),
            requireTrustedSigner: true,
            expectedLedgerId: ledgerId,
            expectedShardId: head.shardId,
            expectedRoutingEpochNumber: head.epochNumber,
            expectedRoutingEpochHash: fromHex(verified.routingEpochHash, 32),
            includeEvents: false,
          });
          if (segment.segmentNumber !== head.segmentNumber || segment.segmentHash !== head.segmentHash) {
            throw new G9pError("CHECKPOINT_HEAD", `Checkpoint ${key} references the wrong segment commitment for ${head.shardId}`);
          }
        }
        previousCheckpointHash = verified.checkpointHash;
      }
    }
  }

  async #loadRoutingEpochs() {
    const ledgers = new Map();
    for (const key of await this.sealedStorage.list("routing/")) {
      const match = /^routing\/([0-9a-f]{64})\/(epoch-[0-9]{12}\.g9p)$/u.exec(key);
      if (match === null) {
        throw new G9pError("LEDGER_ROUTING_FILE", `Unexpected sealed routing storage key ${key}`);
      }
      const keys = ledgers.get(match[1]) ?? [];
      keys.push(key);
      ledgers.set(match[1], keys);
    }
    for (const [ledgerDirectory, keys] of [...ledgers.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const sortedKeys = [...keys].sort();
      let previousEpochHash = null;
      let previousRoutingPolicy;
      let ledgerId;
      let activeEpoch;

      for (let epochNumber = 0; epochNumber < sortedKeys.length; epochNumber += 1) {
        const expectedName = routingEpochFileName(epochNumber);
        const key = sortedKeys[epochNumber];
        const fileName = key.slice(key.lastIndexOf("/") + 1);
        if (fileName !== expectedName) {
          throw new G9pError("LEDGER_ROUTING_SEQUENCE", `Expected ${expectedName} in routing storage but found ${fileName}`);
        }
        const verified = await verifyRoutingEpochBytes(await this.sealedStorage.read(key), {
          source: key,
          trustedKeyIds: new Set([this.topologyAuthority.keyId]),
          requireTrustedAuthority: true,
          expectedEpochNumber: epochNumber,
          expectedPreviousEpochHash: previousEpochHash,
          ...(previousRoutingPolicy === undefined ? {} : { expectedPreviousRoutingPolicy: previousRoutingPolicy }),
        });
        ledgerId ??= verified.ledgerId;
        if (verified.ledgerId !== ledgerId || ledgerDirectoryName(verified.ledgerId) !== ledgerDirectory) {
          throw new G9pError("LEDGER_ROUTING_DIRECTORY", `Routing epoch ${key} is stored under the wrong ledger storage prefix`);
        }
        previousEpochHash = fromHex(verified.epochHash, 32);
        previousRoutingPolicy = verified.routingPolicy;
        activeEpoch = verified;
        this.routingEpochDirectories.set(epochStorageKey(ledgerDirectory, epochNumber), verified);
      }

      if (activeEpoch === undefined) continue;
      if (activeEpoch.epochNumber === 0 && !routingPoliciesEqual(activeEpoch.routingPolicy, this.defaultRoutingPolicy)) {
        throw new G9pError(
          "LEDGER_ROUTING_POLICY",
          `Ledger ${ledgerId} signed routing history uses ${activeEpoch.routingPolicy.shardCount} shards, but the service is configured for ${this.defaultRoutingPolicy.shardCount} shards`,
        );
      }
      this.routingEpochs.set(ledgerId, activeEpoch);
      this.routingHistory.set(ledgerId, sortedKeys.map((_, index) => this.routingEpochDirectories.get(epochStorageKey(ledgerDirectory, index))));
    }
  }

  async #ensureGenesisRoutingEpoch(ledgerId, reason = "Create initial routing epoch") {
    const existing = this.routingEpochs.get(ledgerId);
    if (existing !== undefined) return existing;

    const storageKey = `routing/${ledgerDirectoryName(ledgerId)}/${routingEpochFileName(0)}`;
    await writeRoutingEpoch({
      sealedStorage: this.sealedStorage,
      storageKey,
      ledgerId,
      epochNumber: 0,
      routingPolicy: this.defaultRoutingPolicy,
      topologyAuthority: this.topologyAuthority,
      reason,
      testFaultInjector: this.testFaultInjector,
    });
    const verified = await verifyRoutingEpochBytes(await this.sealedStorage.read(storageKey), {
      source: storageKey,
      trustedKeyIds: new Set([this.topologyAuthority.keyId]),
      requireTrustedAuthority: true,
      expectedLedgerId: ledgerId,
      expectedEpochNumber: 0,
      expectedPreviousEpochHash: null,
    });
    this.routingEpochs.set(ledgerId, verified);
    this.routingEpochDirectories.set(epochStorageKey(ledgerDirectoryName(ledgerId), 0), verified);
    this.routingHistory.set(ledgerId, [verified]);
    return verified;
  }

  #serialize(action) {
    const operation = this.operationTail.then(action);
    this.operationTail = operation.catch(() => {});
    return operation;
  }

  acceptBatch(events) {
    return this.#serialize(() => this.#acceptBatch(events));
  }

  drainAccepted() {
    return this.#serialize(() => this.#drainAccepted({ forceSeal: true }));
  }

  transitionRouting(options) {
    return this.#serialize(() => this.#transitionRouting(options));
  }

  publishCheckpoint(options) {
    return this.#serialize(() => this.#publishCheckpoint(options));
  }

  ingestBatch(events) {
    return this.#serialize(async () => {
      const accepted = await this.#acceptBatch(events);
      await this.#drainAccepted({ forceSeal: true });
      return accepted.map((receipt) => this.eventIndex.get(receipt.eventId) ?? receipt);
    });
  }

  ingestAcceptedBatch(events) {
    return this.#serialize(async () => {
      const accepted = await this.#acceptBatch(events);
      await this.#drainAccepted({ forceSeal: false });
      return accepted.map((receipt) => this.eventIndex.get(receipt.eventId)
        ?? this.provisionalIndex.get(receipt.eventId)
        ?? receipt);
    });
  }

  receipt(eventId, recordHash) {
    return this.#serialize(() => {
      if (typeof eventId !== "string" || eventId.length === 0) {
        throw new G9pError("RECEIPT_EVENT_ID", "Receipt lookup requires a non-empty event ID");
      }
      if (typeof recordHash !== "string" || !/^[0-9a-f]{64}$/u.test(recordHash)) {
        throw new G9pError("RECEIPT_RECORD_HASH", "Receipt lookup requires the expected 64-character lowercase record hash");
      }
      const receipt = this.eventIndex.get(eventId)
        ?? this.provisionalIndex.get(eventId)
        ?? (this.pendingIndex.has(eventId) ? this.#acceptedReceipt(this.pendingIndex.get(eventId)) : undefined);
      if (receipt === undefined) {
        throw new G9pError("RECEIPT_NOT_FOUND", `No receipt exists for event ${eventId}`);
      }
      if (receipt.recordHash !== recordHash) {
        throw new G9pError("EVENT_ID_CONFLICT", `Event ID ${eventId} identifies different ledger content`);
      }
      return receipt;
    });
  }

  sealExpired(now = Date.now()) {
    return this.#serialize(() => this.#sealExpired(now));
  }

  close({ seal = true } = {}) {
    if (this.ageTimer !== undefined) clearInterval(this.ageTimer);
    this.ageTimer = undefined;
    return seal ? this.#serialize(() => this.#drainAccepted({ forceSeal: true })) : this.operationTail;
  }

  async #acceptBatch(events) {
    const validatedEvents = events.map((event) => {
      validateEvent(event);
      return event;
    });
    const prepared = validatedEvents.map((event) => {
      return { event, recordHash: eventHashHex(event), eventBytes: canonicalEventBytes(event).byteLength };
    });

    const requestIds = new Map();
    for (const item of prepared) {
      const requestHash = requestIds.get(item.event.eventId);
      if (requestHash !== undefined && requestHash !== item.recordHash) {
        throw new G9pError("EVENT_ID_CONFLICT", `Event ID ${item.event.eventId} is reused with different content in one request`);
      }
      requestIds.set(item.event.eventId, item.recordHash);

      const existing = this.eventIndex.get(item.event.eventId);
      if (existing !== undefined && existing.recordHash !== item.recordHash) {
        throw new G9pError("EVENT_ID_CONFLICT", `Event ID ${item.event.eventId} already identifies different ledger content`);
      }
      const pending = this.pendingIndex.get(item.event.eventId);
      if (pending !== undefined && pending.recordHash !== item.recordHash) {
        throw new G9pError("EVENT_ID_CONFLICT", `Event ID ${item.event.eventId} already identifies different accepted content`);
      }
    }

    const newItems = prepared.filter((item, index) => prepared.findIndex((candidate) => candidate.event.eventId === item.event.eventId) === index
      && !this.eventIndex.has(item.event.eventId)
      && !this.pendingIndex.has(item.event.eventId));
    if (newItems.some((item) => item.eventBytes + 4 > this.lifecycle.maxActiveBlockBytes)) {
      throw new G9pError("LEDGER_BACKPRESSURE", "An event exceeds the configured active-block memory capacity");
    }
    const nextAcceptedEvents = this.pendingIndex.size + newItems.length;
    const nextAcceptedBytes = this.pendingBytes + newItems.reduce((total, item) => total + item.eventBytes, 0);
    if (nextAcceptedEvents > this.lifecycle.maxAcceptedEvents || nextAcceptedBytes > this.lifecycle.maxAcceptedBytes) {
      throw new G9pError("LEDGER_BACKPRESSURE", "Ledger durable-intake capacity has been reached; retry after retained events are sealed");
    }

    const receipts = [];
    const acceptedThisRequest = new Map();
    for (const item of prepared) {
      const sealed = this.eventIndex.get(item.event.eventId);
      if (sealed !== undefined) {
        receipts.push(sealed);
        continue;
      }
      let pending = this.pendingIndex.get(item.event.eventId) ?? acceptedThisRequest.get(item.event.eventId);
      if (pending === undefined) {
        pending = await this.intake.append(item.event);
        pending.eventBytes = item.eventBytes;
        this.pendingIndex.set(item.event.eventId, pending);
        this.pendingBytes += item.eventBytes;
        acceptedThisRequest.set(item.event.eventId, pending);
      }
      receipts.push(this.#acceptedReceipt(pending));
    }
    return receipts;
  }

  #acceptedReceipt(pending) {
    return {
      eventId: pending.event.eventId,
      status: "accepted",
      ledgerId: pending.event.ledgerId,
      recordHash: pending.recordHash,
      intakeSequence: pending.sequence,
      acceptedAt: pending.acceptedAt,
    };
  }

  #segmentPrefix(ledgerId, epochNumber, shardId, formatVersion) {
    return formatVersion === 1
      ? `segments/${ledgerDirectoryName(ledgerId)}/${shardId}`
      : `segments/${ledgerDirectoryName(ledgerId)}/${epochDirectoryName(epochNumber)}/${shardId}`;
  }

  #activeState(active) {
    return {
      kind: "g9p-active-segment",
      version: 1,
      ledgerDirectory: ledgerDirectoryName(active.ledgerId),
      ledgerId: active.ledgerId,
      epochNumber: active.epochNumber,
      shardId: active.shardId,
      segmentNumber: active.segmentNumber,
      formatVersion: active.formatVersion,
      openedAt: active.openedAt,
      previousSegmentHash: active.previousSegmentHash === null ? null : Uint8Array.from(active.previousSegmentHash),
      blocks: active.blocks.map((block, blockIndex) => ({
        blockIndex,
        records: block.records.map((pending) => ({ eventId: pending.event.eventId, recordHash: pending.recordHash })),
        uncompressedLength: block.uncompressedLength,
        recordsHash: Uint8Array.from(block.recordsHash),
        data: Uint8Array.from(block.data),
      })),
    };
  }

  #rebuildProvisionalReceipts(active) {
    let recordIndex = 0;
    active.blocks.forEach((block, blockIndex) => {
      for (const pending of block.records) {
        this.provisionalIndex.set(pending.event.eventId, {
          eventId: pending.event.eventId,
          status: "provisional",
          ledgerId: active.ledgerId,
          shardId: active.shardId,
          routingEpochNumber: active.epochNumber,
          segmentNumber: active.segmentNumber,
          blockIndex,
          recordIndex,
          recordHash: pending.recordHash,
          intakeSequence: pending.sequence,
          acceptedAt: pending.acceptedAt,
          openedAt: active.openedAt,
        });
        recordIndex += 1;
      }
    });
  }

  #activeSegmentFor(item, routingEpoch) {
    const key = stateKey(item.event.ledgerId, routingEpoch.epochNumber, item.route.shardId);
    let active = this.activeSegments.get(key);
    if (active !== undefined) return active;
    const shardState = this.shardStates.get(key);
    const formatVersion = this.ledgerSegmentFormats.get(ledgerEpochKey(item.event.ledgerId, routingEpoch.epochNumber)) ?? 2;
    active = {
      key,
      ledgerId: item.event.ledgerId,
      shardId: item.route.shardId,
      epochNumber: routingEpoch.epochNumber,
      formatVersion,
      directory: shardState?.directory ?? this.#segmentPrefix(item.event.ledgerId, routingEpoch.epochNumber, item.route.shardId, formatVersion),
      segmentNumber: shardState?.nextSegmentNumber ?? 0,
      previousSegmentHash: shardState?.previousSegmentHash ?? null,
      openedAt: new Date().toISOString(),
      blocks: [],
      activeBlock: [],
      activeBlockBytes: 0,
      recordCount: 0,
      byteCount: 0,
      statePath: undefined,
    };
    this.activeSegments.set(key, active);
    return active;
  }

  async #completeActiveBlock(active) {
    if (active.activeBlock.length === 0) return;
    const completed = active.activeBlock;
    const uncompressed = Buffer.concat(completed.map((pending) => framedEventBytes(pending.event)));
    const blockIndex = active.blocks.length;
    this.testFaultInjector?.("segment.before-compression", { blockIndex, uncompressedLength: uncompressed.byteLength });
    const compressed = compressBlock(uncompressed);
    this.testFaultInjector?.("segment.after-compression", { blockIndex, compressedLength: compressed.byteLength });
    active.blocks.push({
      records: completed,
      uncompressedLength: uncompressed.byteLength,
      recordsHash: Uint8Array.from(domainHash("record-block-v1", uncompressed)),
      data: Uint8Array.from(compressed),
    });
    active.activeBlock = [];
    this.activeBlockBytes -= active.activeBlockBytes;
    active.activeBlockBytes = 0;
    const state = this.#activeState(active);
    active.statePath = await this.activeStore.persist(state);
    this.#rebuildProvisionalReceipts(active);
  }

  async #makeActiveMemoryRoom(requiredBytes, exceptKey) {
    while (this.activeBlockBytes + requiredBytes > this.lifecycle.maxActiveBlockBytes) {
      const candidate = [...this.activeSegments.values()]
        .filter((active) => active.key !== exceptKey && active.activeBlock.length > 0)
        .sort((left, right) => right.activeBlockBytes - left.activeBlockBytes)[0];
      if (candidate === undefined) break;
      await this.#completeActiveBlock(candidate);
    }
    if (this.activeBlockBytes + requiredBytes > this.lifecycle.maxActiveBlockBytes) {
      throw new G9pError("LEDGER_BACKPRESSURE", "Ledger active-block memory capacity has been reached");
    }
  }

  async #appendToActive(item, routingEpoch) {
    let active = this.#activeSegmentFor(item, routingEpoch);
    const recordBytes = item.pending.eventBytes + 4;
    const segmentWouldOverflow = active.recordCount > 0
      && (active.recordCount + 1 > this.lifecycle.segmentMaxRecords
        || active.byteCount + recordBytes > this.lifecycle.segmentMaxBytes);
    if (segmentWouldOverflow) {
      await this.#sealActiveSegment(active);
      active = this.#activeSegmentFor(item, routingEpoch);
    }
    const blockWouldOverflow = active.activeBlock.length > 0
      && (active.activeBlock.length + 1 > this.lifecycle.blockMaxRecords
        || active.activeBlockBytes + recordBytes > this.lifecycle.blockMaxBytes);
    if (blockWouldOverflow) await this.#completeActiveBlock(active);
    await this.#makeActiveMemoryRoom(recordBytes, active.key);
    active.activeBlock.push(item.pending);
    active.activeBlockBytes += recordBytes;
    active.recordCount += 1;
    active.byteCount += recordBytes;
    this.activeBlockBytes += recordBytes;
    this.assignedPendingIds.add(item.event.eventId);
    this.testFaultInjector?.("active.after-append", {
      ledgerId: active.ledgerId,
      epochNumber: active.epochNumber,
      shardId: active.shardId,
      activeBlockBytes: active.activeBlockBytes,
      aggregateActiveBlockBytes: this.activeBlockBytes,
    });

    if (active.activeBlock.length >= this.lifecycle.blockMaxRecords
      || active.activeBlockBytes >= this.lifecycle.blockMaxBytes) {
      await this.#completeActiveBlock(active);
    }
    if (active.recordCount >= this.lifecycle.segmentMaxRecords
      || active.byteCount >= this.lifecycle.segmentMaxBytes) {
      await this.#sealActiveSegment(active);
    }
  }

  async #sealActiveSegment(active) {
    await this.#completeActiveBlock(active);
    if (active.blocks.length === 0) return;
    const routingEpoch = this.routingEpochs.get(active.ledgerId);
    const records = active.blocks.flatMap((block) => block.records);
    const storageKey = `${active.directory}/${segmentFileName(active.segmentNumber)}`;
    const result = await writeSegment({
      sealedStorage: this.sealedStorage,
      storageKey,
      events: records.map((pending) => pending.event),
      routingPolicy: routingEpoch.routingPolicy,
      segmentNumber: active.segmentNumber,
      previousSegmentHash: active.previousSegmentHash,
      routingEpoch: active.formatVersion === 1 ? null : {
        epochNumber: routingEpoch.epochNumber,
        epochHash: fromHex(routingEpoch.epochHash, 32),
      },
      signer: this.signer,
      createdAt: active.openedAt,
      blockTargetBytes: this.lifecycle.blockMaxBytes,
      blockMaxRecords: this.lifecycle.blockMaxRecords,
      blockRecordCounts: active.blocks.map((block) => block.records.length),
      precompressedBlocks: active.blocks.map((block) => ({
        uncompressedLength: block.uncompressedLength,
        recordsHash: block.recordsHash,
        data: block.data,
      })),
      testFaultInjector: this.testFaultInjector,
    });
    this.#recordLedgerSegmentFormat(active.ledgerId, active.epochNumber, active.formatVersion);

    records.forEach((pending, recordIndex) => {
      this.eventIndex.set(pending.event.eventId, {
        eventId: pending.event.eventId,
        status: "sealed",
        ledgerId: active.ledgerId,
        shardId: active.shardId,
        routingEpochNumber: active.epochNumber,
        segmentNumber: active.segmentNumber,
        recordIndex,
        recordHash: pending.recordHash,
        segmentHash: result.segmentHash,
        signerKeyId: result.signerKeyId,
      });
    });
    this.shardStates.set(active.key, {
      ledgerId: active.ledgerId,
      shardId: active.shardId,
      epochNumber: active.epochNumber,
      formatVersion: active.formatVersion,
      directory: active.directory,
      nextSegmentNumber: active.segmentNumber + 1,
      previousSegmentHash: fromHex(result.segmentHash, 32),
    });
    await this.activeStore.remove({ ...this.#activeState(active), path: active.statePath });
    this.activeSegments.delete(active.key);
    for (const pending of records) {
      this.provisionalIndex.delete(pending.event.eventId);
      this.assignedPendingIds.delete(pending.event.eventId);
      await this.intake.remove(pending);
      this.pendingIndex.delete(pending.event.eventId);
      this.pendingBytes -= pending.eventBytes;
    }
  }

  async #sealExpired(now) {
    if (!Number.isFinite(now)) throw new G9pError("LEDGER_TIME", "Expiry time must be a finite millisecond value");
    for (const active of [...this.activeSegments.values()]) {
      if (now - new Date(active.openedAt).valueOf() >= this.lifecycle.segmentMaxAgeMs) {
        await this.#sealActiveSegment(active);
      }
    }
  }

  #startAgeTimer() {
    const interval = Math.max(100, Math.min(1_000, Math.floor(this.lifecycle.segmentMaxAgeMs / 4)));
    this.ageTimer = setInterval(() => {
      this.sealExpired().catch((error) => {
        this.backgroundError = error;
      });
    }, interval);
    this.ageTimer.unref?.();
  }

  async #drainAccepted({ forceSeal = true } = {}) {
    for (const pending of [...this.pendingIndex.values()].sort((left, right) => left.sequence - right.sequence)) {
      const sealed = this.eventIndex.get(pending.event.eventId);
      if (sealed === undefined) continue;
      if (sealed.recordHash !== pending.recordHash) {
        throw new G9pError("EVENT_ID_CONFLICT", `Accepted event ID ${pending.event.eventId} conflicts with sealed history`);
      }
      await this.intake.remove(pending);
      this.pendingIndex.delete(pending.event.eventId);
      this.pendingBytes -= pending.eventBytes;
    }

    const pendingRecords = [...this.pendingIndex.values()].sort((left, right) => left.sequence - right.sequence);
    for (const ledgerId of new Set(pendingRecords.map((record) => record.event.ledgerId))) {
      await this.#ensureGenesisRoutingEpoch(ledgerId);
    }
    const uniqueNew = pendingRecords.filter((pending) => !this.assignedPendingIds.has(pending.event.eventId)).map((pending) => {
      const routingEpoch = this.routingEpochs.get(pending.event.ledgerId);
      return {
        event: pending.event,
        route: routeEvent(pending.event, routingEpoch.routingPolicy),
        recordHash: pending.recordHash,
        pending,
      };
    });

    for (const item of uniqueNew) {
      await this.#appendToActive(item, this.routingEpochs.get(item.event.ledgerId));
    }
    if (forceSeal) {
      for (const active of [...this.activeSegments.values()]) await this.#sealActiveSegment(active);
    }
  }

  async #transitionRouting({ ledgerId, shardCount, reason, expectedCurrentEpoch }) {
    let activeEpoch = this.routingEpochs.get(ledgerId);
    if (activeEpoch === undefined && [...this.pendingIndex.values()].some((record) => record.event.ledgerId === ledgerId)) {
      activeEpoch = await this.#ensureGenesisRoutingEpoch(ledgerId);
    }
    if (activeEpoch === undefined) {
      throw new G9pError("LEDGER_TRANSITION_LEDGER", `Ledger ${ledgerId} has no signed routing history to transition`);
    }
    if (!Number.isSafeInteger(expectedCurrentEpoch) || expectedCurrentEpoch < 0) {
      throw new G9pError("LEDGER_TRANSITION_EPOCH", "expectedCurrentEpoch must be a non-negative safe integer");
    }
    const routingPolicy = createRoutingPolicy(shardCount);
    if (activeEpoch.epochNumber !== expectedCurrentEpoch) {
      if (activeEpoch.epochNumber === expectedCurrentEpoch + 1 && routingPoliciesEqual(activeEpoch.routingPolicy, routingPolicy)) {
        return { ...activeEpoch, alreadyActive: true };
      }
      throw new G9pError("LEDGER_TRANSITION_EPOCH", `Ledger ${ledgerId} is at routing epoch ${activeEpoch.epochNumber}, not expected epoch ${expectedCurrentEpoch}`);
    }
    if (routingPoliciesEqual(activeEpoch.routingPolicy, routingPolicy)) {
      throw new G9pError("LEDGER_TRANSITION_POLICY", "A routing transition must change the routing policy");
    }

    // This serialized drain is the old-epoch barrier: everything accepted before
    // it is sealed under the old policy, and nothing later can enter the old epoch.
    await this.#drainAccepted();
    const previousShardHeads = [];
    for (let index = 0; index < activeEpoch.routingPolicy.shardCount; index += 1) {
      const shardId = `shard-${index.toString().padStart(4, "0")}`;
      const state = this.shardStates.get(stateKey(ledgerId, activeEpoch.epochNumber, shardId));
      previousShardHeads.push({
        epochNumber: activeEpoch.epochNumber,
        shardId,
        segmentNumber: state === undefined ? null : state.nextSegmentNumber - 1,
        segmentHash: state === undefined ? null : state.previousSegmentHash,
      });
    }

    const epochNumber = activeEpoch.epochNumber + 1;
    const ledgerDirectory = ledgerDirectoryName(ledgerId);
    const storageKey = `routing/${ledgerDirectory}/${routingEpochFileName(epochNumber)}`;
    await writeRoutingEpoch({
      sealedStorage: this.sealedStorage,
      storageKey,
      ledgerId,
      epochNumber,
      routingPolicy,
      topologyAuthority: this.topologyAuthority,
      reason,
      previousEpochHash: fromHex(activeEpoch.epochHash, 32),
      previousShardHeads,
      previousRoutingPolicy: activeEpoch.routingPolicy,
      testFaultInjector: this.testFaultInjector,
    });
    const verified = await verifyRoutingEpochBytes(await this.sealedStorage.read(storageKey), {
      source: storageKey,
      trustedKeyIds: new Set([this.topologyAuthority.keyId]),
      requireTrustedAuthority: true,
      expectedLedgerId: ledgerId,
      expectedEpochNumber: epochNumber,
      expectedPreviousEpochHash: fromHex(activeEpoch.epochHash, 32),
      expectedPreviousRoutingPolicy: activeEpoch.routingPolicy,
    });
    this.routingEpochs.set(ledgerId, verified);
    this.routingEpochDirectories.set(epochStorageKey(ledgerDirectory, epochNumber), verified);
    this.routingHistory.set(ledgerId, [...(this.routingHistory.get(ledgerId) ?? []), verified]);
    return { ...verified, alreadyActive: false };
  }

  async #publishCheckpoint({ ledgerId }) {
    const activeEpoch = this.routingEpochs.get(ledgerId);
    if (activeEpoch === undefined) throw new G9pError("CHECKPOINT_LEDGER", `Ledger ${ledgerId} has no signed routing history`);
    await this.#drainAccepted({ forceSeal: true });
    const ledgerDirectory = ledgerDirectoryName(ledgerId);
    const prefix = `checkpoints/${ledgerDirectory}/`;
    const existing = await this.sealedStorage.list(prefix);
    let previousCheckpointHash = null;
    for (let checkpointNumber = 0; checkpointNumber < existing.length; checkpointNumber += 1) {
      const key = existing[checkpointNumber];
      if (key !== `${prefix}${checkpointFileName(checkpointNumber)}`) throw new G9pError("CHECKPOINT_SEQUENCE", `Unexpected checkpoint storage key ${key}`);
      const verified = await verifyCheckpointBytes(await this.sealedStorage.read(key), {
        trustedKeyIds: [this.checkpointPublisher.keyId],
        requireTrustedSigner: true,
      });
      if (verified.ledgerId !== ledgerId || verified.checkpointNumber !== checkpointNumber || verified.previousCheckpointHash !== (previousCheckpointHash === null ? null : toHex(previousCheckpointHash))) {
        throw new G9pError("CHECKPOINT_SEQUENCE", `Checkpoint ${key} does not continue the ledger checkpoint chain`);
      }
      previousCheckpointHash = fromHex(verified.checkpointHash, 32);
    }
    const shardHeads = [];
    for (let index = 0; index < activeEpoch.routingPolicy.shardCount; index += 1) {
      const shardId = `shard-${index.toString().padStart(4, "0")}`;
      const state = this.shardStates.get(stateKey(ledgerId, activeEpoch.epochNumber, shardId));
      shardHeads.push({ epochNumber: activeEpoch.epochNumber, shardId, segmentNumber: state === undefined ? null : state.nextSegmentNumber - 1, segmentHash: state?.previousSegmentHash ?? null });
    }
    const checkpointNumber = existing.length;
    const storageKey = `${prefix}${checkpointFileName(checkpointNumber)}`;
    await writeCheckpoint({ sealedStorage: this.sealedStorage, storageKey, ledgerId, checkpointNumber, previousCheckpointHash, routingEpochNumber: activeEpoch.epochNumber, routingEpochHash: fromHex(activeEpoch.epochHash, 32), shardHeads, publisher: this.checkpointPublisher });
    return verifyCheckpointBytes(await this.sealedStorage.read(storageKey), { trustedKeyIds: [this.checkpointPublisher.keyId], requireTrustedSigner: true });
  }

  info() {
    return {
      formatVersion: 1,
      ingestionContractVersions: [1, 2],
      routingEpochProtocolVersion: 1,
      routingPolicy: this.defaultRoutingPolicy,
      topologyAuthorityKeyId: this.topologyAuthority.keyId,
      checkpointPublisherKeyId: this.checkpointPublisher.keyId,
      knownRoutingLedgers: this.routingEpochs.size,
      signerKeyId: this.signer.keyId,
      knownEvents: this.eventIndex.size,
      acceptedEvents: this.pendingIndex.size,
      acceptedBytes: this.pendingBytes,
      provisionalEvents: this.provisionalIndex.size,
      activeSegments: this.activeSegments.size,
      activeBlockBytes: this.activeBlockBytes,
      activeShardStreams: this.shardStates.size,
      lifecycle: this.lifecycle,
      backgroundError: this.backgroundError === null ? null : this.backgroundError.code ?? "UNEXPECTED",
    };
  }
}
