import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createRoutingPolicy,
  fromHex,
  generateSigner,
  verifyRoutingEpoch,
  writeRoutingEpoch,
} from "../src/index.js";

const fixedTime = "2026-07-29T12:00:00.000Z";

async function withTemporaryDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), "g9p-routing-epoch-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function writeGenesis(directory, overrides = {}) {
  const topologyAuthority = overrides.topologyAuthority ?? generateSigner();
  const path = overrides.path ?? join(directory, "epoch-000000.g9p");
  const result = await writeRoutingEpoch({
    outputPath: path,
    ledgerId: "routing-test-ledger",
    epochNumber: 0,
    routingPolicy: createRoutingPolicy(2),
    topologyAuthority,
    reason: "Initial routing topology",
    createdAt: fixedTime,
    ...overrides,
  });
  return { path, result, topologyAuthority };
}

test("writer creates a sealed, trusted genesis routing epoch", async () => {
  await withTemporaryDirectory(async (directory) => {
    const { path, result, topologyAuthority } = await writeGenesis(directory);
    assert.equal((await stat(path)).isFile(), true);
    await assert.rejects(stat(`${path}.part`), (error) => error.code === "ENOENT");

    const bytes = await readFile(path);
    assert.deepEqual([...bytes.subarray(0, 8)], [0x47, 0x39, 0x50, 0x0d, 0x0a, 0x1a, 0x0a, 0x02]);

    const verified = await verifyRoutingEpoch(path, {
      trustedKeyIds: new Set([topologyAuthority.keyId]),
      requireTrustedAuthority: true,
      expectedLedgerId: "routing-test-ledger",
      expectedEpochNumber: 0,
      expectedPreviousEpochHash: null,
    });
    assert.equal(verified.valid, true);
    assert.equal(verified.containerVersion, 2);
    assert.equal(verified.protocolVersion, 1);
    assert.equal(verified.epochHash, result.epochHash);
    assert.equal(verified.fileHash, result.fileHash);
    assert.equal(verified.topologyAuthorityTrusted, true);
    assert.deepEqual(verified.routingPolicy, createRoutingPolicy(2));
    assert.deepEqual(verified.previousShardHeads, []);
  });
});

test("embedded topology keys are self-consistent but not trusted automatically", async () => {
  await withTemporaryDirectory(async (directory) => {
    const { path } = await writeGenesis(directory);
    const verified = await verifyRoutingEpoch(path);
    assert.equal(verified.trustStatus, "untrusted-embedded-key");
    await assert.rejects(
      verifyRoutingEpoch(path, { requireTrustedAuthority: true }),
      (error) => error.code === "EPOCH_UNTRUSTED_AUTHORITY",
    );
  });
});

test("routing epochs link to the previous descriptor and complete shard-head set", async () => {
  await withTemporaryDirectory(async (directory) => {
    const topologyAuthority = generateSigner();
    const genesis = await writeGenesis(directory, { topologyAuthority });
    const transitionPath = join(directory, "epoch-000001.g9p");
    const transition = await writeRoutingEpoch({
      outputPath: transitionPath,
      ledgerId: "routing-test-ledger",
      epochNumber: 1,
      previousEpochHash: fromHex(genesis.result.epochHash, 32),
      previousShardHeads: [
        { epochNumber: 0, shardId: "shard-0000", segmentNumber: 7, segmentHash: Buffer.alloc(32, 1) },
        { epochNumber: 0, shardId: "shard-0001", segmentNumber: null, segmentHash: null },
      ],
      previousRoutingPolicy: createRoutingPolicy(2),
      routingPolicy: createRoutingPolicy(4),
      topologyAuthority,
      reason: "Split two shards into four",
      createdAt: "2026-07-29T13:00:00.000Z",
    });

    const verified = await verifyRoutingEpoch(transitionPath, {
      trustedKeyIds: [topologyAuthority.keyId],
      requireTrustedAuthority: true,
      expectedEpochNumber: 1,
      expectedPreviousEpochHash: fromHex(genesis.result.epochHash, 32),
      expectedPreviousRoutingPolicy: createRoutingPolicy(2),
    });
    assert.equal(verified.epochHash, transition.epochHash);
    assert.equal(verified.previousEpochHash, genesis.result.epochHash);
    assert.equal(verified.previousShardHeads.length, 2);
    assert.equal(verified.previousShardHeads[0].segmentHash, "01".repeat(32));
    assert.equal(verified.previousShardHeads[1].segmentHash, null);

    await assert.rejects(
      verifyRoutingEpoch(transitionPath, { expectedPreviousEpochHash: Buffer.alloc(32, 9) }),
      (error) => error.code === "EPOCH_PREVIOUS",
    );
  });
});

