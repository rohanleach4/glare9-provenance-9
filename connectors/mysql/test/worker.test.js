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
  status: "accepted",
  ledgerId: "ledger-1",
  recordHash: "a".repeat(64),
  intakeSequence: 12,
  acceptedAt: "2026-07-30T12:00:00.000Z",
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
    provenanceClient: { submitAcceptedBatch: async () => [receipt] },
    connectorId: "connector-1",
    logger: { error: () => {} },
  });

  assert.equal(await worker.runOnce(), 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].receipts[0].status, "accepted");
  assert.equal(calls[0].receipts[0].recordHash, receipt.recordHash);
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
    provenanceClient: { submitAcceptedBatch: async () => { throw error; } },
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
    provenanceClient: { submitAcceptedBatch: async () => assert.fail("submitAcceptedBatch should not be called") },
    connectorId: "connector-1",
    logger: { error: () => {} },
  });

  assert.equal(await worker.runOnce(), 0);
  assert.equal(failure.error.code, "OUTBOX_EVENT_ID_MISMATCH");
  assert.equal(failure.error.retryable, false);
});

test("connector loop diagnostics omit arbitrary exception messages", async () => {
  const sentinel = "DO-NOT-LOG-credential-or-event-payload";
  const logs = [];
  const controller = new AbortController();
  const worker = new MySqlConnectorWorker({
    repository: {
      claimBatch: async () => { throw new Error(sentinel); },
    },
    provenanceClient: {},
    connectorId: "connector-1",
    pollIntervalMs: 1,
    logger: {
      error: (...values) => {
        logs.push(values);
        controller.abort();
      },
    },
  });
  await worker.run(controller.signal);
  assert.equal(JSON.stringify(logs).includes(sentinel), false);
  assert.equal(worker.snapshot().lastErrorCode, "CONNECTOR_LOOP_FAILED");
});

test("worker delivers application-schema payloads opaquely through the shared envelope", async () => {
  const opaqueEnvelope = {
    version: 1,
    eventId: "schema-neutral-event",
    ledgerId: "schema-neutral-ledger",
    subject: "customer-defined:subject",
    type: "customer.future.event.type",
    schemaVersion: 987,
    occurredAt: "2026-07-30T12:00:00.000Z",
    recordedAt: "2026-07-30T12:00:00.000Z",
    source: { kind: "outbox", identity: "customer-application" },
    payload: {
      customerDefinedObject: { arbitrary: [1, true, "future-value"] },
      fieldsUnknownToConnector: "must remain untouched",
    },
  };
  let submitted;
  const repository = {
    claimBatch: async () => [{ ...claimed[0], eventId: opaqueEnvelope.eventId, envelope: opaqueEnvelope }],
    markDelivered: async () => {},
    markFailed: async () => assert.fail("schema-neutral envelope should be delivered"),
  };
  const worker = new MySqlConnectorWorker({
    repository,
    provenanceClient: {
      submitAcceptedBatch: async (events) => {
        submitted = structuredClone(events);
        return [{ ...receipt, eventId: opaqueEnvelope.eventId, ledgerId: opaqueEnvelope.ledgerId }];
      },
    },
    connectorId: "connector-1",
    logger: { error: () => {} },
  });
  assert.equal(await worker.runOnce(), 1);
  assert.deepEqual(submitted, [opaqueEnvelope]);
});
