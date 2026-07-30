import assert from "node:assert/strict";
import test from "node:test";

import { reconcileLifecycleReceipt } from "../src/index.js";

const accepted = {
  eventId: "reconciliation-event",
  status: "accepted",
  ledgerId: "reconciliation-ledger",
  recordHash: "a".repeat(64),
  intakeSequence: 7,
  acceptedAt: "2026-07-30T12:00:00.000Z",
};

const sealed = {
  eventId: accepted.eventId,
  status: "sealed",
  ledgerId: accepted.ledgerId,
  recordHash: accepted.recordHash,
  shardId: "shard-0000",
  routingEpochNumber: 0,
  segmentNumber: 1,
  recordIndex: 2,
  segmentHash: "b".repeat(64),
  signerKeyId: "c".repeat(64),
};

test("receipt reconciliation accepts equal identity and monotonic finality", () => {
  assert.deepEqual(reconcileLifecycleReceipt(accepted, accepted), {
    advanced: false,
    receipt: accepted,
  });
  assert.deepEqual(reconcileLifecycleReceipt(accepted, sealed), {
    advanced: true,
    receipt: sealed,
  });
});

test("receipt reconciliation rejects identity, content and lifecycle regressions", () => {
  for (const current of [
    { ...sealed, eventId: "other-event" },
    { ...sealed, ledgerId: "other-ledger" },
    { ...sealed, recordHash: "f".repeat(64) },
  ]) {
    assert.throws(
      () => reconcileLifecycleReceipt(accepted, current),
      (error) => error.code === "RECEIPT_RECONCILIATION_CONFLICT" && error.retryable === false,
    );
  }
  assert.throws(
    () => reconcileLifecycleReceipt(sealed, accepted),
    (error) => error.code === "RECEIPT_RECONCILIATION_CONFLICT" && error.retryable === false,
  );
});
