import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createRoutingPolicy,
  domainHash,
  fromHex,
  generateSigner,
  G9pError,
  routeEvent,
  toHex,
  verifyRoutingEpoch,
  verifySegment,
  writeSegment,
} from "@glare9/provenance";
import {
  ProvenanceClient,
  ProvenanceServiceError,
} from "@glare9/provenance-connector-contract";

import { LocalLedger } from "../src/local-ledger.js";
import { createLedgerServer } from "../src/server.js";

const timestamp = "2026-07-28T12:00:00.000Z";

class MemorySealedStorage {
  constructor() {
    this.objects = new Map();
  }

  async initialize() {}

  async publish(key, bytes, options = {}) {
    if (this.objects.has(key)) {
      throw new G9pError(options.errorCode ?? "SEALED_STORAGE_WRITE", `Object ${key} already exists`);
    }
    this.objects.set(key, Uint8Array.from(bytes));
  }

  async read(key) {
    const bytes = this.objects.get(key);
    if (bytes === undefined) throw new G9pError("SEALED_STORAGE_NOT_FOUND", `Object ${key} does not exist`);
    return Uint8Array.from(bytes);
  }

  async list(prefix) {
    return [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
  }
}

function event(overrides = {}) {
  return {
    version: 1,
    eventId: "event-001",
    ledgerId: "connector-test-ledger",
    subject: "model:test",
    type: "ai.model.registered",
    schemaVersion: 1,
    occurredAt: timestamp,
    recordedAt: timestamp,
    source: { kind: "outbox", identity: "test-application" },
    payload: { name: "Test model" },
    ...overrides,
  };
}

function routingEpochPath(directory, ledgerId) {
  const ledgerDirectory = toHex(domainHash("ledger-directory-v1", Buffer.from(ledgerId, "utf8")));
  return join(directory, "routing", ledgerDirectory, "epoch-000000000000.g9p");
}

function segmentPath(directory, ledgerId, { epochNumber = 0, shardId = "shard-0000", segmentNumber = 0, legacy = false } = {}) {
  const ledgerDirectory = toHex(domainHash("ledger-directory-v1", Buffer.from(ledgerId, "utf8")));
  const shardDirectory = join(directory, "segments", ledgerDirectory);
  const epochDirectory = `epoch-${epochNumber.toString().padStart(12, "0")}`;
  const fileName = `segment-${segmentNumber.toString().padStart(12, "0")}.g9p`;
  return legacy
    ? join(shardDirectory, shardId, fileName)
    : join(shardDirectory, epochDirectory, shardId, fileName);
}

async function writeLegacyHistory(directory, signer) {
  const legacyEvent = event({ ledgerId: "legacy-ledger", eventId: "legacy-event" });
  const ledgerDirectory = toHex(domainHash("ledger-directory-v1", Buffer.from(legacyEvent.ledgerId, "utf8")));
  const segmentPath = join(directory, "segments", ledgerDirectory, "shard-0000", "segment-000000000000.g9p");
  await writeSegment({
    outputPath: segmentPath,
    events: [legacyEvent],
    routingPolicy: createRoutingPolicy(1),
    segmentNumber: 0,
    signer,
    createdAt: timestamp,
  });
  return legacyEvent;
}

async function fixture(run, { shardCount = 1, lifecycle } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "g9p-ledger-service-"));
  const signer = generateSigner();
  const topologyAuthority = generateSigner();
  const ledger = await new LocalLedger({ dataDirectory: directory, signer, topologyAuthority, shardCount, lifecycle }).initialize();
  const service = createLedgerServer({
    ledger,
    apiToken: "test-ledger-token",
    adminToken: "test-ledger-admin-token",
  });
  const address = await service.listen({ host: "127.0.0.1", port: 0 });
  const client = new ProvenanceClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    token: "test-ledger-token",
  });
  try {
    return await run({ directory, signer, topologyAuthority, ledger, service, client });
  } finally {
    await service.close();
    await ledger.close({ seal: false });
    await rm(directory, { recursive: true, force: true });
  }
}

