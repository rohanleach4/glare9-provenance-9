import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createRoutingPolicy,
  decodeCanonical,
  decompressBlock,
  generateSigner,
  G9pError,
  verifyRoutingEpochBytes,
  verifySegmentBytes,
  writeRoutingEpoch,
  writeSegment,
} from "../src/index.js";
import { FrameReader, FRAME_TYPES, G9P_MAGIC } from "../src/format/framing.js";
import { readFramedRecords } from "../src/format/records.js";
import { deterministicRandom } from "./support/prng.js";

const configuredIterations = Number(process.env.G9P_FUZZ_ITERATIONS ?? 500);
if (!Number.isSafeInteger(configuredIterations) || configuredIterations < 1 || configuredIterations > 100_000) {
  throw new TypeError("G9P_FUZZ_ITERATIONS must be an integer between 1 and 100,000");
}
const configuredSeed = Number(process.env.G9P_FUZZ_SEED ?? 0xf022_2026);
if (!Number.isSafeInteger(configuredSeed) || configuredSeed < 0 || configuredSeed > 0xffff_ffff) {
  throw new TypeError("G9P_FUZZ_SEED must be an unsigned 32-bit integer");
}

function assertControlledFailure(action, label) {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof G9pError, `${label} escaped with ${error?.constructor?.name ?? typeof error}`);
  }
}

async function assertControlledRejection(action, label) {
  try {
    await action();
  } catch (error) {
    assert.ok(error instanceof G9pError, `${label} escaped with ${error?.constructor?.name ?? typeof error}`);
  }
}

test("fuzz: canonical, frame, record and decompression boundaries fail controllably", async (t) => {
  const random = deterministicRandom(configuredSeed);
  t.diagnostic(`seed=${configuredSeed} iterations=${configuredIterations}`);
  for (let iteration = 0; iteration < configuredIterations; iteration += 1) {
    const bytes = random.bytes(random.integer(257));
    assertControlledFailure(() => decodeCanonical(bytes, {
      maxBytes: 256,
      maxCollectionEntries: 32,
      maxDepth: 8,
    }), `canonical seed=${configuredSeed} iteration=${iteration}`);

    const framed = Buffer.concat([G9P_MAGIC, Buffer.from(bytes)]);
    assertControlledFailure(() => {
      const reader = new FrameReader(framed, { maxFrameBytes: 256 });
      reader.readMagic();
      while (reader.remaining() > 0) reader.readFrame(FRAME_TYPES.block);
      reader.assertEnd();
    }, `frame seed=${configuredSeed} iteration=${iteration}`);

    assertControlledFailure(
      () => readFramedRecords(bytes, random.integer(8), { maxRecordBytes: 128 }),
      `record seed=${configuredSeed} iteration=${iteration}`,
    );
    assertControlledFailure(
      () => decompressBlock(bytes, random.integer(513), 512),
      `decompression seed=${configuredSeed} iteration=${iteration}`,
    );
    await assertControlledRejection(
      () => verifySegmentBytes(bytes, { limits: { maxFileBytes: 256, maxFrameBytes: 256, maxBlockOutputBytes: 512 } }),
      `segment seed=${configuredSeed} iteration=${iteration}`,
    );
    await assertControlledRejection(
      () => verifyRoutingEpochBytes(bytes, { limits: { maxFileBytes: 256, maxFrameBytes: 256 } }),
      `routing epoch seed=${configuredSeed} iteration=${iteration}`,
    );
  }
});

test("fuzz: bounded mutations of valid imported evidence never verify", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "g9p-import-fuzz-"));
  const random = deterministicRandom(configuredSeed ^ 0xa5a5_5a5a);
  const signer = generateSigner();
  const topologyAuthority = generateSigner();
  const segmentPath = join(directory, "segment.g9p");
  const epochPath = join(directory, "epoch.g9p");
  try {
    await writeSegment({
      outputPath: segmentPath,
      events: [{
        version: 1,
        eventId: "fuzz-import-event",
        ledgerId: "fuzz-import-ledger",
        subject: "fuzz:subject",
        type: "test.fuzz.import",
        schemaVersion: 1,
        occurredAt: "2026-07-30T12:00:00.000Z",
        recordedAt: "2026-07-30T12:00:00.000Z",
        source: { kind: "batch", identity: "fuzz-test" },
        payload: { evidence: "valid seed before mutation" },
      }],
      routingPolicy: createRoutingPolicy(1),
      segmentNumber: 0,
      signer,
      createdAt: "2026-07-30T12:00:00.000Z",
    });
    await writeRoutingEpoch({
      outputPath: epochPath,
      ledgerId: "fuzz-import-ledger",
      epochNumber: 0,
      routingPolicy: createRoutingPolicy(1),
      topologyAuthority,
      reason: "Valid seed before mutation",
      createdAt: "2026-07-30T12:00:00.000Z",
    });
    const fixtures = [
      { name: "segment", bytes: await readFile(segmentPath), verify: verifySegmentBytes },
      { name: "routing-epoch", bytes: await readFile(epochPath), verify: verifyRoutingEpochBytes },
    ];
    for (const fixture of fixtures) {
      await fixture.verify(fixture.bytes);
      for (let iteration = 0; iteration < 96; iteration += 1) {
        const mutated = Buffer.from(fixture.bytes);
        const offset = random.integer(mutated.length);
        mutated[offset] ^= 1 << random.integer(8);
        await assert.rejects(
          fixture.verify(mutated),
          (error) => error instanceof G9pError,
          `${fixture.name} mutation verified at seed=${configuredSeed} iteration=${iteration} offset=${offset}`,
        );
      }
    }
    t.diagnostic(`seed=${configuredSeed} mutations=192`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
