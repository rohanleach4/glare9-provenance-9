import assert from "node:assert/strict";
import test from "node:test";

import { MySqlConnectorWorker } from "../src/worker.js";

const claimed = [{
  sequenceId: "1",
  eventId: "event-1",
  envelope: { eventId: "event-1", ledgerId: "ledger-1" },
  attemptCount: 1,
  leaseToken: "lease-1",
}];

const receipt = {
  eventId: "event-1",
  status: "sealed",
  ledgerId: "ledger-1",
  shardId: "shard-0000",
  segmentNumber: 0,
  recordIndex: 0,
  recordHash: "a".repeat(64),
  segmentHash: "b".repeat(64),
  signerKeyId: "c".repeat(64),
};

test("worker delivers leased rows and records receipts", async () => {
  const calls = [];
  const repository = {
    claimBatch: async () => claimed,
    markDelivered: async (items, receipts) => calls.push({ items, receipts }),
    markFailed: async () => assert.fail("markFailed should not be called"),
  };
  const worker = new MySqlConnectorWorker({
    repository,
    provenanceClient: { submitBatch: async () => [receipt] },
    connectorId: "connector-1",
    logger: { error: () => {} },
  });

  assert.equal(await worker.runOnce(), 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].receipts[0].segmentHash, receipt.segmentHash);
  assert.equal(worker.snapshot().deliveredEvents, 1);
});

test("worker releases failed deliveries with exponential backoff metadata", async () => {
  let failure;
  const error = Object.assign(new Error("Ledger unavailable"), {
    code: "LEDGER_UNAVAILABLE",
    retryable: true,
  });
  const repository = {
    claimBatch: async () => [{ ...claimed[0], attemptCount: 3 }],
    markDelivered: async () => assert.fail("markDelivered should not be called"),
    markFailed: async (items, receivedError, options) => {
      failure = { items, receivedError, options };
    },
  };
  const worker = new MySqlConnectorWorker({
    repository,
    provenanceClient: { submitBatch: async () => { throw error; } },
    connectorId: "connector-1",
    retryBaseMs: 1_000,
    retryMaxMs: 60_000,
    logger: { error: () => {} },
  });

  assert.equal(await worker.runOnce(), 0);
  assert.equal(failure.receivedError, error);
  assert.equal(failure.options.retryDelayMs, 4_000);
  assert.equal(worker.snapshot().failedBatches, 1);
});

test("worker dead-letters an outbox envelope whose event ID does not match", async () => {
  let failure;
  const repository = {
    claimBatch: async () => [{
      ...claimed[0],
      envelope: { eventId: "wrong-event", ledgerId: "ledger-1" },
    }],
    markDelivered: async () => assert.fail("markDelivered should not be called"),
    markFailed: async (items, error) => {
      failure = { items, error };
    },
  };
  const worker = new MySqlConnectorWorker({
    repository,
    provenanceClient: { submitBatch: async () => assert.fail("submitBatch should not be called") },
    connectorId: "connector-1",
    logger: { error: () => {} },
  });

  assert.equal(await worker.runOnce(), 0);
  assert.equal(failure.error.code, "OUTBOX_EVENT_ID_MISMATCH");
  assert.equal(failure.error.retryable, false);
});
