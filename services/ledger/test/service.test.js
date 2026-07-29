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

async function fixture(run, { shardCount = 1 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "g9p-ledger-service-"));
  const signer = generateSigner();
  const topologyAuthority = generateSigner();
  const ledger = await new LocalLedger({ dataDirectory: directory, signer, topologyAuthority, shardCount }).initialize();
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
    await rm(directory, { recursive: true, force: true });
  }
}

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
  });
});
