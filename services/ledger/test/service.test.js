import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { generateSigner } from "@glare9/provenance";
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

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), "g9p-ledger-service-"));
  const signer = generateSigner();
  const ledger = await new LocalLedger({ dataDirectory: directory, signer }).initialize();
  const service = createLedgerServer({ ledger, apiToken: "test-ledger-token" });
  const address = await service.listen({ host: "127.0.0.1", port: 0 });
  const client = new ProvenanceClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    token: "test-ledger-token",
  });
  try {
    return await run({ directory, signer, ledger, service, client });
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

test("ledger rebuilds its event index from verified segments", async () => {
  await fixture(async ({ directory, signer, client }) => {
    const [receipt] = await client.submitBatch([event()]);
    const rebuilt = await new LocalLedger({ dataDirectory: directory, signer }).initialize();
    assert.equal(rebuilt.info().knownEvents, 1);
    const [replayedReceipt] = await rebuilt.ingestBatch([event()]);
    assert.deepEqual(replayedReceipt, receipt);
  });
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
