import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createRoutingPolicy,
  generateSigner,
  G9pError,
  LocalFilesystemSealedStorage,
  requireSealedStorage,
  verifyRoutingEpochBytes,
  verifySegmentBytes,
  writeRoutingEpoch,
  writeSegment,
} from "../src/index.js";

const fixedTime = "2026-07-30T12:00:00.000Z";

function event() {
  return {
    version: 1,
    eventId: "storage-event-0001",
    ledgerId: "storage-test-ledger",
    subject: "model:storage-test",
    type: "test.storage.recorded",
    schemaVersion: 1,
    occurredAt: fixedTime,
    recordedAt: fixedTime,
    source: { kind: "semantic", identity: "storage-contract-test" },
    payload: { purpose: "sealed storage abstraction" },
  };
}

class ContractStorage {
  constructor() {
    this.objects = new Map();
  }

  async initialize() {}

  async publish(key, bytes, options = {}) {
    if (this.objects.has(key)) {
      throw new G9pError(options.errorCode ?? "SEALED_STORAGE_WRITE", `Object ${key} already exists`);
    }
    this.objects.set(key, Uint8Array.from(bytes));
  }

  async read(key) {
    const bytes = this.objects.get(key);
    if (bytes === undefined) throw new G9pError("SEALED_STORAGE_NOT_FOUND", `Object ${key} does not exist`);
    return Uint8Array.from(bytes);
  }

  async list(prefix) {
    return [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
  }
}

async function withTemporaryDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), "g9p-sealed-storage-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("sealed storage contract rejects incomplete implementations", () => {
  assert.throws(
    () => requireSealedStorage({ initialize() {}, publish() {}, read() {} }),
    (error) => error.code === "SEALED_STORAGE",
  );
});

test("local filesystem storage publishes create-only objects and lists opaque keys", async () => {
  await withTemporaryDirectory(async (directory) => {
    const storage = new LocalFilesystemSealedStorage(directory);
    await storage.initialize();
    const key = "segments/ledger/shard-0000/segment-000000000000.g9p";
    const original = Buffer.from("sealed-object-one");
    await storage.publish(key, original);
    assert.deepEqual(await storage.list("segments/"), [key]);
    assert.deepEqual(Buffer.from(await storage.read(key)), original);

    await assert.rejects(
      storage.publish(key, Buffer.from("replacement")),
      (error) => error.code === "SEALED_STORAGE_WRITE",
    );
    assert.deepEqual(Buffer.from(await storage.read(key)), original);
    assert.deepEqual(await storage.list("segments/"), [key]);
    await assert.rejects(storage.read(key, { maxBytes: 4 }), (error) => error.code === "SEALED_STORAGE_LIMIT");
    await assert.rejects(storage.publish("../escape.g9p", original), (error) => error.code === "SEALED_STORAGE_KEY");
    await assert.rejects(storage.list("../"), (error) => error.code === "SEALED_STORAGE_KEY");
  });
});

test("local filesystem storage discards abandoned provisional names during initialization", async () => {
  await withTemporaryDirectory(async (directory) => {
    const partPath = join(directory, "segments", "ledger", "shard-0000", "segment-000000000000.g9p.part");
    await mkdir(join(directory, "segments", "ledger", "shard-0000"), { recursive: true });
    await writeFile(partPath, "not authoritative");
    const storage = new LocalFilesystemSealedStorage(directory);
    await storage.initialize();
    await assert.rejects(stat(partPath), (error) => error.code === "ENOENT");
    assert.deepEqual(await storage.list("segments/"), []);
  });
});

test("segment publication is storage-neutral and verification uses only sealed bytes", async () => {
  const storage = new ContractStorage();
  const signer = generateSigner();
  const key = "segments/opaque/segment-000000000000.g9p";
  const result = await writeSegment({
    sealedStorage: storage,
    storageKey: key,
    events: [event()],
    routingPolicy: createRoutingPolicy(1),
    segmentNumber: 0,
    signer,
    createdAt: fixedTime,
  });
  const sealedBytes = await storage.read(key);
  const verified = await verifySegmentBytes(sealedBytes, {
    source: "independently-retrieved-segment",
    trustedKeyIds: [signer.keyId],
    requireTrustedSigner: true,
  });
  assert.equal(result.outputPath, key);
  assert.equal(verified.path, "independently-retrieved-segment");
  assert.equal(verified.segmentHash, result.segmentHash);
  assert.equal(verified.events[0].eventId, event().eventId);

  const original = Buffer.from(sealedBytes);
  await assert.rejects(
    writeSegment({
      sealedStorage: storage,
      storageKey: key,
      events: [event()],
      routingPolicy: createRoutingPolicy(1),
      segmentNumber: 0,
      signer,
      createdAt: fixedTime,
    }),
    (error) => error.code === "SEGMENT_WRITE",
  );
  assert.deepEqual(Buffer.from(await storage.read(key)), original);
});

test("routing-epoch publication and verification are storage-neutral", async () => {
  const storage = new ContractStorage();
  const topologyAuthority = generateSigner();
  const key = "routing/opaque/epoch-000000000000.g9p";
  const result = await writeRoutingEpoch({
    sealedStorage: storage,
    storageKey: key,
    ledgerId: "storage-test-ledger",
    epochNumber: 0,
    routingPolicy: createRoutingPolicy(1),
    topologyAuthority,
    reason: "Prove storage-neutral routing history",
    createdAt: fixedTime,
  });
  const verified = await verifyRoutingEpochBytes(await storage.read(key), {
    source: "independently-retrieved-routing-epoch",
    trustedKeyIds: [topologyAuthority.keyId],
    requireTrustedAuthority: true,
  });
  assert.equal(result.outputPath, key);
  assert.equal(verified.path, "independently-retrieved-routing-epoch");
  assert.equal(verified.fileHash, result.fileHash);
  assert.equal(verified.epochHash, result.epochHash);
});
