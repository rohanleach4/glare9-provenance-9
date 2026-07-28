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
  verifySegment,
  writeSegment,
} from "@glare9/provenance";

function ledgerDirectoryName(ledgerId) {
  return toHex(domainHash("ledger-directory-v1", Buffer.from(ledgerId, "utf8")));
}

function stateKey(ledgerId, shardId) {
  return `${ledgerId}\0${shardId}`;
}

function segmentFileName(segmentNumber) {
  return `segment-${segmentNumber.toString().padStart(12, "0")}.g9p`;
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

export class LocalLedger {
  constructor({ dataDirectory, signer, shardCount = 1 }) {
    this.dataDirectory = dataDirectory;
    this.segmentDirectory = join(dataDirectory, "segments");
    this.signer = signer;
    this.routingPolicy = createRoutingPolicy(shardCount);
    this.eventIndex = new Map();
    this.shardStates = new Map();
    this.ingestTail = Promise.resolve();
  }

  async initialize() {
    await mkdir(this.segmentDirectory, { recursive: true });
    for (const ledgerDirectory of await directories(this.segmentDirectory)) {
      const ledgerPath = join(this.segmentDirectory, ledgerDirectory);
      for (const shardId of await directories(ledgerPath)) {
        const shardPath = join(ledgerPath, shardId);
        let previousSegmentHash = null;
        let ledgerId;
        let expectedSegmentNumber = 0;

        for (const fileName of await files(shardPath)) {
          const path = join(shardPath, fileName);
          const verified = await verifySegment(path, {
            trustedKeyIds: new Set([this.signer.keyId]),
            requireTrustedSigner: true,
            expectedPreviousSegmentHash: previousSegmentHash,
            expectedShardId: shardId,
          });
          if (verified.segmentNumber !== expectedSegmentNumber) {
            throw new G9pError("LEDGER_SEGMENT_SEQUENCE", `Expected segment ${expectedSegmentNumber} in ${shardPath} but found ${verified.segmentNumber}`);
          }
          ledgerId ??= verified.ledgerId;
          if (verified.ledgerId !== ledgerId || ledgerDirectoryName(verified.ledgerId) !== ledgerDirectory) {
            throw new G9pError("LEDGER_DIRECTORY", `Segment ${path} is stored under the wrong ledger directory`);
          }

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
          this.shardStates.set(stateKey(ledgerId, shardId), {
            ledgerId,
            shardId,
            nextSegmentNumber: expectedSegmentNumber,
            previousSegmentHash,
          });
        }
      }
    }
    return this;
  }

  ingestBatch(events) {
    const operation = this.ingestTail.then(() => this.#ingestBatch(events));
    this.ingestTail = operation.catch(() => {});
    return operation;
  }

  async #ingestBatch(events) {
    const prepared = events.map((event) => {
      validateEvent(event);
      const route = routeEvent(event, this.routingPolicy);
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
      const key = stateKey(item.event.ledgerId, item.route.shardId);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }

    for (const [key, items] of groups) {
      const { ledgerId } = items[0].event;
      const { shardId } = items[0].route;
      const state = this.shardStates.get(key) ?? {
        ledgerId,
        shardId,
        nextSegmentNumber: 0,
        previousSegmentHash: null,
      };
      const directory = join(this.segmentDirectory, ledgerDirectoryName(ledgerId), shardId);
      const outputPath = join(directory, segmentFileName(state.nextSegmentNumber));
      const result = await writeSegment({
        outputPath,
        events: items.map((item) => item.event),
        routingPolicy: this.routingPolicy,
        segmentNumber: state.nextSegmentNumber,
        previousSegmentHash: state.previousSegmentHash,
        signer: this.signer,
      });

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
        nextSegmentNumber: state.nextSegmentNumber + 1,
        previousSegmentHash: fromHex(result.segmentHash, 32),
      });
    }

    return prepared.map((item) => this.eventIndex.get(item.event.eventId));
  }

  info() {
    return {
      formatVersion: 1,
      routingPolicy: this.routingPolicy,
      signerKeyId: this.signer.keyId,
      knownEvents: this.eventIndex.size,
      activeShardStreams: this.shardStates.size,
    };
  }
}