function boundedLifecycle(overrides = {}) {
  return {
    blockMaxBytes: 1024 * 1024,
    blockMaxRecords: 2,
    segmentMaxBytes: 4 * 1024 * 1024,
    segmentMaxRecords: 4,
    segmentMaxAgeMs: 60_000,
    maxAcceptedEvents: 100,
    maxAcceptedBytes: 16 * 1024 * 1024,
    maxActiveBlockBytes: 2 * 1024 * 1024,
    ...overrides,
  };
}

test("ledger rebuilds and preserves idempotency through an injected sealed-storage implementation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "g9p-ledger-storage-abstraction-"));
  const signer = generateSigner();
  const topologyAuthority = generateSigner();
  const sealedStorage = new MemorySealedStorage();
  try {
    const first = await new LocalLedger({
      dataDirectory: directory,
      signer,
      topologyAuthority,
      sealedStorage,
    }).initialize();
    const [original] = await first.ingestBatch([event()]);
    await first.close({ seal: false });

    assert.equal((await sealedStorage.list("routing/")).length, 1);
    assert.equal((await sealedStorage.list("segments/")).length, 1);

    const rebuilt = await new LocalLedger({
      dataDirectory: directory,
      signer,
      topologyAuthority,
      sealedStorage,
    }).initialize();
    assert.equal(rebuilt.info().knownEvents, 1);
    const [replayed] = await rebuilt.ingestBatch([event()]);
    assert.deepEqual(replayed, original);
    await rebuilt.close({ seal: false });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ingestion service seals events and returns stable idempotent receipts", async () => {
  await fixture(async ({ directory, client, ledger }) => {
    const first = await client.submitBatch([event()]);
    const repeated = await client.submitBatch([event()]);

    assert.equal(first[0].status, "sealed");
    assert.equal(first[0].segmentNumber, 0);
    assert.deepEqual(repeated, first);
    assert.equal(ledger.info().knownEvents, 1);
    assert.equal(ledger.info().acceptedEvents, 0);
    assert.equal(ledger.info().knownRoutingLedgers, 1);
    assert.deepEqual(await readdir(join(directory, "intake")), []);
  });
});

test("accepted events are durable before shard assignment or sealing", async () => {
  await fixture(async ({ directory, ledger }) => {
    const [receipt] = await ledger.acceptBatch([event()]);
    assert.equal(receipt.status, "accepted");
    assert.equal(receipt.intakeSequence, 0);
    assert.equal(ledger.info().acceptedEvents, 1);
    assert.equal(ledger.info().knownEvents, 0);
    assert.equal(ledger.info().knownRoutingLedgers, 0);
    assert.equal((await readdir(join(directory, "intake"))).length, 1);
    await assert.rejects(
      stat(segmentPath(directory, "connector-test-ledger")),
      (error) => error.code === "ENOENT",
    );
  });
});

test("bounded lifecycle batches records from separate accepted-first requests into completed blocks", async () => {
  await fixture(async ({ directory, ledger }) => {
    const first = await ledger.ingestAcceptedBatch([
      event({ eventId: "bounded-event-1" }),
      event({ eventId: "bounded-event-2", subject: "model:test-2" }),
    ]);
    assert.deepEqual(first.map((receipt) => receipt.status), ["provisional", "provisional"]);
    assert.equal(ledger.info().activeSegments, 1);
    assert.equal(ledger.info().provisionalEvents, 2);
    await assert.rejects(
      stat(segmentPath(directory, "connector-test-ledger")),
      (error) => error.code === "ENOENT",
    );

    const second = await ledger.ingestAcceptedBatch([
      event({ eventId: "bounded-event-3", subject: "model:test-3" }),
      event({ eventId: "bounded-event-4", subject: "model:test-4" }),
    ]);
    assert.deepEqual(second.map((receipt) => receipt.status), ["sealed", "sealed"]);
    const verified = await verifySegment(segmentPath(directory, "connector-test-ledger"));
    assert.equal(verified.recordCount, 4);
    assert.equal(verified.blockCount, 2);
    assert.deepEqual(verified.events.map((item) => item.eventId), [
      "bounded-event-1",
      "bounded-event-2",
      "bounded-event-3",
      "bounded-event-4",
    ]);
    assert.equal(ledger.info().acceptedEvents, 0);
    assert.equal(ledger.info().activeSegments, 0);
  }, { lifecycle: boundedLifecycle() });
});

