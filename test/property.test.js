import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createRoutingPolicy,
  decodeCanonical,
  encodeCanonical,
  generateSigner,
  routeEvent,
  verifySegment,
  writeSegment,
} from "../src/index.js";
import { deterministicRandom } from "./support/prng.js";

const timestamp = "2026-07-30T12:00:00.000Z";

function canonicalValue(random, depth = 0) {
  const leaf = depth >= 4;
  const kind = random.integer(leaf ? 6 : 9);
  if (kind === 0) return null;
  if (kind === 1) return random.boolean();
  if (kind === 2) return random.integer(2_000_001) - 1_000_000;
  if (kind === 3) return (random.integer(2_000_000) - 1_000_000) / 7;
  if (kind === 4) return `text-${random.integer(1_000_000)}-é`;
  if (kind === 5) return random.bytes(random.integer(33));
  if (kind === 6) return Array.from({ length: random.integer(5) }, () => canonicalValue(random, depth + 1));
  const value = {};
  for (let index = 0; index < random.integer(5); index += 1) {
    value[`key-${index}-${random.integer(100)}`] = canonicalValue(random, depth + 1);
  }
  return value;
}

function evidenceEvent(index, ledgerId = "property-ledger") {
  return {
    version: 1,
    eventId: `property-event-${index}`,
    ledgerId,
    subject: `property:subject-${index % 7}`,
    type: "test.property.event",
    schemaVersion: 1,
    occurredAt: timestamp,
    recordedAt: timestamp,
    source: { kind: "semantic", identity: "property-test" },
    payload: { index, evidence: "x".repeat((index % 17) + 1) },
  };
}

test("property: canonical values round trip to exactly one byte representation", () => {
  const random = deterministicRandom(0xc0de_cafe);
  for (let iteration = 0; iteration < 750; iteration += 1) {
    const value = canonicalValue(random);
    const encoded = encodeCanonical(value);
    const decoded = decodeCanonical(encoded);
    assert.deepEqual(encodeCanonical(decoded), encoded, `canonical bytes changed at iteration ${iteration}`);
  }
});

test("property: routing is stable, bounded and policy-derived", () => {
  const random = deterministicRandom(0x51a4_d123);
  for (let iteration = 0; iteration < 2_000; iteration += 1) {
    const shardCount = random.integer(256) + 1;
    const policy = createRoutingPolicy(shardCount);
    const item = {
      ledgerId: `ledger-${random.integer(1_000)}`,
      subject: `subject-${random.integer(100_000)}`,
    };
    const first = routeEvent(item, policy);
    const second = routeEvent(structuredClone(item), createRoutingPolicy(shardCount));
    assert.deepEqual(second, first);
    assert.ok(first.index >= 0 && first.index < shardCount);
    assert.equal(first.shardId, `shard-${first.index.toString().padStart(4, "0")}`);
  }
});

test("property: generated segments preserve event order, block bounds and stable verification", async () => {
  const directory = await mkdtemp(join(tmpdir(), "g9p-property-segments-"));
  const random = deterministicRandom(0x5e6d_3a17);
  const signer = generateSigner();
  try {
    for (let iteration = 0; iteration < 12; iteration += 1) {
      const count = random.integer(12) + 1;
      const maxRecords = random.integer(4) + 1;
      const events = Array.from({ length: count }, (_, index) => evidenceEvent(iteration * 100 + index, `property-ledger-${iteration}`));
      const path = join(directory, `property-${iteration}.g9p`);
      const written = await writeSegment({
        outputPath: path,
        events,
        routingPolicy: createRoutingPolicy(1),
        segmentNumber: iteration,
        signer,
        createdAt: timestamp,
        blockTargetBytes: random.integer(1025) + 1024,
        blockMaxRecords: maxRecords,
      });
      const first = await verifySegment(path, { trustedKeyIds: [signer.keyId], requireTrustedSigner: true });
      const second = await verifySegment(path, { includeEvents: false });
      assert.equal(first.recordCount, count);
      assert.ok(first.blockCount >= Math.ceil(count / maxRecords));
      assert.deepEqual(first.events.map((item) => item.eventId), events.map((item) => item.eventId));
      assert.equal(first.segmentHash, written.segmentHash);
      assert.equal(second.segmentHash, first.segmentHash);
      assert.equal(second.events, undefined);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
