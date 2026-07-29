import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createRoutingPolicy,
  domainHash,
  generateSigner,
  toHex,
  verifyRoutingEpoch,
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
  const service = createLedgerServer({ ledger, apiToken: "test-ledger-token" });
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
  await fixture(async ({ client, ledger }) => {
    const first = await client.submitBatch([event()]);
    const repeated = await client.submitBatch([event()]);

    assert.equal(first[0].status, "sealed");
    assert.equal(first[0].segmentNumber, 0);
    assert.deepEqual(repeated, first);
    assert.equal(ledger.info().knownEvents, 1);
    assert.equal(ledger.info().knownRoutingLedgers, 1);
  });
});

test("first ingestion creates and trusts a signed genesis routing epoch", async () => {
  await fixture(async ({ directory, topologyAuthority, client }) => {
    await client.submitBatch([event()]);
    const path = routingEpochPath(directory, "connector-test-ledger");
    assert.equal((await stat(path)).isFile(), true);
    const verified = await verifyRoutingEpoch(path, {
      trustedKeyIds: [topologyAuthority.keyId],
      requireTrustedAuthority: true,
      expectedLedgerId: "connector-test-ledger",
      expectedEpochNumber: 0,
    });
    assert.equal(verified.routingPolicy.shardCount, 1);
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