test("startup recovers a durable completed block and seals it exactly once", async () => {
  await fixture(async ({ directory, signer, topologyAuthority, ledger }) => {
    const [firstReceipt] = await ledger.ingestAcceptedBatch([
      event({ eventId: "recovered-block-1" }),
      event({ eventId: "recovered-block-2", subject: "model:recovered-2" }),
    ]);
    assert.equal((await readdir(join(directory, "provisional"))).length, 1);
    const rebuilt = await new LocalLedger({
      dataDirectory: directory,
      signer,
      topologyAuthority,
      lifecycle: boundedLifecycle(),
    }).initialize();
    try {
      const verified = await verifySegment(segmentPath(directory, "connector-test-ledger"));
      assert.equal(verified.recordCount, 2);
      assert.equal(verified.blockCount, 1);
      assert.equal(rebuilt.info().knownEvents, 2);
      assert.equal(rebuilt.info().acceptedEvents, 0);
      assert.equal((await rebuilt.receipt("recovered-block-1", firstReceipt.recordHash)).status, "sealed");
      assert.deepEqual(await readdir(join(directory, "provisional")), []);
    } finally {
      await rebuilt.close({ seal: false });
    }
  }, { lifecycle: boundedLifecycle() });
});

test("startup rejects corrupted completed-block provisional state", async () => {
  await fixture(async ({ directory, signer, topologyAuthority, ledger }) => {
    await ledger.ingestAcceptedBatch([
      event({ eventId: "corrupt-block-1" }),
      event({ eventId: "corrupt-block-2", subject: "model:corrupt-2" }),
    ]);
    const [name] = await readdir(join(directory, "provisional"));
    const path = join(directory, "provisional", name);
    const bytes = await readFile(path);
    bytes[bytes.length - 1] ^= 0x01;
    await writeFile(path, bytes);
    await assert.rejects(
      new LocalLedger({
        dataDirectory: directory,
        signer,
        topologyAuthority,
        lifecycle: boundedLifecycle(),
      }).initialize(),
      (error) => new Set(["ACTIVE_STATE_DECODE", "ACTIVE_STATE_VERSION", "ACTIVE_STATE_BLOCK", "ACTIVE_STATE_RECORD"]).has(error.code),
    );
  }, { lifecycle: boundedLifecycle() });
});

test("segment age seals a low-volume active block", async () => {
  await fixture(async ({ directory, ledger }) => {
    const [receipt] = await ledger.ingestAcceptedBatch([event({ eventId: "aged-event" })]);
    assert.equal(receipt.status, "accepted");
    assert.equal(ledger.info().activeSegments, 1);
    await ledger.sealExpired(Date.now() + 1_000);
    const verified = await verifySegment(segmentPath(directory, "connector-test-ledger"));
    assert.equal(verified.recordCount, 1);
    assert.equal(ledger.info().knownEvents, 1);
    assert.equal(ledger.info().activeSegments, 0);
  }, { lifecycle: boundedLifecycle({ segmentMaxAgeMs: 100 }) });
});

test("accepted-first admission applies retryable back-pressure before exceeding intake limits", async () => {
  await fixture(async ({ ledger }) => {
    const [accepted] = await ledger.ingestAcceptedBatch([event({ eventId: "capacity-event-1" })]);
    assert.equal(accepted.status, "accepted");
    await assert.rejects(
      ledger.ingestAcceptedBatch([event({ eventId: "capacity-event-2" })]),
      (error) => error.code === "LEDGER_BACKPRESSURE",
    );
    assert.equal(ledger.info().acceptedEvents, 1);
  }, { lifecycle: boundedLifecycle({ maxAcceptedEvents: 1 }) });
});

