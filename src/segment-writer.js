import { open, link, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import { encodeCanonical } from "./codec/canonical.js";
import { compressBlock, ZSTD_PROFILE } from "./compression.js";
import {
  domainHash,
  publicKeyId,
  signCommitment,
  toHex,
} from "./crypto.js";
import { canonicalEventBytes, eventHash, validateEvent } from "./event.js";
import { fail, invariant } from "./errors.js";
import { encodeFrame, FRAME_TYPES, G9P_MAGIC } from "./format/framing.js";
import { frameRecord } from "./format/records.js";
import { merkleRoot } from "./merkle.js";
import { routeEvent } from "./sharding.js";

const DEFAULT_BLOCK_TARGET = 1 * 1024 * 1024;
const DEFAULT_MAX_RECORD = 16 * 1024 * 1024;

function canonicalTimestamp(value, name) {
  invariant(typeof value === "string", "SEGMENT_TIMESTAMP", `${name} must be a string`);
  const parsed = new Date(value);
  invariant(!Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value, "SEGMENT_TIMESTAMP", `${name} must be a canonical UTC ISO-8601 timestamp`);
  return value;
}

function hashBytes(bytes) {
  return Uint8Array.from(bytes);
}

function partitionRecords(records, targetBytes) {
  const blocks = [];
  let current = [];
  let currentBytes = 0;

  for (const record of records) {
    const framed = frameRecord(record.bytes);
    if (current.length > 0 && currentBytes + framed.length > targetBytes) {
      blocks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push({ ...record, framed });
    currentBytes += framed.length;
  }

  if (current.length > 0) blocks.push(current);
  return blocks;
}

async function writeExclusiveAndPromote(outputPath, fileBytes) {
  invariant(outputPath.endsWith(".g9p"), "SEGMENT_EXTENSION", "Sealed segment output path must end with .g9p");
  const partPath = `${outputPath}.part`;
  await mkdir(dirname(outputPath), { recursive: true });

  let handle;
  try {
    handle = await open(partPath, "wx", 0o600);
    await handle.writeFile(fileBytes);
    await handle.sync();
    await handle.close();
    handle = undefined;

    // A hard-link promotion is atomic and refuses to replace an existing sealed segment.
    await link(partPath, outputPath);
    await unlink(partPath);
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => {});
    }
    fail("SEGMENT_WRITE", `Could not write and promote sealed segment at ${outputPath}`, error);
  }
}

