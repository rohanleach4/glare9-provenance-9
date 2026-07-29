import { mkdir, open, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

import {
  createRoutingPolicy,
  domainHash,
  eventHashHex,
  fromHex,
  G9pError,
  routeEvent,
  toHex,
  validateEvent,
  verifyRoutingEpoch,
  verifySegment,
  writeRoutingEpoch,
  writeSegment,
} from "@glare9/provenance";

import { DurableIntake } from "./durable-intake.js";

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

async function directories(path) {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function discardProvisionalFiles(path, pattern) {
  let changed = false;
  try {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (!entry.isFile() || !pattern.test(entry.name)) continue;
      await unlink(join(path, entry.name));
      changed = true;
    }
    if (changed) await syncDirectory(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function files(path) {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /^segment-[0-9]{12}\.g9p$/u.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function routingEpochFiles(path) {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    const unexpected = entries.find((entry) => entry.isFile() && entry.name.endsWith(".g9p") && !/^epoch-[0-9]{12}\.g9p$/u.test(entry.name));
    if (unexpected !== undefined) {
      throw new G9pError("LEDGER_ROUTING_FILE", `Unexpected sealed routing file ${unexpected.name} in ${path}`);
    }
    return entries
      .filter((entry) => entry.isFile() && /^epoch-[0-9]{12}\.g9p$/u.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export class LocalLedger {
  constructor({ dataDirectory, signer, topologyAuthority, shardCount = 1, adoptLegacyRoutingHistory = false }) {
    if (topologyAuthority?.algorithm !== "ed25519" || !topologyAuthority.privateKey || !(topologyAuthority.publicKeyDer instanceof Uint8Array)) {
      throw new G9pError("LEDGER_TOPOLOGY_AUTHORITY", "A local Ed25519 topology authority is required");
    }
    this.dataDirectory = dataDirectory;
    this.segmentDirectory = join(dataDirectory, "segments");
    this.routingDirectory = join(dataDirectory, "routing");
    this.intakeDirectory = join(dataDirectory, "intake");
    this.signer = signer;
    this.topologyAuthority = topologyAuthority;
    this.adoptLegacyRoutingHistory = adoptLegacyRoutingHistory;
    this.defaultRoutingPolicy = createRoutingPolicy(shardCount);
    this.routingEpochs = new Map();
    this.routingEpochDirectories = new Map();
    this.routingHistory = new Map();
    this.ledgerSegmentFormats = new Map();
    this.eventIndex = new Map();
    this.pendingIndex = new Map();
    this.shardStates = new Map();
    this.intake = new DurableIntake(this.intakeDirectory);
    this.operationTail = Promise.resolve();
  }

  async initialize() {
    await mkdir(this.segmentDirectory, { recursive: true });
    await mkdir(this.routingDirectory, { recursive: true });
    await this.#loadRoutingEpochs();
    const historicalLedgers = new Set();
    for (const ledgerDirectory of await directories(this.segmentDirectory)) {
      const ledgerPath = join(this.segmentDirectory, ledgerDirectory);
      const childDirectories = await directories(ledgerPath);
      for (const shardId of childDirectories.filter((name) => /^shard-[0-9]{4}$/u.test(name))) {
        const ledgerId = await this.#loadShardHistory({
          ledgerDirectory,
          shardId,
          shardPath: join(ledgerPath, shardId),
          routingEpoch: null,
        });
        if (ledgerId !== undefined) historicalLedgers.add(ledgerId);
      }
      for (const epochDirectory of childDirectories.filter((name) => /^epoch-[0-9]{12}$/u.test(name))) {
        const epochNumber = Number(epochDirectory.slice(6));
        const routingEpoch = this.routingEpochDirectories.get(epochStorageKey(ledgerDirectory, epochNumber));
        if (routingEpoch === undefined) {
          throw new G9pError("LEDGER_ROUTING_EPOCH", `Segment directory ${epochDirectory} has no matching signed routing epoch`);
        }
        const epochPath = join(ledgerPath, epochDirectory);
        for (const shardId of await directories(epochPath)) {
          if (!/^shard-[0-9]{4}$/u.test(shardId)) continue;
          const ledgerId = await this.#loadShardHistory({
            ledgerDirectory,
            shardId,
            shardPath: join(epochPath, shardId),
            routingEpoch,
          });
          if (ledgerId !== undefined) historicalLedgers.add(ledgerId);
        }
      }
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
    await this.#loadDurableIntake();
    await this.#drainAccepted();
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
      this.pendingIndex.set(record.event.eventId, record);
    }
  }

  async #loadShardHistory({ ledgerDirectory, shardId, shardPath, routingEpoch }) {
    let previousSegmentHash = null;
    let ledgerId;
    let expectedSegmentNumber = 0;
    const formatVersion = routingEpoch === null ? 1 : 2;

    await discardProvisionalFiles(shardPath, /^segment-[0-9]{12}\.g9p\.part$/u);
    for (const fileName of await files(shardPath)) {
      const path = join(shardPath, fileName);
      const verified = await verifySegment(path, {
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
        throw new G9pError("LEDGER_SEGMENT_FORMAT", `Segment ${path} uses format version ${verified.formatVersion} but its storage path requires version ${formatVersion}`);
      }
      if (verified.segmentNumber !== expectedSegmentNumber) {
        throw new G9pError("LEDGER_SEGMENT_SEQUENCE", `Expected segment ${expectedSegmentNumber} in ${shardPath} but found ${verified.segmentNumber}`);
      }
      ledgerId ??= verified.ledgerId;
      if (verified.ledgerId !== ledgerId || ledgerDirectoryName(verified.ledgerId) !== ledgerDirectory) {
        throw new G9pError("LEDGER_DIRECTORY", `Segment ${path} is stored under the wrong ledger directory`);
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
        directory: shardPath,
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

  async #loadRoutingEpochs() {
    for (const ledgerDirectory of await directories(this.routingDirectory)) {
      const ledgerPath = join(this.routingDirectory, ledgerDirectory);
      await discardProvisionalFiles(ledgerPath, /^epoch-[0-9]{12}\.g9p\.part$/u);
      const fileNames = await routingEpochFiles(ledgerPath);
      let previousEpochHash = null;
      let previousRoutingPolicy;
      let ledgerId;
      let activeEpoch;

      for (let epochNumber = 0; epochNumber < fileNames.length; epochNumber += 1) {
        const expectedName = routingEpochFileName(epochNumber);
        if (fileNames[epochNumber] !== expectedName) {
          throw new G9pError("LEDGER_ROUTING_SEQUENCE", `Expected ${expectedName} in ${ledgerPath} but found ${fileNames[epochNumber]}`);
        }
        const path = join(ledgerPath, fileNames[epochNumber]);
        const verified = await verifyRoutingEpoch(path, {
          trustedKeyIds: new Set([this.topologyAuthority.keyId]),
          requireTrustedAuthority: true,
          expectedEpochNumber: epochNumber,
          expectedPreviousEpochHash: previousEpochHash,
          ...(previousRoutingPolicy === undefined ? {} : { expectedPreviousRoutingPolicy: previousRoutingPolicy }),
        });
        ledgerId ??= verified.ledgerId;
        if (verified.ledgerId !== ledgerId || ledgerDirectoryName(verified.ledgerId) !== ledgerDirectory) {
          throw new G9pError("LEDGER_ROUTING_DIRECTORY", `Routing epoch ${path} is stored under the wrong ledger directory`);
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
      this.routingHistory.set(ledgerId, fileNames.map((_, index) => this.routingEpochDirectories.get(epochStorageKey(ledgerDirectory, index))));
    }
  }

  async #ensureGenesisRoutingEpoch(ledgerId, reason = "Create initial routing epoch") {
    const existing = this.routingEpochs.get(ledgerId);
    if (existing !== undefined) return existing;

    const directory = join(this.routingDirectory, ledgerDirectoryName(ledgerId));
    const outputPath = join(directory, routingEpochFileName(0));
    await writeRoutingEpoch({
      outputPath,
      ledgerId,
      epochNumber: 0,
      routingPolicy: this.defaultRoutingPolicy,
      topologyAuthority: this.topologyAuthority,
      reason,
    });
    const verified = await verifyRoutingEpoch(outputPath, {
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
    return this.#serialize(() => this.#drainAccepted());
  }

  transitionRouting(options) {
    return this.#serialize(() => this.#transitionRouting(options));
  }

  ingestBatch(events) {
    return this.#serialize(async () => {
      const accepted = await this.#acceptBatch(events);
      await this.#drainAccepted();
      return accepted.map((receipt) => this.eventIndex.get(receipt.eventId) ?? receipt);
    });
  }

  async #acceptBatch(events) {
    const validatedEvents = events.map((event) => {
      validateEvent(event);
      return event;
    });
    const prepared = validatedEvents.map((event) => {
      return { event, recordHash: eventHashHex(event) };
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
        this.pendingIndex.set(item.event.eventId, pending);
        acceptedThisRequest.set(item.event.eventId, pending);
      }
      receipts.push({
        eventId: item.event.eventId,
        status: "accepted",
        ledgerId: item.event.ledgerId,
        recordHash: item.recordHash,
        intakeSequence: pending.sequence,
        acceptedAt: pending.acceptedAt,
      });
    }
    return receipts;
  }

  async #drainAccepted() {
    for (const pending of [...this.pendingIndex.values()].sort((left, right) => left.sequence - right.sequence)) {
      const sealed = this.eventIndex.get(pending.event.eventId);
      if (sealed === undefined) continue;
      if (sealed.recordHash !== pending.recordHash) {
        throw new G9pError("EVENT_ID_CONFLICT", `Accepted event ID ${pending.event.eventId} conflicts with sealed history`);
      }
      await this.intake.remove(pending);
      this.pendingIndex.delete(pending.event.eventId);
    }

    const pendingRecords = [...this.pendingIndex.values()].sort((left, right) => left.sequence - right.sequence);
    for (const ledgerId of new Set(pendingRecords.map((record) => record.event.ledgerId))) {
      await this.#ensureGenesisRoutingEpoch(ledgerId);
    }
    const uniqueNew = pendingRecords.map((pending) => {
      const routingEpoch = this.routingEpochs.get(pending.event.ledgerId);
      return {
        event: pending.event,
        route: routeEvent(pending.event, routingEpoch.routingPolicy),
        recordHash: pending.recordHash,
        pending,
      };
    });

    const groups = new Map();
    for (const item of uniqueNew) {
      const routingEpoch = this.routingEpochs.get(item.event.ledgerId);
      const key = stateKey(item.event.ledgerId, routingEpoch.epochNumber, item.route.shardId);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }

    for (const [key, items] of groups) {
      const { ledgerId } = items[0].event;
      const { shardId } = items[0].route;
      const routingEpoch = this.routingEpochs.get(ledgerId);
      const formatVersion = this.ledgerSegmentFormats.get(ledgerEpochKey(ledgerId, routingEpoch.epochNumber)) ?? 2;
      const directory = formatVersion === 1
        ? join(this.segmentDirectory, ledgerDirectoryName(ledgerId), shardId)
        : join(this.segmentDirectory, ledgerDirectoryName(ledgerId), epochDirectoryName(routingEpoch.epochNumber), shardId);
      const state = this.shardStates.get(key) ?? {
        ledgerId,
        shardId,
        epochNumber: routingEpoch.epochNumber,
        formatVersion,
        directory,
        nextSegmentNumber: 0,
        previousSegmentHash: null,
      };
      const outputPath = join(state.directory, segmentFileName(state.nextSegmentNumber));
      const result = await writeSegment({
        outputPath,
        events: items.map((item) => item.event),
        routingPolicy: this.routingEpochs.get(ledgerId).routingPolicy,
        segmentNumber: state.nextSegmentNumber,
        previousSegmentHash: state.previousSegmentHash,
        routingEpoch: state.formatVersion === 1 ? null : {
          epochNumber: routingEpoch.epochNumber,
          epochHash: fromHex(routingEpoch.epochHash, 32),
        },
        signer: this.signer,
      });
      this.#recordLedgerSegmentFormat(ledgerId, state.epochNumber, state.formatVersion);

      items.forEach((item, recordIndex) => {
        this.eventIndex.set(item.event.eventId, {
          eventId: item.event.eventId,
          status: "sealed",
          ledgerId,
          shardId,
          routingEpochNumber: state.epochNumber,
          segmentNumber: state.nextSegmentNumber,
          recordIndex,
          recordHash: item.recordHash,
          segmentHash: result.segmentHash,
          signerKeyId: result.signerKeyId,
        });
      });

      this.shardStates.set(key, {
        ledgerId,
        shardId,
        epochNumber: state.epochNumber,
        formatVersion: state.formatVersion,
        directory: state.directory,
        nextSegmentNumber: state.nextSegmentNumber + 1,
        previousSegmentHash: fromHex(result.segmentHash, 32),
      });

      for (const item of items) {
        await this.intake.remove(item.pending);
        this.pendingIndex.delete(item.event.eventId);
      }
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
    const outputPath = join(this.routingDirectory, ledgerDirectory, routingEpochFileName(epochNumber));
    await writeRoutingEpoch({
      outputPath,
      ledgerId,
      epochNumber,
      routingPolicy,
      topologyAuthority: this.topologyAuthority,
      reason,
      previousEpochHash: fromHex(activeEpoch.epochHash, 32),
      previousShardHeads,
      previousRoutingPolicy: activeEpoch.routingPolicy,
    });
    const verified = await verifyRoutingEpoch(outputPath, {
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

  info() {
    return {
      formatVersion: 1,
      routingEpochProtocolVersion: 1,
      routingPolicy: this.defaultRoutingPolicy,
      topologyAuthorityKeyId: this.topologyAuthority.keyId,
      knownRoutingLedgers: this.routingEpochs.size,
      signerKeyId: this.signer.keyId,
      knownEvents: this.eventIndex.size,
      acceptedEvents: this.pendingIndex.size,
      activeShardStreams: this.shardStates.size,
    };
  }
}