test("active-memory back-pressure rejects an oversized event before durable acceptance", async () => {
  await fixture(async ({ ledger }) => {
    await assert.rejects(
      ledger.ingestAcceptedBatch([event({
        eventId: "oversized-active-event",
        payload: { name: "x".repeat(2_000) },
      })]),
      (error) => error.code === "LEDGER_BACKPRESSURE",
    );
    assert.equal(ledger.info().acceptedEvents, 0);
    assert.equal(ledger.info().acceptedBytes, 0);
  }, { lifecycle: boundedLifecycle({ blockMaxBytes: 1024, maxActiveBlockBytes: 1024 }) });
});

test("version 2 HTTP ingestion returns accepted-stage receipts without forcing a seal", async () => {
  await fixture(async ({ service, ledger }) => {
    const address = service.server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/v2/events:batch`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-ledger-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ contractVersion: 2, events: [event({ eventId: "http-accepted-event" })] }),
    });
    assert.equal(response.status, 202);
    const payload = await response.json();
    assert.equal(payload.contractVersion, 2);
    assert.equal(payload.receipts[0].status, "accepted");
    assert.equal(ledger.info().knownEvents, 0);
    assert.equal(ledger.info().acceptedEvents, 1);
  }, { lifecycle: boundedLifecycle() });
});

test("version 2 receipt lookup polls monotonically from accepted through provisional to sealed", async () => {
  await fixture(async ({ client, ledger }) => {
    const firstEvent = event({ eventId: "polled-event-1" });
    const [accepted] = await client.submitAcceptedBatch([firstEvent]);
    assert.equal(accepted.status, "accepted");
    assert.deepEqual(await client.getReceipt(firstEvent.eventId, accepted.recordHash), accepted);

    const secondEvent = event({ eventId: "polled-event-2", subject: "model:polled-2" });
    const [second] = await client.submitAcceptedBatch([secondEvent]);
    assert.equal(second.status, "provisional");
    const provisional = await client.getReceipt(firstEvent.eventId, accepted.recordHash);
    assert.equal(provisional.status, "provisional");
    assert.equal(provisional.intakeSequence, accepted.intakeSequence);
    assert.equal(provisional.acceptedAt, accepted.acceptedAt);

    await ledger.drainAccepted();
    const sealed = await client.getReceipt(firstEvent.eventId, accepted.recordHash);
    assert.equal(sealed.status, "sealed");
    assert.equal(sealed.recordHash, accepted.recordHash);
    await assert.rejects(
      client.getReceipt(firstEvent.eventId, "f".repeat(64)),
      (error) => error.status === 409 && error.code === "EVENT_ID_CONFLICT" && error.retryable === false,
    );
    await assert.rejects(
      client.getReceipt("unknown-event", "e".repeat(64)),
      (error) => error.status === 404 && error.code === "RECEIPT_NOT_FOUND" && error.retryable === false,
    );
  }, { lifecycle: boundedLifecycle() });
});

test("durable acceptance is idempotent and rejects conflicting event content", async () => {
  await fixture(async ({ ledger }) => {
    const first = await ledger.acceptBatch([event()]);
    const repeated = await ledger.acceptBatch([event()]);
    assert.deepEqual(repeated, first);
    assert.equal(ledger.info().acceptedEvents, 1);
    await assert.rejects(
      ledger.acceptBatch([event({ payload: { name: "Conflicting accepted event" } })]),
      (error) => error.code === "EVENT_ID_CONFLICT",
    );
  });
});

test("startup recovers accepted intake and seals it exactly once", async () => {
  await fixture(async ({ directory, signer, topologyAuthority, ledger }) => {
    await ledger.acceptBatch([event()]);
    const rebuilt = await new LocalLedger({ dataDirectory: directory, signer, topologyAuthority }).initialize();
    assert.equal(rebuilt.info().acceptedEvents, 0);
    assert.equal(rebuilt.info().knownEvents, 1);
    assert.deepEqual(await readdir(join(directory, "intake")), []);
    const [receipt] = await rebuilt.ingestBatch([event()]);
    assert.equal(receipt.status, "sealed");
    assert.equal(receipt.segmentNumber, 0);
  });
});

test("startup promotes a complete provisional intake record and resumes sealing", async () => {
  await fixture(async ({ directory, signer, topologyAuthority, ledger }) => {
    await ledger.acceptBatch([event()]);
    const [name] = await readdir(join(directory, "intake"));
    const path = join(directory, "intake", name);
    await rename(path, `${path}.part`);
    const rebuilt = await new LocalLedger({ dataDirectory: directory, signer, topologyAuthority }).initialize();
    assert.equal(rebuilt.info().knownEvents, 1);
    assert.equal(rebuilt.info().acceptedEvents, 0);
    assert.deepEqual(await readdir(join(directory, "intake")), []);
  });
});

test("startup rejects a corrupted durable intake record", async () => {
  await fixture(async ({ directory, signer, topologyAuthority, ledger }) => {
    await ledger.acceptBatch([event()]);
    const [name] = await readdir(join(directory, "intake"));
    const path = join(directory, "intake", name);
    const bytes = await readFile(path);
    bytes[bytes.length - 1] ^= 0x01;
    await writeFile(path, bytes);
    await assert.rejects(
      new LocalLedger({ dataDirectory: directory, signer, topologyAuthority }).initialize(),
      (error) => new Set(["INTAKE_DECODE", "INTAKE_HASH", "INTAKE_VERSION"]).has(error.code),
    );
  });
});

test("routing transition seals the old barrier and activates epoch-scoped streams", async () => {
  await fixture(async ({ directory, signer, topologyAuthority, ledger, client }) => {
    const oldEvent = event({ subject: "model:old-epoch" });
    await client.submitBatch([oldEvent]);
    const transition = await ledger.transitionRouting({
      ledgerId: oldEvent.ledgerId,
      shardCount: 4,
      reason: "Increase verified write concurrency",
      expectedCurrentEpoch: 0,
    });
    assert.equal(transition.epochNumber, 1);
    assert.equal(transition.routingPolicy.shardCount, 4);
    assert.equal(transition.previousShardHeads.length, 2);
    assert.equal(transition.alreadyActive, false);

    const retry = await ledger.transitionRouting({
      ledgerId: oldEvent.ledgerId,
      shardCount: 4,
      reason: "Retry after an uncertain response",
      expectedCurrentEpoch: 0,
    });
    assert.equal(retry.epochHash, transition.epochHash);
    assert.equal(retry.alreadyActive, true);

    const newEvent = event({ eventId: "event-new-epoch", subject: "model:new-epoch" });
    const [receipt] = await ledger.ingestBatch([newEvent]);
    assert.equal(receipt.routingEpochNumber, 1);
    const route = routeEvent(newEvent, createRoutingPolicy(4));
    const verified = await verifySegment(segmentPath(directory, newEvent.ledgerId, {
      epochNumber: 1,
      shardId: route.shardId,
    }), {
      trustedKeyIds: [signer.keyId],
      requireTrustedSigner: true,
      expectedRoutingEpochNumber: 1,
      expectedRoutingEpochHash: fromHex(transition.epochHash, 32),
    });
    assert.equal(verified.segmentNumber, 0);

    const rebuilt = await new LocalLedger({
      dataDirectory: directory,
      signer,
      topologyAuthority,
      shardCount: 2,
    }).initialize();
    const [replayed] = await rebuilt.ingestBatch([newEvent]);
    assert.deepEqual(replayed, receipt);
  }, { shardCount: 2 });
});

test("routing transition endpoint requires the separate administration token", async () => {
  await fixture(async ({ service, client }) => {
    await client.submitBatch([event()]);
    const address = service.server.address();
    const url = `http://127.0.0.1:${address.port}/v1/admin/routing-transitions`;
    const body = JSON.stringify({
      contractVersion: 1,
      ledgerId: "connector-test-ledger",
      shardCount: 2,
      reason: "Exercise the separately authenticated coordinator",
      expectedCurrentEpoch: 0,
    });
    const denied = await fetch(url, {
      method: "POST",
      headers: { authorization: "Bearer test-ledger-token", "content-type": "application/json" },
      body,
    });
    assert.equal(denied.status, 401);

    const allowed = await fetch(url, {
      method: "POST",
      headers: { authorization: "Bearer test-ledger-admin-token", "content-type": "application/json" },
      body,
    });
    assert.equal(allowed.status, 200);
    const payload = await allowed.json();
    assert.equal(payload.transition.epochNumber, 1);
    assert.equal(payload.transition.routingPolicy.shardCount, 2);
  });
});

