import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { generateSigner, verifyCheckpoint, verifyThresholdAttestation, verifyWitnessReceipt, writeCheckpoint, writeWitnessReceipt } from "../src/index.js";

const time = "2026-07-30T18:00:00.000Z";

async function temporary(run) {
  const directory = await mkdtemp(join(tmpdir(), "g9p-checkpoint-"));
  try { return await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test("checkpoint and independent witness receipts satisfy a distinct threshold", async () => {
  await temporary(async (directory) => {
    const publisher = generateSigner();
    const witnesses = [generateSigner(), generateSigner()];
    const checkpointPath = join(directory, "checkpoint-000000.g9p");
    const written = await writeCheckpoint({
      outputPath: checkpointPath,
      ledgerId: "checkpoint-ledger",
      checkpointNumber: 0,
      routingEpochNumber: 2,
      routingEpochHash: Buffer.alloc(32, 2),
      shardHeads: [
        { epochNumber: 2, shardId: "shard-0000", segmentNumber: 4, segmentHash: Buffer.alloc(32, 4) },
        { epochNumber: 2, shardId: "shard-0001", segmentNumber: null, segmentHash: null },
      ],
      publisher,
      createdAt: time,
    });
    const verified = await verifyCheckpoint(checkpointPath, { trustedKeyIds: [publisher.keyId], requireTrustedSigner: true });
    assert.equal(verified.checkpointHash, written.checkpointHash);
    assert.equal(verified.shardHeads.length, 2);

    const checkpointBytes = await readFile(checkpointPath);
    const receiptBytes = [];
    for (let index = 0; index < witnesses.length; index += 1) {
      const path = join(directory, `witness-${index}.g9p`);
      await writeWitnessReceipt({ outputPath: path, checkpointBytes, witness: witnesses[index], observedAt: time, trustedPublisherKeyIds: [publisher.keyId] });
      const receipt = await verifyWitnessReceipt(path, { trustedKeyIds: [witnesses[index].keyId], requireTrustedSigner: true });
      assert.equal(receipt.checkpointHash, written.checkpointHash);
      receiptBytes.push(await readFile(path));
    }

    const witnessKeyIds = witnesses.map((witness) => witness.keyId).sort();
    const threshold = await verifyThresholdAttestation({
      checkpointBytes,
      witnessReceiptBytes: receiptBytes,
      trustedPublisherKeyIds: [publisher.keyId],
      policy: { kind: "g9p-threshold-policy", version: 1, threshold: 2, witnessKeyIds },
    });
    assert.equal(threshold.witnessCount, 2);

    await assert.rejects(
      verifyThresholdAttestation({
        checkpointBytes,
        witnessReceiptBytes: [receiptBytes[0], receiptBytes[0]],
        trustedPublisherKeyIds: [publisher.keyId],
        policy: { kind: "g9p-threshold-policy", version: 1, threshold: 2, witnessKeyIds },
      }),
      (error) => error.code === "THRESHOLD_NOT_MET",
    );
  });
});

test("checkpoint and witness signature mutation is rejected", async () => {
  await temporary(async (directory) => {
    const publisher = generateSigner();
    const checkpointPath = join(directory, "checkpoint.g9p");
    await writeCheckpoint({ outputPath: checkpointPath, ledgerId: "mutation-ledger", checkpointNumber: 0, routingEpochNumber: 0, routingEpochHash: Buffer.alloc(32), shardHeads: [{ epochNumber: 0, shardId: "shard-0000", segmentNumber: null, segmentHash: null }], publisher, createdAt: time });
    const bytes = await readFile(checkpointPath);
    const marker = bytes.indexOf(Buffer.from("SIG1"));
    bytes[marker + 8 + bytes.readUInt32BE(marker + 4) - 1] ^= 1;
    await assert.rejects(import("../src/checkpoint.js").then(({ verifyCheckpointBytes }) => verifyCheckpointBytes(bytes)), (error) => error.code === "CHECKPOINT_SIGNATURE");
  });
});