export async function writeSegment({
  outputPath,
  events,
  routingPolicy,
  segmentNumber,
  previousSegmentHash = null,
  signer,
  createdAt = new Date().toISOString(),
  blockTargetBytes = DEFAULT_BLOCK_TARGET,
  maxRecordBytes = DEFAULT_MAX_RECORD,
}) {
  invariant(Array.isArray(events) && events.length > 0, "SEGMENT_EVENTS", "A segment requires at least one event");
  invariant(Number.isSafeInteger(segmentNumber) && segmentNumber >= 0, "SEGMENT_NUMBER", "segmentNumber must be a non-negative safe integer");
  invariant(Number.isSafeInteger(blockTargetBytes) && blockTargetBytes >= 1024, "BLOCK_TARGET", "blockTargetBytes must be at least 1,024 bytes");
  invariant(Number.isSafeInteger(maxRecordBytes) && maxRecordBytes >= blockTargetBytes, "RECORD_LIMIT", "maxRecordBytes must be at least blockTargetBytes");
  invariant(signer?.algorithm === "ed25519" && signer.privateKey && signer.publicKeyDer instanceof Uint8Array, "SEGMENT_SIGNER", "An Ed25519 signer is required");
  invariant(signer.keyId === publicKeyId(signer.publicKeyDer), "SEGMENT_SIGNER_ID", "Signer keyId does not match its public key");
  canonicalTimestamp(createdAt, "createdAt");

  if (previousSegmentHash !== null) {
    invariant(previousSegmentHash instanceof Uint8Array && previousSegmentHash.byteLength === 32, "SEGMENT_PREVIOUS_HASH", "previousSegmentHash must be null or a 32-byte hash");
  }

  const prepared = events.map((event) => {
    validateEvent(event);
    const route = routeEvent(event, routingPolicy);
    const bytes = canonicalEventBytes(event);
    invariant(bytes.length <= maxRecordBytes, "RECORD_LIMIT", `Event ${event.eventId} exceeds the ${maxRecordBytes} byte record limit`);
    return { event, route, bytes, hash: eventHash(bytes) };
  });

  const ledgerId = prepared[0].event.ledgerId;
  const shardId = prepared[0].route.shardId;
  for (const record of prepared) {
    invariant(record.event.ledgerId === ledgerId, "SEGMENT_LEDGER", "All segment events must belong to one ledger");
    invariant(record.route.shardId === shardId, "SEGMENT_SHARD", "All segment events must route to one shard");
  }

  const header = {
    kind: "g9p-segment",
    formatVersion: 1,
    ledgerId,
    shardId,
    segmentNumber,
    createdAt,
    previousSegmentHash: previousSegmentHash === null ? null : hashBytes(previousSegmentHash),
    routingPolicy,
    compression: ZSTD_PROFILE,
  };
  const headerPayload = encodeCanonical(header);
  const headerFrame = encodeFrame(FRAME_TYPES.header, headerPayload);

  const recordBlocks = partitionRecords(prepared, blockTargetBytes);
  let firstRecordIndex = 0;
  const encodedBlocks = recordBlocks.map((records, blockIndex) => {
    const uncompressed = Buffer.concat(records.map((record) => record.framed));
    const compressed = compressBlock(uncompressed);
    const block = {
      blockIndex,
      firstRecordIndex,
      recordCount: records.length,
      uncompressedLength: uncompressed.length,
      compression: ZSTD_PROFILE.algorithm,
      recordsHash: hashBytes(domainHash("record-block-v1", uncompressed)),
      data: Uint8Array.from(compressed),
    };
    const payload = encodeCanonical(block);
    const commitment = {
      blockIndex,
      firstRecordIndex,
      recordCount: records.length,
      payloadHash: hashBytes(domainHash("block-payload-v1", payload)),
    };
    firstRecordIndex += records.length;
    return { frame: encodeFrame(FRAME_TYPES.block, payload), commitment };
  });

  const manifest = {
    kind: "g9p-segment-manifest",
    manifestVersion: 1,
    headerHash: hashBytes(domainHash("header-payload-v1", headerPayload)),
    recordCount: prepared.length,
    blockCount: encodedBlocks.length,
    recordMerkleRoot: hashBytes(merkleRoot(prepared.map((record) => record.hash))),
    blocks: encodedBlocks.map((block) => block.commitment),
    signer: {
      algorithm: signer.algorithm,
      keyId: signer.keyId,
      publicKey: Uint8Array.from(signer.publicKeyDer),
    },
  };
  const manifestPayload = encodeCanonical(manifest);
  const signature = signCommitment(signer.privateKey, manifestPayload);
  const signaturePayload = encodeCanonical({
    algorithm: signer.algorithm,
    keyId: signer.keyId,
    signature: Uint8Array.from(signature),
  });

  const fileBytes = Buffer.concat([
    G9P_MAGIC,
    headerFrame,
    ...encodedBlocks.map((block) => block.frame),
    encodeFrame(FRAME_TYPES.manifest, manifestPayload),
    encodeFrame(FRAME_TYPES.signature, signaturePayload),
    encodeFrame(FRAME_TYPES.end),
  ]);

  await writeExclusiveAndPromote(outputPath, fileBytes);
  const segmentHash = domainHash("segment-file-v1", fileBytes);

  return {
    outputPath,
    ledgerId,
    shardId,
    segmentNumber,
    blockCount: encodedBlocks.length,
    recordCount: prepared.length,
    logicalRoot: toHex(manifest.recordMerkleRoot),
    segmentHash: toHex(segmentHash),
    signerKeyId: signer.keyId,
    byteLength: fileBytes.length,
  };
}
