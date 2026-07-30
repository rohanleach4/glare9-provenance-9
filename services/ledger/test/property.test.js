import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { generateSigner } from "@glare9/provenance";

import { LocalLedger } from "../src/local-ledger.js";

const timestamp = "2026-07-30T12:00:00.000Z";

function event(index) {
  return {
    version: 1,
    eventId: `idempotency-property-${index}`,
    ledgerId: "idempotency-property-ledger",
    subject: `property:subject-${index % 5}`,
    type: "test.idempotency.property",
    schemaVersion: 1,
    occurredAt: timestamp,
    recordedAt: timestamp,
    source: { kind: "outbox", identity: "property-test" },
    payload: { index, opaque: { value: index * 17 } },
  };
}

test("property: idempotent batches retain one event identity before and after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "g9p-idempotency-property-"));
  const signer = generateSigner();
  const topologyAuthority = generateSigner();
  const events = Array.from({ length: 30 }, (_, index) => event(index));
  const options = {
    dataDirectory: directory,
    signer,
    topologyAuthority,
    shardCount: 4,
    lifecycle: {
      blockMaxBytes: 1024 * 1024,
      blockMaxRecords: 5,
      segmentMaxBytes: 4 * 1024 * 1024,
      segmentMaxRecords: 15,
      segmentMaxAgeMs: 60_000,
      maxAcceptedEvents: 100,
      maxAcceptedBytes: 16 * 1024 * 1024,
      maxActiveBlockBytes: 4 * 1024 * 1024,
    },
  };
  try {
    const ledger = await new LocalLedger(options).initialize();
    const first = await ledger.ingestAcceptedBatch(events);
    const repeated = await Promise.all([
      ledger.ingestAcceptedBatch(events.slice(0, 10)),
      ledger.ingestAcceptedBatch(events.slice(10, 20)),
      ledger.ingestAcceptedBatch(events.slice(20)),
    ]);
    assert.deepEqual(repeated.flat().map((receipt) => receipt.recordHash), first.map((receipt) => receipt.recordHash));
    await ledger.drainAccepted();
    assert.equal(ledger.info().knownEvents, events.length);
    await ledger.close({ seal: false });

    const rebuilt = await new LocalLedger(options).initialize();
    try {
      const replayed = await rebuilt.ingestBatch([...events].reverse());
      assert.equal(rebuilt.info().knownEvents, events.length);
      assert.ok(replayed.every((receipt) => receipt.status === "sealed"));
      assert.deepEqual(replayed.map((receipt) => receipt.eventId), [...events].reverse().map((item) => item.eventId));
    } finally {
      await rebuilt.close({ seal: false });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
