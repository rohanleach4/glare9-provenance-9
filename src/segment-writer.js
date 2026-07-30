import { encodeCanonical } from "./codec/canonical.js";
import { compressBlock, decompressBlock, ZSTD_PROFILE } from "./compression.js";
import {
  domainHash,
  publicKeyId,
  signDomainCommitment,
  signCommitment,
  toHex,
} from "./crypto.js";
import { canonicalEventBytes, eventHash, validateEvent } from "./event.js";
import { invariant } from "./errors.js";
import { encodeFrame, FRAME_TYPES, G9P_MAGIC, G9P_MAGIC_V2 } from "./format/framing.js";
import { frameRecord } from "./format/records.js";
import { merkleRoot } from "./merkle.js";
import { writeExclusiveAndPromote } from "./sealed-file.js";
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

function partitionRecords(records, targetBytes, maxRecords, blockRecordCounts) {
  if (blockRecordCounts !== undefined) {
    invariant(Array.isArray(blockRecordCounts) && blockRecordCounts.length > 0, "BLOCK_PARTITION", "blockRecordCounts must contain at least one block");
    invariant(blockRecordCounts.every((count) => Number.isSafeInteger(count) && count > 0), "BLOCK_PARTITION", "Every explicit block record count must be a positive safe integer");
    invariant(blockRecordCounts.reduce((total, count) => total + count, 0) === records.length, "BLOCK_PARTITION", "Explicit block record counts must cover every segment record exactly once");
    let offset = 0;
    return blockRecordCounts.map((count) => {
      const block = records.slice(offset, offset + count).map((record) => ({
        ...record,
        framed: frameRecord(record.bytes),
      }));
      offset += count;
      return block;
    });
  }

  const blocks = [];
  let current = [];
  let currentBytes = 0;

  for (const record of records) {
    const framed = frameRecord(record.bytes);
    if (current.length > 0 && (currentBytes + framed.length > targetBytes || current.length >= maxRecords)) {
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

export async function writeSegment({
  outputPath,
  events,
  routingPolicy,
  segmentNumber,
  previousSegmentHash = null,
  routingEpoch = null,
  signer,
  createdAt = new Date().toISOString(),
  blockTargetBytes = DEFAULT_BLOCK_TARGET,
  blockMaxRecords = Number.MAX_SAFE_INTEGER,
  blockRecordCounts,
  precompressedBlocks,
  maxRecordBytes = DEFAULT_MAX_RECORD,
  testFaultInjector,
}) {
  invariant(Array.isArray(events) && events.length > 0, "SEGMENT_EVENTS", "A segment requires at least one event");
  invariant(Number.isSafeInteger(segmentNumber) && segmentNumber >= 0, "SEGMENT_NUMBER", "segmentNumber must be a non-negative safe integer");
  invariant(Number.isSafeInteger(blockTargetBytes) && blockTargetBytes >= 1024, "BLOCK_TARGET", "blockTargetBytes must be at least 1,024 bytes");
  invariant(Number.isSafeInteger(blockMaxRecords) && blockMaxRecords >= 1, "BLOCK_RECORD_LIMIT", "blockMaxRecords must be a positive safe integer");
  if (precompressedBlocks !== undefined) {
    invariant(Array.isArray(precompressedBlocks) && Array.isArray(blockRecordCounts) && precompressedBlocks.length === blockRecordCounts.length, "BLOCK_PRECOMPRESSED", "precompressedBlocks requires one entry for every explicit block");
  }
  invariant(Number.isSafeInteger(maxRecordBytes) && maxRecordBytes >= blockTargetBytes, "RECORD_LIMIT", "maxRecordBytes must be at least blockTargetBytes");
  invariant(signer?.algorithm === "ed25519" && signer.privateKey && signer.publicKeyDer instanceof Uint8Array, "SEGMENT_SIGNER", "An Ed25519 signer is required");
  invariant(signer.keyId === publicKeyId(signer.publicKeyDer), "SEGMENT_SIGNER_ID", "Signer keyId does not match its public key");
  canonicalTimestamp(createdAt, "createdAt");

  if (previousSegmentHash !== null) {
    invariant(previousSegmentHash instanceof Uint8Array && previousSegmentHash.byteLength === 32, "SEGMENT_PREVIOUS_HASH", "previousSegmentHash must be null or a 32-byte hash");
  }
  if (routingEpoch !== null) {
    invariant(Number.isSafeInteger(routingEpoch?.epochNumber) && routingEpoch.epochNumber >= 0, "SEGMENT_ROUTING_EPOCH", "routingEpoch.epochNumber must be a non-negative safe integer");
    invariant(routingEpoch.epochHash instanceof Uint8Array && routingEpoch.epochHash.byteLength === 32, "SEGMENT_ROUTING_EPOCH", "routingEpoch.epochHash must contain 32 bytes");
  }

  const formatVersion = routingEpoch === null ? 1 : 2;
  const profile = formatVersion === 1
    ? {
        magic: G9P_MAGIC,
        headerFrame: FRAME_TYPES.header,
        manifestFrame: FRAME_TYPES.manifest,
        headerHashDomain: "header-payload-v1",
        blockHashDomain: "block-payload-v1",
        signatureDomain: "segment-signature-v1",
        fileHashDomain: "segment-file-v1",
      }
    : {
        magic: G9P_MAGIC_V2,
        headerFrame: FRAME_TYPES.headerV2,
        manifestFrame: FRAME_TYPES.manifestV2,
        headerHashDomain: "header-payload-v2",
        blockHashDomain: "block-payload-v2",
        signatureDomain: "segment-signature-v2",
        fileHashDomain: "segment-file-v2",
      };

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
    formatVersion,
    ledgerId,
    shardId,
    segmentNumber,
    createdAt,
    previousSegmentHash: previousSegmentHash === null ? null : hashBytes(previousSegmentHash),
    ...(routingEpoch === null ? {} : {
      routingEpochNumber: routingEpoch.epochNumber,
      routingEpochHash: hashBytes(routingEpoch.epochHash),
    }),
    routingPolicy,
    compression: ZSTD_PROFILE,
  };
  const headerPayload = encodeCanonical(header);
  const headerFrame = encodeFrame(profile.headerFrame, headerPayload);

  const recordBlocks = partitionRecords(prepared, blockTargetBytes, blockMaxRecords, blockRecordCounts);
  let firstRecordIndex = 0;
  const encodedBlocks = recordBlocks.map((records, blockIndex) => {
    const uncompressed = Buffer.concat(records.map((record) => record.framed));
    const preparedBlock = precompressedBlocks?.[blockIndex];
    let compressed;
    if (preparedBlock === undefined) {
      testFaultInjector?.("segment.before-compression", { blockIndex, uncompressedLength: uncompressed.length });
      compressed = compressBlock(uncompressed);
      testFaultInjector?.("segment.after-compression", { blockIndex, compressedLength: compressed.length });
    } else {
      invariant(preparedBlock.data instanceof Uint8Array, "BLOCK_PRECOMPRESSED", `Precompressed block ${blockIndex} data must be bytes`);
      invariant(preparedBlock.uncompressedLength === uncompressed.length, "BLOCK_PRECOMPRESSED", `Precompressed block ${blockIndex} has the wrong uncompressed length`);
      const expectedHash = domainHash("record-block-v1", uncompressed);
      invariant(preparedBlock.recordsHash instanceof Uint8Array && Buffer.from(preparedBlock.recordsHash).equals(Buffer.from(expectedHash)), "BLOCK_PRECOMPRESSED", `Precompressed block ${blockIndex} has the wrong records hash`);
      const recovered = decompressBlock(preparedBlock.data, uncompressed.length, uncompressed.length);
      invariant(Buffer.from(recovered).equals(uncompressed), "BLOCK_PRECOMPRESSED", `Precompressed block ${blockIndex} does not contain the expected records`);
      compressed = Buffer.from(preparedBlock.data);
    }
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
      payloadHash: hashBytes(domainHash(profile.blockHashDomain, payload)),
    };
    firstRecordIndex += records.length;
    return { frame: encodeFrame(FRAME_TYPES.block, payload), commitment };
  });

  const manifest = {
    kind: "g9p-segment-manifest",
    manifestVersion: formatVersion,
    headerHash: hashBytes(domainHash(profile.headerHashDomain, headerPayload)),
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
  const signature = formatVersion === 1
    ? signCommitment(signer.privateKey, manifestPayload)
    : signDomainCommitment(signer.privateKey, profile.signatureDomain, manifestPayload);
  const signaturePayload = encodeCanonical({
    algorithm: signer.algorithm,
    keyId: signer.keyId,
    signature: Uint8Array.from(signature),
  });

  const fileBytes = Buffer.concat([
    profile.magic,
    headerFrame,
    ...encodedBlocks.map((block) => block.frame),
    encodeFrame(profile.manifestFrame, manifestPayload),
    encodeFrame(FRAME_TYPES.signature, signaturePayload),
    encodeFrame(FRAME_TYPES.end),
  ]);

  await writeExclusiveAndPromote(outputPath, fileBytes, {
    errorCode: "SEGMENT_WRITE",
    extensionErrorCode: "SEGMENT_EXTENSION",
    description: "sealed segment",
    testFaultInjector,
  });
  const segmentHash = domainHash(profile.fileHashDomain, fileBytes);

  return {
    outputPath,
    formatVersion,
    ledgerId,
    shardId,
    segmentNumber,
    routingEpochNumber: routingEpoch?.epochNumber ?? null,
    routingEpochHash: routingEpoch === null ? null : toHex(routingEpoch.epochHash),
    blockCount: encodedBlocks.length,
    recordCount: prepared.length,
    logicalRoot: toHex(manifest.recordMerkleRoot),
    segmentHash: toHex(segmentHash),
    signerKeyId: signer.keyId,
    byteLength: fileBytes.length,
  };
}
