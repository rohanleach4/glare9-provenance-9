import { cpus, platform, arch, tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import {
  canonicalEventBytes,
  createRoutingPolicy,
  domainHash,
  generateSigner,
  toHex,
  verifySegment,
  writeSegment,
} from "../src/index.js";

const MIB = 1024 * 1024;
const FIXED_TIME = "2026-07-30T12:00:00.000Z";
const BLOCK_SWEEP = [256 * 1024, 1 * MIB, 4 * MIB];
const SEGMENT_SWEEP = [8 * MIB, 32 * MIB, 64 * MIB];
const FIXED_BLOCK_BYTES = 1 * MIB;
const FIXED_SEGMENT_BYTES = 32 * MIB;

function deterministicBytes(seed, length) {
  const chunks = [];
  let produced = 0;
  let counter = 0;
  while (produced < length) {
    const chunk = domainHash("lifecycle-benchmark-v1", Buffer.from(`${seed}:${counter}`, "utf8"));
    chunks.push(chunk);
    produced += chunk.byteLength;
    counter += 1;
  }
  return Buffer.concat(chunks).subarray(0, length);
}

function benchmarkEvent(profile, index) {
  const common = {
    version: 1,
    eventId: `${profile}-event-${index.toString().padStart(8, "0")}`,
    ledgerId: `benchmark-${profile}`,
    subject: `model:${(index % 10_000).toString().padStart(5, "0")}`,
    type: "governance.evidence.recorded",
    schemaVersion: 1,
    occurredAt: FIXED_TIME,
    recordedAt: FIXED_TIME,
    source: { kind: "batch", identity: "lifecycle-sizing-benchmark-v1" },
  };
  if (profile === "governance-json") {
    return {
      ...common,
      payload: {
        controlFamily: `control-family-${index % 24}`,
        outcome: index % 7 === 0 ? "requires-review" : "effective",
        policyVersion: `policy-${index % 12}`,
        evidence: "repeatable governance control evidence with bounded structured context ".repeat(48),
      },
      metadata: { tenantClass: "regulated-service", region: `region-${index % 4}` },
    };
  }
  return {
    ...common,
    payload: {
      algorithm: "opaque-content-reference-v1",
      ciphertextOrDigestMaterial: deterministicBytes(`${profile}:${index}`, 3_072).toString("base64"),
    },
    payloadHash: toHex(domainHash("lifecycle-benchmark-payload-v1", deterministicBytes(`hash:${index}`, 64))),
  };
}

function prepareProfile(profile, maximumBytes) {
  const records = [];
  let logicalBytes = 0;
  for (let index = 0; logicalBytes < maximumBytes; index += 1) {
    const event = benchmarkEvent(profile, index);
    const framedBytes = canonicalEventBytes(event).byteLength + 4;
    records.push({ event, framedBytes });
    logicalBytes += framedBytes;
  }
  return records;
}

function recordsForTarget(prepared, targetBytes) {
  const events = [];
  let logicalBytes = 0;
  for (const record of prepared) {
    if (events.length > 0 && logicalBytes + record.framedBytes > targetBytes) break;
    events.push(record.event);
    logicalBytes += record.framedBytes;
  }
  return { events, logicalBytes };
}

function round(value, digits = 3) {
  return Number(value.toFixed(digits));
}

async function measureRun({ directory, signer, profile, dimension, blockBytes, segmentBytes, prepared, runIndex }) {
  const { events, logicalBytes } = recordsForTarget(prepared, segmentBytes);
  const outputPath = join(directory, `run-${runIndex.toString().padStart(2, "0")}.g9p`);
  const writeStarted = performance.now();
  const written = await writeSegment({
    outputPath,
    events,
    routingPolicy: createRoutingPolicy(1),
    segmentNumber: 0,
    signer,
    createdAt: FIXED_TIME,
    blockTargetBytes: blockBytes,
    routingEpoch: {
      epochNumber: 0,
      epochHash: domainHash("lifecycle-benchmark-routing-epoch-v1", Buffer.from(profile, "utf8")),
    },
  });
  const writeMs = performance.now() - writeStarted;
  const verifyStarted = performance.now();
  const verified = await verifySegment(outputPath, {
    trustedKeyIds: new Set([signer.keyId]),
    requireTrustedSigner: true,
  });
  const verifyMs = performance.now() - verifyStarted;
  if (verified.recordCount !== events.length || verified.blockCount !== written.blockCount) {
    throw new Error("Lifecycle benchmark verification did not reproduce the written segment");
  }
  const logicalMiB = logicalBytes / MIB;
  return {
    profile,
    dimension,
    blockBytes,
    targetSegmentBytes: segmentBytes,
    recordCount: events.length,
    blockCount: written.blockCount,
    logicalBytes,
    storedBytes: written.byteLength,
    storedToLogicalRatio: round(written.byteLength / logicalBytes, 4),
    writeMs: round(writeMs),
    verifyMs: round(verifyMs),
    writeMiBPerSecond: round(logicalMiB / (writeMs / 1_000)),
    verifyMiBPerSecond: round(logicalMiB / (verifyMs / 1_000)),
  };
}

async function main() {
  const directory = await mkdtemp(join(tmpdir(), "g9p-lifecycle-benchmark-"));
  const signer = generateSigner();
  const profiles = ["governance-json", "high-entropy"];
  const prepared = new Map(profiles.map((profile) => [profile, prepareProfile(profile, Math.max(...SEGMENT_SWEEP))]));
  const runs = [];
  try {
    let runIndex = 0;
    for (const profile of profiles) {
      runs.push(await measureRun({
        directory,
        signer,
        profile,
        dimension: "low-volume-seal",
        blockBytes: FIXED_BLOCK_BYTES,
        segmentBytes: prepared.get(profile)[0].framedBytes,
        prepared: prepared.get(profile),
        runIndex,
      }));
      runIndex += 1;
      for (const blockBytes of BLOCK_SWEEP) {
        runs.push(await measureRun({
          directory,
          signer,
          profile,
          dimension: "block-size",
          blockBytes,
          segmentBytes: FIXED_SEGMENT_BYTES,
          prepared: prepared.get(profile),
          runIndex,
        }));
        runIndex += 1;
      }
      for (const segmentBytes of SEGMENT_SWEEP) {
        runs.push(await measureRun({
          directory,
          signer,
          profile,
          dimension: "segment-size",
          blockBytes: FIXED_BLOCK_BYTES,
          segmentBytes,
          prepared: prepared.get(profile),
          runIndex,
        }));
        runIndex += 1;
      }
    }
    const result = {
      benchmark: "g9p-lifecycle-sizing",
      version: 1,
      measuredAt: new Date().toISOString(),
      runtime: {
        node: process.version,
        platform: platform(),
        architecture: arch(),
        cpu: cpus()[0]?.model ?? "unknown",
        logicalCpuCount: cpus().length,
      },
      profiles: {
        "governance-json": "Structured, repetitive governance evidence with approximately 3 KiB payloads",
        "high-entropy": "Deterministic opaque/base64 material with approximately 3 KiB payloads",
      },
      matrix: {
        blockSweepBytes: BLOCK_SWEEP,
        fixedSegmentBytes: FIXED_SEGMENT_BYTES,
        segmentSweepBytes: SEGMENT_SWEEP,
        fixedBlockBytes: FIXED_BLOCK_BYTES,
        lowVolumeRecords: 1,
      },
      runs,
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ benchmark: "g9p-lifecycle-sizing", status: "failed", message: error.message }));
  process.exitCode = 1;
});