test("accepted events before and after a transition seal under the correct epochs", async () => {
  await fixture(async ({ directory, signer, topologyAuthority, ledger }) => {
    const before = event({ eventId: "event-before-barrier", subject: "subject:before" });
    await ledger.acceptBatch([before]);
    await ledger.transitionRouting({
      ledgerId: before.ledgerId,
      shardCount: 2,
      reason: "Create a second routing epoch",
      expectedCurrentEpoch: 0,
    });
    const beforeRoute = routeEvent(before, createRoutingPolicy(1));
    const oldSegment = await verifySegment(segmentPath(directory, before.ledgerId, { shardId: beforeRoute.shardId }));
    assert.equal(oldSegment.routingEpochNumber, 0);

    const after = event({ eventId: "event-after-barrier", subject: "subject:after" });
    await ledger.acceptBatch([after]);
    const rebuilt = await new LocalLedger({
      dataDirectory: directory,
      signer,
      topologyAuthority,
      shardCount: 1,
    }).initialize();
    const afterRoute = routeEvent(after, createRoutingPolicy(2));
    const newSegment = await verifySegment(segmentPath(directory, after.ledgerId, {
      epochNumber: 1,
      shardId: afterRoute.shardId,
    }));
    assert.equal(newSegment.routingEpochNumber, 1);
    assert.equal(rebuilt.info().acceptedEvents, 0);
  });
});

