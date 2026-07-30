import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { verifyRoutingEpochBytes, verifySegmentBytes } from "../src/index.js";
import { verifyG9pBytes } from "../tools/independent-verifier/verify.js";

const manifest = JSON.parse(await readFile(new URL("../conformance/g9p-v1-v2-vectors.json", import.meta.url), "utf8"));

function mutate(source, mutation) {
  const bytes = Buffer.from(source);
  if (mutation.operation === "set-byte") {
    bytes[mutation.offset] = mutation.value;
    return bytes;
  }
  if (mutation.operation === "truncate") return bytes.subarray(0, bytes.length - mutation.count);
  if (mutation.operation === "append") return Buffer.concat([bytes, Buffer.from(mutation.bytesHex, "hex")]);
  if (mutation.operation === "xor-frame-payload-last") {
    const marker = bytes.indexOf(Buffer.from(mutation.frameType, "ascii"));
    assert.ok(marker >= 8, `frame ${mutation.frameType} must exist`);
    const length = bytes.readUInt32BE(marker + 4);
    assert.ok(length > 0, `frame ${mutation.frameType} must have a payload`);
    bytes[marker + 8 + length - 1] ^= mutation.value;
    return bytes;
  }
  throw new Error(`Unsupported conformance mutation ${mutation.operation}`);
}

function primaryVerify(vector, bytes) {
  return vector.kind === "segment"
    ? verifySegmentBytes(bytes, { includeEvents: false })
    : verifyRoutingEpochBytes(bytes);
}

test("frozen valid vectors agree across the primary and independent verifiers", async () => {
  assert.equal(manifest.privateKeyMaterialIncluded, false);
  for (const vector of manifest.valid) {
    const bytes = Buffer.from(vector.bytesBase64, "base64");
    assert.equal(createHash("sha256").update(bytes).digest("hex"), vector.sha256, vector.id);
    const primary = await primaryVerify(vector, bytes);
    const independent = verifyG9pBytes(bytes);
    assert.equal(primary.valid, true, vector.id);
    assert.equal(independent.valid, true, vector.id);
    for (const [field, expected] of Object.entries(vector.expected)) {
      const primaryField = field === "fileHash" && vector.kind === "segment" ? "segmentHash" : field;
      assert.deepEqual(primary[primaryField], expected, `${vector.id} primary ${field}`);
      assert.deepEqual(independent[field], expected, `${vector.id} independent ${field}`);
    }
  }
});
test("precisely invalid mutations are rejected by both verifiers at the expected layer", async () => {
  const validById = new Map(manifest.valid.map((vector) => [vector.id, vector]));
  for (const vector of manifest.invalid) {
    const source = validById.get(vector.source);
    assert.ok(source, `${vector.id} source exists`);
    const bytes = mutate(Buffer.from(source.bytesBase64, "base64"), vector.mutation);
    await assert.rejects(
      primaryVerify(source, bytes),
      (error) => error.code === vector.expected.primaryCode,
      `${vector.id} primary code`,
    );
    assert.throws(
      () => verifyG9pBytes(bytes),
      (error) => error.category === vector.expected.portableCategory,
      `${vector.id} portable category`,
    );
  }
});
