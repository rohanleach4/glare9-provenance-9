import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createRoutingPolicy,
  generateSigner,
  verifyCheckpoint,
  verifyRoutingEpoch,
  verifySegment,
  verifyWitnessReceipt,
  writeCheckpoint,
  writeRoutingEpoch,
  writeSegment,
  writeWitnessReceipt,
} from "../src/index.js";

const fixedTime = "2026-08-19T12:00:00.000Z";

async function temporary(run) {
  const directory = await mkdtemp(join(tmpdir(), "g9p-pluggable-signer-"));
  try { return await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

function callbackOnlySigner(localSigner, calls) {
  return {
    algorithm: localSigner.algorithm,
    keyId: localSigner.keyId,
    publicKeyDer: Uint8Array.from(localSigner.publicKeyDer),
    async sign(messageBytes) {
      calls.push(Buffer.from(messageBytes));
      return localSigner.sign(messageBytes);
    },
  };
}

function event() {
  return {
    version: 1,
    eventId: "remote-signing-event",
    ledgerId: "remote-signing-ledger",
    subject: "model:remote-signing",
    type: "ai.assessment.recorded",
    schemaVersion: 1,
    occurredAt: fixedTime,
    recordedAt: fixedTime,
    source: { kind: "semantic", identity: "test:remote-signer" },
    payload: { result: "pass" },
  };
}

test("callback-only signers seal segments without exposing a private key", async () => {
  await temporary(async (directory) => {
    const calls = [];
    const signer = callbackOnlySigner(generateSigner(), calls);
    assert.equal(Object.hasOwn(signer, "privateKey"), false);
    const path = join(directory, "segment-000000.g9p");
    await writeSegment({
      outputPath: path,
      events: [event()],
      routingPolicy: createRoutingPolicy(1),
      segmentNumber: 0,
      signer,
      createdAt: fixedTime,
      blockTargetBytes: 1024,
    });
    const verified = await verifySegment(path, { trustedKeyIds: [signer.keyId], requireTrustedSigner: true });
    assert.equal(verified.valid, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].byteLength, 32);
  });
});

test("callback-only authorities sign routing, checkpoints and witness receipts", async () => {
  await temporary(async (directory) => {
    const authorityCalls = [];
    const publisherCalls = [];
    const witnessCalls = [];
    const authority = callbackOnlySigner(generateSigner(), authorityCalls);
    const publisher = callbackOnlySigner(generateSigner(), publisherCalls);
    const witness = callbackOnlySigner(generateSigner(), witnessCalls);

    const epochPath = join(directory, "epoch-000000.g9p");
    await writeRoutingEpoch({ outputPath: epochPath, ledgerId: "remote-signing-ledger", epochNumber: 0, routingPolicy: createRoutingPolicy(1), topologyAuthority: authority, reason: "Initial topology", createdAt: fixedTime });
    assert.equal((await verifyRoutingEpoch(epochPath, { trustedKeyIds: [authority.keyId], requireTrustedAuthority: true })).valid, true);

    const checkpointPath = join(directory, "checkpoint-000000.g9p");
    await writeCheckpoint({ outputPath: checkpointPath, ledgerId: "remote-signing-ledger", checkpointNumber: 0, routingEpochNumber: 0, routingEpochHash: Buffer.alloc(32, 1), shardHeads: [{ epochNumber: 0, shardId: "shard-0000", segmentNumber: null, segmentHash: null }], publisher, createdAt: fixedTime });
    assert.equal((await verifyCheckpoint(checkpointPath, { trustedKeyIds: [publisher.keyId], requireTrustedSigner: true })).valid, true);

    const witnessPath = join(directory, "witness-000000.g9p");
    await writeWitnessReceipt({ outputPath: witnessPath, checkpointBytes: await readFile(checkpointPath), witness, observedAt: fixedTime, trustedPublisherKeyIds: [publisher.keyId] });
    assert.equal((await verifyWitnessReceipt(witnessPath, { trustedKeyIds: [witness.keyId], requireTrustedSigner: true })).valid, true);
    assert.deepEqual([authorityCalls.length, publisherCalls.length, witnessCalls.length], [1, 1, 1]);
  });
});

test("a custody signature that does not match its public key fails before publication", async () => {
  await temporary(async (directory) => {
    const localSigner = generateSigner();
    const signer = { algorithm: localSigner.algorithm, keyId: localSigner.keyId, publicKeyDer: localSigner.publicKeyDer, async sign() { return Buffer.alloc(64); } };
    const path = join(directory, "invalid.g9p");
    await assert.rejects(writeSegment({ outputPath: path, events: [event()], routingPolicy: createRoutingPolicy(1), segmentNumber: 0, signer, createdAt: fixedTime, blockTargetBytes: 1024 }), (error) => error.code === "SIGNER_SIGNATURE");
    await assert.rejects(stat(path), (error) => error.code === "ENOENT");
  });
});