test("startup rejects a transition descriptor whose recorded old head is missing", async () => {
  await fixture(async ({ directory, signer, topologyAuthority, ledger, client }) => {
    const oldEvent = event({ subject: "subject:missing-head" });
    await client.submitBatch([oldEvent]);
    const oldRoute = routeEvent(oldEvent, createRoutingPolicy(1));
    await ledger.transitionRouting({
      ledgerId: oldEvent.ledgerId,
      shardCount: 2,
      reason: "Transition used for missing-head test",
      expectedCurrentEpoch: 0,
    });
    await rm(segmentPath(directory, oldEvent.ledgerId, { shardId: oldRoute.shardId }));
    await assert.rejects(
      new LocalLedger({ dataDirectory: directory, signer, topologyAuthority }).initialize(),
      (error) => error.code === "LEDGER_TRANSITION_HEAD",
    );
  });
});

test("first ingestion creates and trusts a signed genesis routing epoch", async () => {
  await fixture(async ({ directory, signer, topologyAuthority, client }) => {
    await client.submitBatch([event()]);
    const path = routingEpochPath(directory, "connector-test-ledger");
    assert.equal((await stat(path)).isFile(), true);
    const verifiedEpoch = await verifyRoutingEpoch(path, {
      trustedKeyIds: [topologyAuthority.keyId],
      requireTrustedAuthority: true,
      expectedLedgerId: "connector-test-ledger",
      expectedEpochNumber: 0,
    });
    assert.equal(verifiedEpoch.routingPolicy.shardCount, 1);

    const verifiedSegment = await verifySegment(segmentPath(directory, "connector-test-ledger"), {
      trustedKeyIds: [signer.keyId],
      requireTrustedSigner: true,
      expectedRoutingEpochNumber: verifiedEpoch.epochNumber,
      expectedRoutingEpochHash: fromHex(verifiedEpoch.epochHash, 32),
    });
    assert.equal(verifiedSegment.formatVersion, 2);
    assert.equal(verifiedSegment.routingEpochHash, verifiedEpoch.epochHash);
  });
});

