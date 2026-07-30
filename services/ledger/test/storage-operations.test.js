import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  generateSigner,
  LocalFilesystemSealedStorage,
  verifyRoutingEpochBytes,
  verifySegmentBytes,
} from "@glare9/provenance";

import { LocalLedger } from "../src/local-ledger.js";

const timestamp = "2026-07-30T14:00:00.000Z";

function evidence(index) {
  return {
    version: 1,
    eventId: `recovery-event-${index.toString().padStart(4, "0")}`,
    ledgerId: "recovery-ledger",
    subject: `model:recovery-${index % 2}`,
    type: "test.recovery.recorded",
    schemaVersion: 1,
    occurredAt: timestamp,
    recordedAt: timestamp,
    source: { kind: "semantic", identity: "recovery-exercise" },
    payload: { index, immutableEvidence: "backup-restore-retention" },
  };
}

const lifecycle = {
  blockMaxBytes: 1024 * 1024,
  blockMaxRecords: 2,
  segmentMaxBytes: 4 * 1024 * 1024,
  segmentMaxRecords: 2,
  segmentMaxAgeMs: 30_000,
  maxAcceptedEvents: 100,
  maxAcceptedBytes: 16 * 1024 * 1024,
  maxActiveBlockBytes: 4 * 1024 * 1024,
};

async function copyExactObjects(source, destination) {
  const copied = new Map();
  for (const prefix of ["routing/", "segments/"]) {
    for (const key of await source.list(prefix)) {
      const bytes = await source.read(key);
      copied.set(key, Uint8Array.from(bytes));
      await destination.publish(key, bytes);
    }
  }
  return copied;
}

async function assertExactObjects(storage, expected) {
  const keys = [
    ...await storage.list("routing/"),
    ...await storage.list("segments/"),
  ].sort();
  assert.deepEqual(keys, [...expected.keys()].sort());
  for (const [key, bytes] of expected) {
    assert.deepEqual(Buffer.from(await storage.read(key)), Buffer.from(bytes), `sealed bytes changed for ${key}`);
  }
}

test("backup, retention archive and disaster restore preserve every sealed byte", async () => {
  const root = await mkdtemp(join(tmpdir(), "g9p-storage-operations-"));
  const primaryDirectory = join(root, "primary");
  const backupDirectory = join(root, "retention-archive");
  const restoredDirectory = join(root, "restored");
  const signer = generateSigner();
  const topologyAuthority = generateSigner();
  const events = [evidence(0), evidence(1), evidence(2)];
  try {
    const ledger = await new LocalLedger({
      dataDirectory: primaryDirectory,
      signer,
      topologyAuthority,
      lifecycle,
    }).initialize();
    const originalReceipts = await ledger.ingestBatch(events);
    await ledger.close({ seal: false });

    const primary = new LocalFilesystemSealedStorage(primaryDirectory);
    const backup = new LocalFilesystemSealedStorage(backupDirectory);
    await primary.initialize();
    await backup.initialize();
    const snapshot = await copyExactObjects(primary, backup);
    assert.equal((await primary.list("segments/")).length, 2);
    assert.equal((await primary.list("routing/")).length, 1);
    await assertExactObjects(primary, snapshot);
    await assertExactObjects(backup, snapshot);

    for (const key of await backup.list("segments/")) {
      const verified = await verifySegmentBytes(await backup.read(key), {
        trustedKeyIds: [signer.keyId],
        requireTrustedSigner: true,
      });
      assert.equal(verified.valid, true);
    }
    for (const key of await backup.list("routing/")) {
      const verified = await verifyRoutingEpochBytes(await backup.read(key), {
        trustedKeyIds: [topologyAuthority.keyId],
        requireTrustedAuthority: true,
      });
      assert.equal(verified.valid, true);
    }

    await rm(primaryDirectory, { recursive: true, force: true });
    const restored = new LocalFilesystemSealedStorage(restoredDirectory);
    await restored.initialize();
    await copyExactObjects(backup, restored);
    await assertExactObjects(restored, snapshot);

    const rebuilt = await new LocalLedger({
      dataDirectory: restoredDirectory,
      signer,
      topologyAuthority,
      lifecycle,
    }).initialize();
    assert.equal(rebuilt.info().knownEvents, events.length);
    assert.equal(rebuilt.info().acceptedEvents, 0);
    assert.deepEqual(await rebuilt.ingestBatch(events), originalReceipts);
    await rebuilt.close({ seal: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
