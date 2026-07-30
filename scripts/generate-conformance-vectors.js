import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createRoutingPolicy,
  generateSigner,
  verifyCheckpoint,
  verifyRoutingEpoch,
  verifySegment,
  verifyWitnessReceipt,
  writeCheckpoint,
  writeRoutingEpoch,
  writeSegment,
  writeWitnessReceipt,
} from "../src/index.js";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outputPath = join(repositoryRoot, "conformance", "g9p-v1-v2-vectors.json");
const createdAt = "2026-07-30T15:00:00.000Z";
const event = {
  version: 1,
  eventId: "conformance-event-0001",
  ledgerId: "conformance-ledger",
  subject: "model:conformance",
  type: "evidence.recorded",
  schemaVersion: 1,
  occurredAt: createdAt,
  recordedAt: createdAt,
  source: { kind: "semantic", identity: "conformance-generator" },
  payload: { decision: "approved", score: 0.75 },
};

const directory = await mkdtemp(join(tmpdir(), "g9p-conformance-"));
try {
  const segmentSigner = generateSigner();
  const authority = generateSigner();
  const v1Path = join(directory, "segment-v1.g9p");
  const v2Path = join(directory, "segment-v2.g9p");
  const epochPath = join(directory, "epoch-v1.g9p");
  const checkpointPath = join(directory, "checkpoint-v1.g9p");
  const witnessPath = join(directory, "witness-v1.g9p");
  const routingPolicy = createRoutingPolicy(1);

  await writeSegment({
    outputPath: v1Path,
    events: [event],
    routingPolicy,
    segmentNumber: 0,
    signer: segmentSigner,
    createdAt,
  });
  await writeRoutingEpoch({
    outputPath: epochPath,
    ledgerId: event.ledgerId,
    epochNumber: 0,
    routingPolicy,
    topologyAuthority: authority,
    reason: "Conformance genesis",
    createdAt,
  });
  const epoch = await verifyRoutingEpoch(epochPath);
  const v2Segment = await writeSegment({
    outputPath: v2Path,
    events: [event],
    routingPolicy,
    segmentNumber: 0,
    routingEpoch: { epochNumber: 0, epochHash: Buffer.from(epoch.epochHash, "hex") },
    signer: segmentSigner,
    createdAt,
  });
  const checkpointPublisher = generateSigner();
  const witness = generateSigner();
  await writeCheckpoint({
    outputPath: checkpointPath,
    ledgerId: event.ledgerId,
    checkpointNumber: 0,
    routingEpochNumber: 0,
    routingEpochHash: Buffer.from(epoch.epochHash, "hex"),
    shardHeads: [{ epochNumber: 0, shardId: "shard-0000", segmentNumber: 0, segmentHash: Buffer.from(v2Segment.segmentHash, "hex") }],
    publisher: checkpointPublisher,
    createdAt,
  });
  await writeWitnessReceipt({
    outputPath: witnessPath,
    checkpointBytes: await readFile(checkpointPath),
    witness,
    observedAt: createdAt,
    trustedPublisherKeyIds: [checkpointPublisher.keyId],
  });

  const valid = [];
  for (const [id, kind, path, verifier] of [
    ["valid-segment-v1", "segment", v1Path, verifySegment],
    ["valid-segment-v2", "segment", v2Path, verifySegment],
    ["valid-routing-epoch-v1", "routing-epoch", epochPath, verifyRoutingEpoch],
    ["valid-checkpoint-v1", "checkpoint", checkpointPath, verifyCheckpoint],
    ["valid-witness-receipt-v1", "witness-receipt", witnessPath, verifyWitnessReceipt],
  ]) {
    const bytes = await readFile(path);
    const verified = await verifier(path, { includeEvents: false });
    valid.push({
      id,
      kind,
      bytesBase64: bytes.toString("base64"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      expected: kind === "segment"
        ? {
            formatVersion: verified.formatVersion,
            ledgerId: verified.ledgerId,
            shardId: verified.shardId,
            blockCount: verified.blockCount,
            recordCount: verified.recordCount,
            logicalRoot: verified.logicalRoot,
            fileHash: verified.segmentHash,
            signerKeyId: verified.signerKeyId,
          }
        : kind === "routing-epoch" ? {
            containerVersion: verified.containerVersion,
            protocolVersion: verified.protocolVersion,
            ledgerId: verified.ledgerId,
            epochNumber: verified.epochNumber,
            epochHash: verified.epochHash,
            fileHash: verified.fileHash,
            topologyAuthorityKeyId: verified.topologyAuthorityKeyId,
          } : kind === "checkpoint" ? {
            protocolVersion: verified.protocolVersion,
            ledgerId: verified.ledgerId,
            checkpointNumber: verified.checkpointNumber,
            checkpointHash: verified.checkpointHash,
            fileHash: verified.fileHash,
            publisherKeyId: verified.publisherKeyId,
          } : {
            protocolVersion: verified.protocolVersion,
            ledgerId: verified.ledgerId,
            checkpointNumber: verified.checkpointNumber,
            checkpointHash: verified.checkpointHash,
            checkpointFileHash: verified.checkpointFileHash,
            receiptHash: verified.receiptHash,
            fileHash: verified.fileHash,
            witnessKeyId: verified.witnessKeyId,
          },
    });
  }

  const invalid = [
    { id: "invalid-segment-v1-future-container", source: "valid-segment-v1", mutation: { operation: "set-byte", offset: 7, value: 3 }, expected: { primaryCode: "FORMAT_MAGIC", portableCategory: "FORMAT" } },
    { id: "invalid-segment-v1-truncated", source: "valid-segment-v1", mutation: { operation: "truncate", count: 5 }, expected: { primaryCode: "FORMAT_TRUNCATED", portableCategory: "FORMAT" } },
    { id: "invalid-segment-v1-block-commitment", source: "valid-segment-v1", mutation: { operation: "xor-frame-payload-last", frameType: "BLK1", value: 1 }, expected: { primaryCode: "VERIFY_BLOCK_HASH", portableCategory: "COMMITMENT" } },
    { id: "invalid-segment-v2-signature", source: "valid-segment-v2", mutation: { operation: "xor-frame-payload-last", frameType: "SIG1", value: 1 }, expected: { primaryCode: "VERIFY_SIGNATURE", portableCategory: "SIGNATURE" } },
    { id: "invalid-segment-v2-trailing", source: "valid-segment-v2", mutation: { operation: "append", bytesHex: "00" }, expected: { primaryCode: "FORMAT_TRAILING", portableCategory: "FORMAT" } },
    { id: "invalid-routing-epoch-signature", source: "valid-routing-epoch-v1", mutation: { operation: "xor-frame-payload-last", frameType: "SIG1", value: 1 }, expected: { primaryCode: "EPOCH_SIGNATURE", portableCategory: "SIGNATURE" } },
    { id: "invalid-routing-epoch-trailing", source: "valid-routing-epoch-v1", mutation: { operation: "append", bytesHex: "00" }, expected: { primaryCode: "FORMAT_TRAILING", portableCategory: "FORMAT" } },
    { id: "invalid-checkpoint-signature", source: "valid-checkpoint-v1", mutation: { operation: "xor-frame-payload-last", frameType: "SIG1", value: 1 }, expected: { primaryCode: "CHECKPOINT_SIGNATURE", portableCategory: "SIGNATURE" } },
    { id: "invalid-witness-signature", source: "valid-witness-receipt-v1", mutation: { operation: "xor-frame-payload-last", frameType: "SIG1", value: 1 }, expected: { primaryCode: "WITNESS_SIGNATURE", portableCategory: "SIGNATURE" } },
  ];

  await writeFile(outputPath, `${JSON.stringify({
    schema: "org.glare9.g9p.conformance.v1",
    generatedAt: createdAt,
    privateKeyMaterialIncluded: false,
    valid,
    invalid,
  }, null, 2)}\n`);
  process.stdout.write(`Wrote ${valid.length} valid and ${invalid.length} invalid vectors to ${outputPath}\n`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