test("ingestion service rejects conflicting reuse of an event ID", async () => {
  await fixture(async ({ client }) => {
    await client.submitBatch([event()]);
    await assert.rejects(
      client.submitBatch([event({ payload: { name: "Conflicting model" } })]),
      (error) => error instanceof ProvenanceServiceError
        && error.status === 409
        && error.code === "EVENT_ID_CONFLICT"
        && error.retryable === false,
    );
  });
});

test("ledger rebuilds its event index and routing history from verified files", async () => {
  await fixture(async ({ directory, signer, topologyAuthority, client }) => {
    const [receipt] = await client.submitBatch([event()]);
    const rebuilt = await new LocalLedger({ dataDirectory: directory, signer, topologyAuthority }).initialize();
    assert.equal(rebuilt.info().knownEvents, 1);
    assert.equal(rebuilt.info().knownRoutingLedgers, 1);
    const [replayedReceipt] = await rebuilt.ingestBatch([event()]);
    assert.deepEqual(replayedReceipt, receipt);
  });
});

test("ledger rebuilds history when the configured routing policy matches", async () => {
  await fixture(async ({ directory, signer, topologyAuthority, client }) => {
    await client.submitBatch([event()]);
    const rebuilt = await new LocalLedger({ dataDirectory: directory, signer, topologyAuthority, shardCount: 4 }).initialize();
    assert.equal(rebuilt.info().knownEvents, 1);
    assert.equal(rebuilt.info().routingPolicy.shardCount, 4);
  }, { shardCount: 4 });
});

test("ledger refuses an in-place shard-count change when signed routing history exists", async () => {
  await fixture(async ({ directory, signer, topologyAuthority, client }) => {
    await client.submitBatch([event()]);
    await assert.rejects(
      new LocalLedger({ dataDirectory: directory, signer, topologyAuthority, shardCount: 8 }).initialize(),
      (error) => error.code === "LEDGER_ROUTING_POLICY"
        && error.message.includes("uses 4 shards")
        && error.message.includes("configured for 8 shards"),
    );
  }, { shardCount: 4 });
});

test("ledger rejects tampered signed routing history on startup", async () => {
  await fixture(async ({ directory, signer, topologyAuthority, client }) => {
    await client.submitBatch([event()]);
    const path = routingEpochPath(directory, "connector-test-ledger");
    const bytes = await readFile(path);
    const signatureMarker = bytes.indexOf(Buffer.from("SIG1", "ascii"));
    const signatureLength = bytes.readUInt32BE(signatureMarker + 4);
    bytes[signatureMarker + 8 + signatureLength - 1] ^= 0x01;
    await writeFile(path, bytes);
    await assert.rejects(
      new LocalLedger({ dataDirectory: directory, signer, topologyAuthority }).initialize(),
      (error) => error.code === "EPOCH_SIGNATURE",
    );
  });
});

test("ledger rejects an unexpectedly named sealed routing descriptor", async () => {
  await fixture(async ({ directory, signer, topologyAuthority, client }) => {
    await client.submitBatch([event()]);
    const validPath = routingEpochPath(directory, "connector-test-ledger");
    const forkPath = join(validPath, "..", "epoch-fork.g9p");
    await writeFile(forkPath, await readFile(validPath));
    await assert.rejects(
      new LocalLedger({ dataDirectory: directory, signer, topologyAuthority }).initialize(),
      (error) => error.code === "LEDGER_ROUTING_FILE",
    );
  });
});