test("writer rejects incomplete or unordered transition heads", async () => {
  await withTemporaryDirectory(async (directory) => {
    const topologyAuthority = generateSigner();
    const common = {
      outputPath: join(directory, "invalid.g9p"),
      ledgerId: "routing-test-ledger",
      epochNumber: 1,
      previousEpochHash: Buffer.alloc(32),
      previousRoutingPolicy: createRoutingPolicy(1),
      routingPolicy: createRoutingPolicy(4),
      topologyAuthority,
      reason: "Invalid transition",
      createdAt: fixedTime,
    };
    await assert.rejects(
      writeRoutingEpoch({ ...common, previousShardHeads: [] }),
      (error) => error.code === "EPOCH_SHARD_HEADS",
    );
    await assert.rejects(
      writeRoutingEpoch({
        ...common,
        previousShardHeads: [
          { epochNumber: 0, shardId: "shard-0001", segmentNumber: null, segmentHash: null },
        ],
      }),
      (error) => error.code === "EPOCH_SHARD_HEAD",
    );
    await assert.rejects(
      writeRoutingEpoch({
        ...common,
        previousShardHeads: [
          { epochNumber: 0, shardId: "shard-0000", segmentNumber: 2, segmentHash: null },
        ],
      }),
      (error) => error.code === "EPOCH_SHARD_HEAD",
    );
  });
});

test("routing epoch signature mutation is detected", async () => {
  await withTemporaryDirectory(async (directory) => {
    const { path } = await writeGenesis(directory);
    const tamperedPath = join(directory, "tampered-signature.g9p");
    await copyFile(path, tamperedPath);
    const bytes = await readFile(tamperedPath);
    const signatureMarker = bytes.indexOf(Buffer.from("SIG1", "ascii"));
    const signaturePayloadLength = bytes.readUInt32BE(signatureMarker + 4);
    bytes[signatureMarker + 8 + signaturePayloadLength - 1] ^= 0x01;
    await writeFile(tamperedPath, bytes);
    await assert.rejects(
      verifyRoutingEpoch(tamperedPath),
      (error) => error.code === "EPOCH_SIGNATURE",
    );
  });
});

test("routing epoch truncation and trailing bytes are rejected", async () => {
  await withTemporaryDirectory(async (directory) => {
    const { path } = await writeGenesis(directory);
    const bytes = await readFile(path);
    const truncatedPath = join(directory, "truncated.g9p");
    const trailingPath = join(directory, "trailing.g9p");
    await writeFile(truncatedPath, bytes.subarray(0, bytes.length - 3));
    await writeFile(trailingPath, Buffer.concat([bytes, Buffer.from([0x00])]));
    await assert.rejects(verifyRoutingEpoch(truncatedPath), (error) => error.code === "FORMAT_TRUNCATED");
    await assert.rejects(verifyRoutingEpoch(trailingPath), (error) => error.code === "FORMAT_TRAILING");
  });
});

test("sealed routing epoch paths are never overwritten", async () => {
  await withTemporaryDirectory(async (directory) => {
    const first = await writeGenesis(directory);
    const original = await readFile(first.path);
    await assert.rejects(
      writeGenesis(directory, { path: first.path, topologyAuthority: first.topologyAuthority }),
      (error) => error.code === "EPOCH_WRITE",
    );
    assert.deepEqual(await readFile(first.path), original);
  });
});
