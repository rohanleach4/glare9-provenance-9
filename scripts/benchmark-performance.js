import { mkdtemp, readdir, rm } from "node:fs/promises";
import { arch, cpus, platform, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import {
  canonicalEventBytes,
  compressBlock,
  createRoutingPolicy,
  decompressBlock,
  domainHash,
  eventHashHex,
  generateSigner,
  verifySegment,
  writeSegment,
} from "../src/index.js";
import { MySqlConnectorWorker } from "../connectors/mysql/src/worker.js";
import { LocalLedger } from "../services/ledger/src/local-ledger.js";

const MIB = 1024 * 1024;
const FIXED_TIME = "2026-07-30T12:00:00.000Z";

function boundedInteger(name, fallback, { min, max }) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

const EVENT_COUNT = boundedInteger("G9P_PERFORMANCE_EVENTS", 250, { min: 50, max: 100_000 });
const BATCH_SIZE = boundedInteger("G9P_PERFORMANCE_BATCH_SIZE", 50, { min: 1, max: 1_000 });
const COMPRESSION_BYTES = boundedInteger("G9P_PERFORMANCE_COMPRESSION_BYTES", 4 * MIB, { min: 64 * 1024, max: 64 * MIB });
const COMPRESSION_ROUNDS = boundedInteger("G9P_PERFORMANCE_COMPRESSION_ROUNDS", 5, { min: 1, max: 100 });

function round(value, digits = 3) {
  return Number(value.toFixed(digits));
}

function rate(count, milliseconds) {
  return round(count / (milliseconds / 1_000));
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function deterministicBytes(seed, length) {
  const chunks = [];
  let bytes = 0;
  for (let counter = 0; bytes < length; counter += 1) {
    const chunk = domainHash("performance-benchmark-bytes-v1", Buffer.from(`${seed}:${counter}`, "utf8"));
    chunks.push(chunk);
    bytes += chunk.byteLength;
  }
  return Buffer.concat(chunks).subarray(0, length);
}

function event(index, ledgerId = "performance-ledger") {
  return {
    version: 1,
    eventId: `performance-event-${index.toString().padStart(8, "0")}`,
    ledgerId,
    subject: `performance:subject-${(index % 100).toString().padStart(4, "0")}`,
    type: "benchmark.evidence.recorded",
    schemaVersion: 1,
    occurredAt: FIXED_TIME,
    recordedAt: FIXED_TIME,
    source: { kind: "batch", identity: "performance-benchmark-v1" },
    payload: {
      control: `control-${index % 24}`,
      outcome: index % 9 === 0 ? "review" : "effective",
      evidence: "representative structured governance evidence ".repeat(16),
    },
  };
}

function batches(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

async function measure(action) {
  const started = performance.now();
  const value = await action();
  return { value, milliseconds: performance.now() - started };
}

function compressionMeasurements() {
  const profiles = {
    "governance-text": Buffer.from("repeatable governance evidence with policy and control context ".repeat(Math.ceil(COMPRESSION_BYTES / 63))).subarray(0, COMPRESSION_BYTES),
    "high-entropy": deterministicBytes("high-entropy", COMPRESSION_BYTES),
  };
  return Object.entries(profiles).map(([profile, input]) => {
    let compressed;
    const compressionStarted = performance.now();
    for (let roundIndex = 0; roundIndex < COMPRESSION_ROUNDS; roundIndex += 1) compressed = compressBlock(input);
    const compressionMs = performance.now() - compressionStarted;
    const decompressionStarted = performance.now();
    for (let roundIndex = 0; roundIndex < COMPRESSION_ROUNDS; roundIndex += 1) {
      const output = decompressBlock(compressed, input.byteLength, input.byteLength);
      if (!Buffer.from(output).equals(input)) throw new Error("Compression benchmark did not round trip input bytes");
    }
    const decompressionMs = performance.now() - decompressionStarted;
    const processedMiB = (input.byteLength * COMPRESSION_ROUNDS) / MIB;
    return {
      profile,
      inputBytes: input.byteLength,
      compressedBytes: compressed.byteLength,
      storedToInputRatio: round(compressed.byteLength / input.byteLength, 5),
      rounds: COMPRESSION_ROUNDS,
      compressionMs: round(compressionMs),
      decompressionMs: round(decompressionMs),
      compressionMiBPerSecond: round(processedMiB / (compressionMs / 1_000)),
      decompressionMiBPerSecond: round(processedMiB / (decompressionMs / 1_000)),
    };
  });
}

async function segmentFiles(directory) {
  const root = join(directory, "segments");
  const entries = await readdir(root, { recursive: true });
  return entries.filter((entry) => entry.endsWith(".g9p")).map((entry) => join(root, entry)).sort();
}

async function lifecycleMeasurements(directory, events, signer, topologyAuthority) {
  const ledgerDirectory = join(directory, "ledger-service");
  const lifecycle = {
    blockMaxBytes: 1024 * 1024,
    blockMaxRecords: 50,
    segmentMaxBytes: 8 * 1024 * 1024,
    segmentMaxRecords: 100,
    segmentMaxAgeMs: 60_000,
    maxAcceptedEvents: Math.max(1_000, events.length * 2),
    maxAcceptedBytes: 64 * MIB,
    maxActiveBlockBytes: 4 * MIB,
  };
  const options = { dataDirectory: ledgerDirectory, signer, topologyAuthority, shardCount: 4, lifecycle };
  const ledger = await new LocalLedger(options).initialize();
  const ingestion = await measure(async () => {
    for (const batch of batches(events, BATCH_SIZE)) await ledger.acceptBatch(batch);
  });
  if (ledger.info().acceptedEvents !== events.length) throw new Error("Ingestion benchmark did not retain every event");
  const sealing = await measure(() => ledger.drainAccepted());
  if (ledger.info().knownEvents !== events.length) throw new Error("Sealing benchmark did not seal every event");
  const files = await segmentFiles(ledgerDirectory);
  await ledger.close({ seal: false });

  const restart = await measure(() => new LocalLedger(options).initialize());
  if (restart.value.info().knownEvents !== events.length) throw new Error("Restart benchmark did not rebuild every event");
  const replay = await measure(async () => {
    for (const batch of batches([...events].reverse(), BATCH_SIZE)) await restart.value.ingestBatch(batch);
  });
  if (restart.value.info().knownEvents !== events.length) throw new Error("Replay benchmark created duplicate events");
  await restart.value.close({ seal: false });

  return {
    eventCount: events.length,
    batchSize: BATCH_SIZE,
    shardCount: 4,
    segmentCount: files.length,
    acceptedIngestionMs: round(ingestion.milliseconds),
    acceptedEventsPerSecond: rate(events.length, ingestion.milliseconds),
    serviceSealingMs: round(sealing.milliseconds),
    serviceSealingEventsPerSecond: rate(events.length, sealing.milliseconds),
    verifiedRestartMs: round(restart.milliseconds),
    verifiedRestartEventsPerSecond: rate(events.length, restart.milliseconds),
    idempotentReplayMs: round(replay.milliseconds),
    idempotentReplayEventsPerSecond: rate(events.length, replay.milliseconds),
  };
}

async function coreSegmentMeasurements(directory, events, signer) {
  const outputPath = join(directory, "direct-segment.g9p");
  const logicalBytes = events.reduce((total, item) => total + canonicalEventBytes(item).byteLength + 4, 0);
  const sealing = await measure(() => writeSegment({
    outputPath,
    events,
    routingPolicy: createRoutingPolicy(1),
    segmentNumber: 0,
    signer,
    createdAt: FIXED_TIME,
    blockTargetBytes: 1024 * 1024,
    blockMaxRecords: 100,
  }));
  const verification = await measure(() => verifySegment(outputPath, {
    trustedKeyIds: [signer.keyId],
    requireTrustedSigner: true,
  }));
  if (verification.value.recordCount !== events.length) throw new Error("Verification benchmark lost records");
  const logicalMiB = logicalBytes / MIB;
  return {
    eventCount: events.length,
    logicalBytes,
    storedBytes: sealing.value.byteLength,
    blockCount: sealing.value.blockCount,
    sealingMs: round(sealing.milliseconds),
    sealingEventsPerSecond: rate(events.length, sealing.milliseconds),
    sealingMiBPerSecond: round(logicalMiB / (sealing.milliseconds / 1_000)),
    verificationMs: round(verification.milliseconds),
    verificationEventsPerSecond: rate(events.length, verification.milliseconds),
    verificationMiBPerSecond: round(logicalMiB / (verification.milliseconds / 1_000)),
  };
}

async function connectorMeasurements(events) {
  const enqueuedAt = performance.now();
  const rows = events.map((envelope, index) => ({
    sequenceId: String(index + 1),
    eventId: envelope.eventId,
    envelope,
    attemptCount: 0,
    leaseToken: null,
    delivered: false,
  }));
  const lags = [];
  let nextLease = 0;
  const repository = {
    async claimBatch({ batchSize }) {
      const selected = rows.filter((row) => !row.delivered && row.leaseToken === null).slice(0, batchSize);
      const leaseToken = `benchmark-lease-${nextLease++}`;
      return selected.map((row) => {
        row.leaseToken = leaseToken;
        row.attemptCount += 1;
        return { ...row, leaseToken };
      });
    },
    async markDelivered(claimed) {
      const deliveredAt = performance.now();
      for (const item of claimed) {
        const row = rows[Number(item.sequenceId) - 1];
        row.delivered = true;
        row.leaseToken = null;
        lags.push(deliveredAt - enqueuedAt);
      }
    },
    async markFailed() {
      throw new Error("Connector benchmark delivery unexpectedly failed");
    },
  };
  const worker = new MySqlConnectorWorker({
    repository,
    provenanceClient: {
      submitAcceptedBatch: async (submitted) => submitted.map((item, index) => ({
        eventId: item.eventId,
        status: "accepted",
        ledgerId: item.ledgerId,
        recordHash: eventHashHex(item),
        intakeSequence: index,
        acceptedAt: FIXED_TIME,
      })),
    },
    connectorId: "performance-connector",
    batchSize: BATCH_SIZE,
    logger: { error() {} },
  });
  const measured = await measure(async () => {
    while (await worker.runOnce() > 0) {}
  });
  if (!rows.every((row) => row.delivered)) throw new Error("Connector benchmark did not deliver every event");
  return {
    eventCount: events.length,
    batchSize: BATCH_SIZE,
    batches: Math.ceil(events.length / BATCH_SIZE),
    elapsedMs: round(measured.milliseconds),
    eventsPerSecond: rate(events.length, measured.milliseconds),
    lagP50Ms: round(percentile(lags, 0.5)),
    lagP95Ms: round(percentile(lags, 0.95)),
    lagMaxMs: round(Math.max(...lags)),
    scope: "in-process worker and memory repository; excludes MySQL, HTTP, polling interval and network latency",
  };
}

async function main() {
  const directory = await mkdtemp(join(tmpdir(), "g9p-performance-benchmark-"));
  const signer = generateSigner();
  const topologyAuthority = generateSigner();
  const events = Array.from({ length: EVENT_COUNT }, (_, index) => event(index));
  try {
    const result = {
      benchmark: "g9p-end-to-end-performance",
      version: 1,
      measuredAt: new Date().toISOString(),
      runtime: {
        node: process.version,
        platform: platform(),
        architecture: arch(),
        cpu: cpus()[0]?.model ?? "unknown",
        logicalCpuCount: cpus().length,
        totalMemoryBytes: totalmem(),
      },
      configuration: {
        eventCount: EVENT_COUNT,
        batchSize: BATCH_SIZE,
        compressionBytes: COMPRESSION_BYTES,
        compressionRounds: COMPRESSION_ROUNDS,
      },
      compression: compressionMeasurements(),
      directSegment: await coreSegmentMeasurements(directory, events.map((item) => ({ ...item, ledgerId: "direct-performance-ledger", subject: "performance:single-shard" })), signer),
      ledgerLifecycle: await lifecycleMeasurements(directory, events, signer, topologyAuthority),
      connector: await connectorMeasurements(events.map((item, index) => ({ ...item, eventId: `connector-performance-${index}` }))),
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ benchmark: "g9p-end-to-end-performance", status: "failed", code: error.code ?? "UNEXPECTED", message: error.message }));
  process.exitCode = 1;
});
