import { mkdir, readdir } from "node:fs/promises";
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
    this.signer = signer;
    this.topologyAuthority = topologyAuthority;
    this.adoptLegacyRoutingHistory = adoptLegacyRoutingHistory;
    this.routingPolicy = createRoutingPolicy(shardCount);
    this.routingEpochs = new Map();
    this.routingEpochDirectories = new Map();
    this.ledgerSegmentFormats = new Map();
    this.eventIndex = new Map();
    this.shardStates = new Map();
    this.ingestTail = Promise.resolve();
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
        const routingEpoch = this.routingEpochDirectories.get(ledgerDirectory);
        if (routingEpoch === undefined || routingEpoch.epochNumber !== epochNumber) {
          throw new G9pError("LEDGER_ROUTING_EPOCH", `Segment directory ${epochDirectory} has no matching active signed routing epoch`);
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
    return this;
  }

  async #loadShardHistory({ ledgerDirectory, shardId, shardPath, routingEpoch }) {
    let previousSegmentHash = null;
    let ledgerId;
    let expectedSegmentNumber = 0;
    const formatVersion = routingEpoch === null ? 1 : 2;

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
      if (!routingPoliciesEqual(verified.routingPolicy, this.routingPolicy)) {
        throw new G9pError(
          "LEDGER_ROUTING_POLICY",
          `Ledger ${verified.ledgerId} history uses routing policy ${verified.routingPolicy.id} version ${verified.routingPolicy.version} with ${verified.routingPolicy.shardCount} shards, but the service is configured for ${this.routingPolicy.id} version ${this.routingPolicy.version} with ${this.routingPolicy.shardCount} shards`,
        );
      }
      const signedRoutingEpoch = this.routingEpochs.get(verified.ledgerId);
      if (signedRoutingEpoch !== undefined && !routingPoliciesEqual(verified.routingPolicy, signedRoutingEpoch.routingPolicy)) {
        throw new G9pError("LEDGER_ROUTING_HISTORY", `Segment ${path} does not use the signed routing policy for ledger ${verified.ledgerId}`);
      }
      this.#recordLedgerSegmentFormat(verified.ledgerId, formatVersion);

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

  #recordLedgerSegmentFormat(ledgerId, formatVersion) {
    const existing = this.ledgerSegmentFormats.get(ledgerId);
    if (existing !== undefined && existing !== formatVersion) {
      throw new G9pError("LEDGER_SEGMENT_FORMAT", `Ledger ${ledgerId} contains both legacy and epoch-aware segment streams`);
    }
    this.ledgerSegmentFormats.set(ledgerId, formatVersion);
  }

  async #loadRoutingEpochs() {
    for (const ledgerDirectory of await directories(this.routingDirectory)) {
      const ledgerPath = join(this.routingDirectory, ledgerDirectory);
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
      }

      if (activeEpoch === undefined) continue;
      if (activeEpoch.epochNumber !== 0) {
        throw new G9pError("LEDGER_ROUTING_EPOCH_UNSUPPORTED", `Ledger ${ledgerId} has routing epoch ${activeEpoch.epochNumber}, but live epoch transitions are not implemented`);
      }
      if (!routingPoliciesEqual(activeEpoch.routingPolicy, this.routingPolicy)) {
        throw new G9pError(
          "LEDGER_ROUTING_POLICY",
          `Ledger ${ledgerId} signed routing history uses ${activeEpoch.routingPolicy.shardCount} shards, but the service is configured for ${this.routingPolicy.shardCount} shards`,
        );
      }
      this.routingEpochs.set(ledgerId, activeEpoch);
      this.routingEpochDirectories.set(ledgerDirectory, activeEpoch);
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
      routingPolicy: this.routingPolicy,
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
    this.routingEpochDirectories.set(ledgerDirectoryName(ledgerId), verified);
    return verified;
  }

  ingestBatch(events) {
    const operation = this.ingestTail.then(() => this.#ingestBatch(events));
    this.ingestTail = operation.catch(() => {});
    return operation;
  }

  async #ingestBatch(events) {
    const validatedEvents = events.map((event) => {
      validateEvent(event);
      return event;
    });
    for (const ledgerId of new Set(validatedEvents.map((event) => event.ledgerId))) {
      await this.#ensureGenesisRoutingEpoch(ledgerId);
    }
    const prepared = validatedEvents.map((event) => {
      const routingEpoch = this.routingEpochs.get(event.ledgerId);
      const route = routeEvent(event, routingEpoch.routingPolicy);
      return { event, route, recordHash: eventHashHex(event) };
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
    }

    const uniqueNew = [];
    const newIds = new Set();
    for (const item of prepared) {
      if (!this.eventIndex.has(item.event.eventId) && !newIds.has(item.event.eventId)) {
        uniqueNew.push(item);
        newIds.add(item.event.eventId);
      }
    }

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
      const formatVersion = this.ledgerSegmentFormats.get(ledgerId) ?? 2;
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
      this.#recordLedgerSegmentFormat(ledgerId, state.formatVersion);

      items.forEach((item, recordIndex) => {
        this.eventIndex.set(item.event.eventId, {
          eventId: item.event.eventId,
          status: "sealed",
          ledgerId,
          shardId,
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
    }

    return prepared.map((item) => this.eventIndex.get(item.event.eventId));
  }

  info() {
    return {
      formatVersion: 1,
      routingEpochProtocolVersion: 1,
      routingPolicy: this.routingPolicy,
      topologyAuthorityKeyId: this.topologyAuthority.keyId,
      knownRoutingLedgers: this.routingEpochs.size,
      signerKeyId: this.signer.keyId,
      knownEvents: this.eventIndex.size,
      activeShardStreams: this.shardStates.size,
    };
  }
}
