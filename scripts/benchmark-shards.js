import { arch, cpus, platform } from "node:os";
import { performance } from "node:perf_hooks";

import { planShardAssignments } from "../src/index.js";

const SUBJECT_COUNT = 20_000;
const SHARD_COUNTS = [1, 2, 4, 8, 16];

function subjects(profile) {
  if (profile === "uniform-entities") {
    return Array.from({ length: SUBJECT_COUNT }, (_, index) => `entity:${index.toString().padStart(8, "0")}`);
  }
  if (profile === "governance-mix") {
    return Array.from({ length: SUBJECT_COUNT }, (_, index) => {
      if (index % 10 < 6) return `model:${index.toString().padStart(8, "0")}`;
      if (index % 10 < 9) return `policy:${index.toString().padStart(8, "0")}`;
      return `control:${index.toString().padStart(8, "0")}`;
    });
  }
  return Array.from({ length: SUBJECT_COUNT }, (_, index) => index < SUBJECT_COUNT * 0.8
    ? "tenant:dominant-hot-subject"
    : `tenant:long-tail-${index.toString().padStart(8, "0")}`);
}

function round(value, digits = 4) {
  return Number(value.toFixed(digits));
}

function measure(profile, shardCount) {
  const input = subjects(profile);
  const started = performance.now();
  const plan = planShardAssignments({
    ledgerId: `benchmark-${profile}`,
    shardCount,
    subjects: input,
  });
  const elapsedMs = performance.now() - started;
  const counts = Array.from({ length: shardCount }, () => 0);
  for (const shard of plan.distribution) counts[shard.shardIndex] = shard.subjectCount;
  const mean = input.length / shardCount;
  const variance = counts.reduce((total, count) => total + ((count - mean) ** 2), 0) / shardCount;
  return {
    profile,
    shardCount,
    subjectOccurrences: input.length,
    uniqueSubjects: new Set(input).size,
    populatedShards: plan.populatedShardCount,
    minOccurrences: Math.min(...counts),
    maxOccurrences: Math.max(...counts),
    hottestToMeanRatio: round(Math.max(...counts) / mean),
    coefficientOfVariation: round(Math.sqrt(variance) / mean),
    planningMs: round(elapsedMs, 3),
    occurrencesPerSecond: Math.round(input.length / (elapsedMs / 1_000)),
  };
}

const profiles = ["uniform-entities", "governance-mix", "hot-subject-80-percent"];
const runs = profiles.flatMap((profile) => SHARD_COUNTS.map((shardCount) => measure(profile, shardCount)));
process.stdout.write(`${JSON.stringify({
  benchmark: "g9p-shard-distribution",
  version: 1,
  measuredAt: new Date().toISOString(),
  runtime: {
    node: process.version,
    platform: platform(),
    architecture: arch(),
    cpu: cpus()[0]?.model ?? "unknown",
    logicalCpuCount: cpus().length,
  },
  matrix: { subjectOccurrences: SUBJECT_COUNT, shardCounts: SHARD_COUNTS, profiles },
  runs,
}, null, 2)}\n`);
