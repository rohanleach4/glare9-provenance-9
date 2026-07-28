import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createRoutingPolicy,
  fromHex,
  generateSigner,
  verifySegment,
  writeSegment,
} from "../src/index.js";

const fixedTime = "2026-07-28T12:00:00.000Z";

function events(count = 4, ledgerId = "test-ledger") {
  return Array.from({ length: count }, (_, index) => ({
    version: 1,
    eventId: `event-${index.toString().padStart(4, "0")}`,
    ledgerId,
    subject: "model:test-model",
    type: index === 0 ? "ai.model.registered" : "ai.assessment.recorded",
    schemaVersion: 1,
    occurredAt: fixedTime,
    recordedAt: fixedTime,
    source: { kind: "semantic", identity: "test:operator" },
    payload: {
      index,
      repeatedEvidence: "governance-evidence-".repeat(60),
    },
  }));
}

async function withTemporaryDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), "g9p-test-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function createSegment(directory, overrides = {}) {
  const signer = overrides.signer ?? generateSigner();
  const path = overrides.path ?? join(directory, "segment-000000.g9p");
  const result = await writeSegment({
    outputPath: path,
    events: overrides.events ?? events(),
    routingPolicy: createRoutingPolicy(1),
    segmentNumber: overrides.segmentNumber ?? 0,
    previousSegmentHash: overrides.previousSegmentHash ?? null,
    signer,
    createdAt: fixedTime,
    blockTargetBytes: 1024,
  });
  return { path, result, signer };
}

test("writer creates a sealed segment and removes its provisional name", async () => {
  await withTemporaryDirectory(async (directory) => {
    const { path, result, signer } = await createSegment(directory);
    const sealedStat = await stat(path);
    assert.equal(sealedStat.isFile(), true);
    await assert.rejects(stat(`${path}.part`), (error) => error.code === "ENOENT");
    assert.equal(result.recordCount, 4);
    assert.ok(result.blockCount > 1);

    const verified = await verifySegment(path, {
      trustedKeyIds: new Set([signer.keyId]),
      requireTrustedSigner: true,
      expectedPreviousSegmentHash: null,
      expectedLedgerId: "test-ledger",
      expectedShardId: "shard-0000",
    });
    assert.equal(verified.valid, true);
    assert.equal(verified.signerTrusted, true);
    assert.equal(verified.recordCount, 4);
    assert.equal(verified.events.length, 4);
    assert.equal(verified.segmentHash, result.segmentHash);
    assert.equal(verified.logicalRoot, result.logicalRoot);
  });
});

test("embedded keys prove self-consistency but are not trusted automatically", async () => {
  await withTemporaryDirectory(async (directory) => {
    const { path } = await createSegment(directory);
    const result = await verifySegment(path, { includeEvents: false });
    assert.equal(result.valid, true);
    assert.equal(result.signerTrusted, false);
    assert.equal(result.trustStatus, "untrusted-embedded-key");

    await assert.rejects(
      verifySegment(path, { requireTrustedSigner: true }),
      (error) => error.code === "VERIFY_UNTRUSTED_SIGNER",
    );
  });
});

test("segments link to the exact hash of the preceding sealed file", async () => {
  await withTemporaryDirectory(async (directory) => {
    const signer = generateSigner();
    const first = await createSegment(directory, { signer });
    const second = await createSegment(directory, {
      signer,
      path: join(directory, "segment-000001.g9p"),
      segmentNumber: 1,
      previousSegmentHash: fromHex(first.result.segmentHash, 32),
      events: events(2),
    });

    const verified = await verifySegment(second.path, {
      expectedPreviousSegmentHash: fromHex(first.result.segmentHash, 32),
    });
    assert.equal(verified.previousSegmentHash, first.result.segmentHash);

    await assert.rejects(
      verifySegment(second.path, { expectedPreviousSegmentHash: Buffer.alloc(32, 9) }),
      (error) => error.code === "VERIFY_PREVIOUS_SEGMENT",
    );
  });
});

test("altering a stored block is detected", async () => {
  await withTemporaryDirectory(async (directory) => {
    const { path } = await createSegment(directory);
    const tamperedPath = join(directory, "tampered-block.g9p");
    await copyFile(path, tamperedPath);
    const bytes = await readFile(tamperedPath);
    const blockMarker = bytes.indexOf(Buffer.from("BLK1", "ascii"));
    assert.ok(blockMarker > 0);
    const payloadLength = bytes.readUInt32BE(blockMarker + 4);
    const mutationOffset = blockMarker + 8 + payloadLength - 1;
    bytes[mutationOffset] ^= 0x01;
    await writeFile(tamperedPath, bytes);

    await assert.rejects(
      verifySegment(tamperedPath),
      (error) => error.code === "VERIFY_BLOCK_HASH",
    );
  });
});

test("altering the segment signature is detected", async () => {
  await withTemporaryDirectory(async (directory) => {
    const { path } = await createSegment(directory);
    const tamperedPath = join(directory, "tampered-signature.g9p");
    const bytes = await readFile(path);
    const signatureMarker = bytes.indexOf(Buffer.from("SIG1", "ascii"));
    assert.ok(signatureMarker > 0);
    const payloadLength = bytes.readUInt32BE(signatureMarker + 4);
    bytes[signatureMarker + 8 + payloadLength - 1] ^= 0x01;
    await writeFile(tamperedPath, bytes);

    await assert.rejects(
      verifySegment(tamperedPath),
      (error) => error.code === "VERIFY_SIGNATURE",
    );
  });
});

test("truncated segments are rejected", async () => {
  await withTemporaryDirectory(async (directory) => {
    const { path } = await createSegment(directory);
    const truncatedPath = join(directory, "truncated.g9p");
    const bytes = await readFile(path);
    await writeFile(truncatedPath, bytes.subarray(0, bytes.length - 5));

    await assert.rejects(
      verifySegment(truncatedPath),
      (error) => error.code === "FORMAT_TRUNCATED",
    );
  });
});

test("sealed paths are never overwritten", async () => {
  await withTemporaryDirectory(async (directory) => {
    const first = await createSegment(directory);
    const original = await readFile(first.path);

    await assert.rejects(
      createSegment(directory, { path: first.path, signer: first.signer }),
      (error) => error.code === "SEGMENT_WRITE",
    );
    assert.deepEqual(await readFile(first.path), original);
  });
});