test("one batch creates independent signed routing history for each ledger", async () => {
  await fixture(async ({ directory, topologyAuthority, client, ledger }) => {
    await client.submitBatch([
      event({ eventId: "event-ledger-a", ledgerId: "ledger-a" }),
      event({ eventId: "event-ledger-b", ledgerId: "ledger-b" }),
    ]);
    assert.equal(ledger.info().knownRoutingLedgers, 2);
    for (const ledgerId of ["ledger-a", "ledger-b"]) {
      const verified = await verifyRoutingEpoch(routingEpochPath(directory, ledgerId), {
        trustedKeyIds: [topologyAuthority.keyId],
        requireTrustedAuthority: true,
        expectedLedgerId: ledgerId,
      });
      assert.equal(verified.epochNumber, 0);
    }
  });
});

test("startup adopts verified legacy version 1 history into a signed genesis epoch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "g9p-ledger-migration-"));
  const signer = generateSigner();
  const topologyAuthority = generateSigner();
  try {
    const legacyEvent = await writeLegacyHistory(directory, signer);
    const ledger = await new LocalLedger({
      dataDirectory: directory,
      signer,
      topologyAuthority,
      adoptLegacyRoutingHistory: true,
    }).initialize();
    assert.equal(ledger.info().knownEvents, 1);
    assert.equal(ledger.info().knownRoutingLedgers, 1);
    const verified = await verifyRoutingEpoch(routingEpochPath(directory, legacyEvent.ledgerId), {
      trustedKeyIds: [topologyAuthority.keyId],
      requireTrustedAuthority: true,
      expectedLedgerId: legacyEvent.ledgerId,
    });
    assert.match(verified.reason, /Adopt existing/u);

    await ledger.ingestBatch([event({
      ledgerId: legacyEvent.ledgerId,
      eventId: "legacy-event-2",
      payload: { name: "Second legacy-stream event" },
    })]);
    const appended = await verifySegment(segmentPath(directory, legacyEvent.ledgerId, {
      legacy: true,
      segmentNumber: 1,
    }));
    assert.equal(appended.formatVersion, 1);
    await assert.rejects(
      stat(segmentPath(directory, legacyEvent.ledgerId)),
      (error) => error.code === "ENOENT",
    );

    const transition = await ledger.transitionRouting({
      ledgerId: legacyEvent.ledgerId,
      shardCount: 2,
      reason: "Move adopted history to epoch-aware segments",
      expectedCurrentEpoch: 0,
    });
    const epochOneEvent = event({
      ledgerId: legacyEvent.ledgerId,
      eventId: "legacy-event-epoch-one",
      subject: "legacy:epoch-one",
      payload: { name: "First epoch-aware event" },
    });
    await ledger.ingestBatch([epochOneEvent]);
    const epochOneRoute = routeEvent(epochOneEvent, createRoutingPolicy(2));
    const epochOneSegment = await verifySegment(segmentPath(directory, legacyEvent.ledgerId, {
      epochNumber: 1,
      shardId: epochOneRoute.shardId,
    }), {
      expectedRoutingEpochHash: fromHex(transition.epochHash, 32),
    });
    assert.equal(epochOneSegment.formatVersion, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("startup refuses legacy history adoption unless it is explicitly enabled", async () => {
  const directory = await mkdtemp(join(tmpdir(), "g9p-ledger-migration-disabled-"));
  const signer = generateSigner();
  const topologyAuthority = generateSigner();
  try {
    const legacyEvent = await writeLegacyHistory(directory, signer);
    await assert.rejects(
      new LocalLedger({ dataDirectory: directory, signer, topologyAuthority }).initialize(),
      (error) => error.code === "LEDGER_ROUTING_HISTORY_MISSING",
    );
    await assert.rejects(
      stat(routingEpochPath(directory, legacyEvent.ledgerId)),
      (error) => error.code === "ENOENT",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ingestion requires the configured bearer token", async () => {
  await fixture(async ({ service }) => {
    const address = service.server.address();
    const unauthorised = new ProvenanceClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "wrong-token",
    });
    await assert.rejects(
      unauthorised.submitBatch([event()]),
      (error) => error instanceof ProvenanceServiceError && error.status === 401,
    );
    await assert.rejects(
      unauthorised.getReceipt("event-001", "a".repeat(64)),
      (error) => error instanceof ProvenanceServiceError && error.status === 401,
    );
  });
});
