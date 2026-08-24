#!/usr/bin/env node

import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

import {
  createRoutingPolicy,
  generateSigner,
  planShardAssignments,
  verifyCheckpoint,
  verifyRoutingEpoch,
  verifySegment,
  verifyWitnessReceipt,
  writeSegment,
} from "../index.js";

function usage() {
  console.log(`Provenance•9 prototype CLI

Usage:
  npm run demo -- [output-directory]
  npm run verify -- <segment.g9p> [trusted-key-id]
  npm run verify:epoch -- <routing-epoch.g9p> [trusted-key-id]
  npm run verify:checkpoint -- <checkpoint.g9p> [trusted-publisher-key-id]
  npm run verify:witness -- <witness-receipt.g9p> [trusted-witness-key-id]
  npm run shard -- <ledger-id> <shard-count> <subject> [subject ...]

Commands:
  demo    Create and verify a demonstration .g9p segment
  verify  Independently verify a sealed .g9p segment
  verify-epoch  Independently verify a signed routing epoch
  verify-checkpoint  Independently verify a signed checkpoint
  verify-witness  Independently verify a signed witness receipt
  shard   Preview deterministic subject-to-shard assignments
`);
}

function sampleEvents(timestamp) {
  const ledgerId = "glare9-provenance-demo";
  const source = { kind: "semantic", identity: "demo:operator" };
  return [
    {
      version: 1,
      eventId: randomUUID(),
      ledgerId,
      subject: "model:credit-risk-v1",
      type: "ai.model.registered",
      schemaVersion: 1,
      occurredAt: timestamp,
      recordedAt: timestamp,
      source,
      payload: {
        name: "Credit Risk Demonstrator",
        owner: "risk-team",
        purpose: "Demonstrate a compact governance event",
      },
    },
    {
      version: 1,
      eventId: randomUUID(),
      ledgerId,
      subject: "model:credit-risk-v1",
      type: "ai.assessment.completed",
      schemaVersion: 1,
      occurredAt: timestamp,
      recordedAt: timestamp,
      source,
      correlationId: "demo-assessment-1",
      payload: {
        result: "controls-satisfied",
        controls: ["human-oversight", "data-quality", "monitoring"],
      },
    },
    {
      version: 1,
      eventId: randomUUID(),
      ledgerId,
      subject: "model:credit-risk-v1",
      type: "ai.deployment.approved",
      schemaVersion: 1,
      occurredAt: timestamp,
      recordedAt: timestamp,
      source,
      causationId: "demo-assessment-1",
      policyReference: "policy:production-deployment-v1",
      payload: {
        decision: "approved",
        environment: "demonstration",
      },
    },
  ];
}

async function demo(directoryArgument) {
  const timestamp = new Date().toISOString();
  const defaultDirectory = `runtime/demo-${timestamp.replaceAll(":", "-")}`;
  const directory = resolve(directoryArgument ?? defaultDirectory);
  await mkdir(directory, { recursive: true });

  const signer = generateSigner();
  const outputPath = resolve(directory, "shard-0000-segment-000000.g9p");
  const writeResult = await writeSegment({
    outputPath,
    events: sampleEvents(timestamp),
    routingPolicy: createRoutingPolicy(1),
    segmentNumber: 0,
    signer,
    createdAt: timestamp,
  });

  const verification = await verifySegment(outputPath, {
    trustedKeyIds: new Set([signer.keyId]),
    requireTrustedSigner: true,
    expectedPreviousSegmentHash: null,
    expectedLedgerId: "glare9-provenance-demo",
    expectedShardId: "shard-0000",
    includeEvents: false,
  });

  console.log(JSON.stringify({
    message: "Created and independently verified a sealed G9P segment",
    write: writeResult,
    verification,
  }, null, 2));
}

async function verify(pathArgument, trustedKeyId) {
  if (pathArgument === undefined) {
    usage();
    process.exitCode = 2;
    return;
  }

  const options = { includeEvents: false };
  if (trustedKeyId !== undefined) {
    options.trustedKeyIds = new Set([trustedKeyId]);
    options.requireTrustedSigner = true;
  }

  const result = await verifySegment(resolve(pathArgument), options);
  console.log(JSON.stringify(result, null, 2));
}

async function verifyEpoch(pathArgument, trustedKeyId) {
  if (pathArgument === undefined) {
    usage();
    process.exitCode = 2;
    return;
  }

  const options = {};
  if (trustedKeyId !== undefined) {
    options.trustedKeyIds = new Set([trustedKeyId]);
    options.requireTrustedAuthority = true;
  }

  const result = await verifyRoutingEpoch(resolve(pathArgument), options);
  console.log(JSON.stringify(result, null, 2));
}

async function verifyAttestation(pathArgument, trustedKeyId, verifier) {
  if (pathArgument === undefined) {
    usage();
    process.exitCode = 2;
    return;
  }

  const options = {};
  if (trustedKeyId !== undefined) {
    options.trustedKeyIds = new Set([trustedKeyId]);
    options.requireTrustedSigner = true;
  }
  const result = await verifier(resolve(pathArgument), options);
  console.log(JSON.stringify(result, null, 2));
}

function shard(ledgerId, shardCountArgument, subjects) {
  const shardCount = Number(shardCountArgument);
  const result = planShardAssignments({ ledgerId, shardCount, subjects });
  console.log(JSON.stringify(result, null, 2));
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "demo") return demo(args[0]);
  if (command === "verify") return verify(args[0], args[1]);
  if (command === "verify-epoch") return verifyEpoch(args[0], args[1]);
  if (command === "verify-checkpoint") return verifyAttestation(args[0], args[1], verifyCheckpoint);
  if (command === "verify-witness") return verifyAttestation(args[0], args[1], verifyWitnessReceipt);
  if (command === "shard") return shard(args[0], args[1], args.slice(2));
  usage();
  if (command !== undefined) process.exitCode = 2;
}

main().catch((error) => {
  console.error(JSON.stringify({
    valid: false,
    error: error.name,
    code: error.code ?? "UNEXPECTED",
    message: error.message,
  }, null, 2));
  process.exitCode = 1;
});
