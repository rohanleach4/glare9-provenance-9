import assert from "node:assert/strict";
import test from "node:test";

const timestamp = "2026-07-30T12:00:00.000Z";

function event(index) {
  return {
    version: 1,
    eventId: `contract-event-${index}`,
    ledgerId: "connector-contract-ledger",
    subject: `contract:subject-${index}`,
    type: "test.connector.contract",
    schemaVersion: 1,
    occurredAt: timestamp,
    recordedAt: timestamp,
    source: { kind: "outbox", identity: "connector-contract-test" },
    payload: { sequence: index },
  };
}

async function withHarness(createHarness, run) {
  const harness = await createHarness();
  try {
    await run(harness);
  } finally {
    await harness.close?.();
  }
}

export function registerConnectorContractTests({ connectorName, createHarness }) {
  if (typeof connectorName !== "string" || connectorName.length === 0) {
    throw new TypeError("connectorName must be a non-empty string");
  }
  if (typeof createHarness !== "function") {
    throw new TypeError("createHarness must be a function");
  }

  test(`${connectorName} contract: preserves source order through delivery`, async () => {
    await withHarness(createHarness, async (harness) => {
      const events = [event(1), event(2), event(3)];
      await harness.enqueue(events);
      assert.equal(await harness.deliverOnce(), events.length);
      assert.deepEqual(harness.submittedEventIds(), events.map((item) => item.eventId));
      for (const item of events) assert.equal(harness.state(item.eventId).status, "delivered");
    });
  });

  test(`${connectorName} contract: restart waits for lease expiry and safely redelivers an uncertain acceptance`, async () => {
    await withHarness(createHarness, async (harness) => {
      const item = event(10);
      await harness.enqueue([item]);
      harness.injectDeliveryCommitFailure();
      await assert.rejects(harness.deliverOnce(), (error) => error.code === "DATABASE_UNAVAILABLE");
      assert.equal(harness.state(item.eventId).status, "leased");

      harness.restoreStorage();
      harness.restart();
      assert.equal(await harness.deliverOnce(), 0);
      harness.expireLeases();
      assert.equal(await harness.deliverOnce(), 1);
      assert.deepEqual(harness.submittedEventIds(), [item.eventId, item.eventId]);
      assert.equal(harness.state(item.eventId).status, "delivered");
    });
  });

  test(`${connectorName} contract: quarantines permanent ledger rejection without retry`, async () => {
    await withHarness(createHarness, async (harness) => {
      const item = event(20);
      await harness.enqueue([item]);
      harness.injectLedgerFailure(Object.assign(new Error("Permanent rejection"), {
        code: "EVENT_ID_CONFLICT",
        retryable: false,
      }));
      assert.equal(await harness.deliverOnce(), 0);
      const state = harness.state(item.eventId);
      assert.equal(state.status, "quarantined");
      assert.equal(state.lastErrorCode, "EVENT_ID_CONFLICT");
      assert.equal(await harness.deliverOnce(), 0);
      assert.deepEqual(harness.submittedEventIds(), [item.eventId]);
    });
  });

  test(`${connectorName} contract: reconciles monotonic finality and rejects content conflicts`, async () => {
    await withHarness(createHarness, async (harness) => {
      const item = event(30);
      await harness.enqueue([item]);
      assert.equal(await harness.deliverOnce(), 1);
      const stored = harness.state(item.eventId).receipt;
      const sealed = {
        eventId: item.eventId,
        status: "sealed",
        ledgerId: item.ledgerId,
        recordHash: stored.recordHash,
        shardId: "shard-0000",
        routingEpochNumber: 0,
        segmentNumber: 0,
        recordIndex: 0,
        segmentHash: "b".repeat(64),
        signerKeyId: "c".repeat(64),
      };
      const reconciled = harness.reconcile(item.eventId, sealed);
      assert.equal(reconciled.advanced, true);
      assert.equal(reconciled.receipt.status, "sealed");
      assert.throws(
        () => harness.reconcile(item.eventId, { ...sealed, recordHash: "f".repeat(64) }),
        (error) => error.code === "RECEIPT_RECONCILIATION_CONFLICT" && error.retryable === false,
      );
    });
  });
}
