import { readFile, stat } from "node:fs/promises";

import { decodeCanonical } from "./codec/canonical.js";
import { decompressBlock, ZSTD_PROFILE } from "./compression.js";
import {
  domainHash,
  importPublicKey,
  publicKeyId,
  toHex,
  verifyCommitment,
  verifyDomainCommitment,
} from "./crypto.js";
import { decodeEvent, eventHash } from "./event.js";
import { fail, invariant } from "./errors.js";
import { FrameReader, FRAME_TYPES, G9P_MAGIC, G9P_MAGIC_V2 } from "./format/framing.js";
import { readFramedRecords } from "./format/records.js";
import { merkleRoot } from "./merkle.js";
import { ROUTING_POLICY_ID, routeEvent } from "./sharding.js";

const DEFAULT_LIMITS = Object.freeze({
  maxFileBytes: 512 * 1024 * 1024,
  maxFrameBytes: 64 * 1024 * 1024,
  maxBlockOutputBytes: 64 * 1024 * 1024,
  maxRecordBytes: 16 * 1024 * 1024,
  maxBlocks: 65_536,
  maxRecords: 10_000_000,
});

function plainObject(value, name) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Uint8Array), "VERIFY_OBJECT", `${name} must be an object`);
  return value;
}

function exactFields(value, fields, name, formatVersion = 1) {
  const expected = [...fields].sort();
  const actual = Object.keys(value).sort();
  invariant(actual.length === expected.length && actual.every((field, index) => field === expected[index]), "VERIFY_FIELDS", `${name} fields do not match format version ${formatVersion}`);
}

function bytesOfLength(value, length, name) {
  invariant(value instanceof Uint8Array && value.byteLength === length, "VERIFY_BYTES", `${name} must contain ${length} bytes`);
  return Buffer.from(value);
}

function safeInteger(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  invariant(Number.isSafeInteger(value) && value >= min && value <= max, "VERIFY_INTEGER", `${name} is outside its permitted range`);
  return value;
}

function canonicalTimestamp(value, name) {
  invariant(typeof value === "string", "VERIFY_TIMESTAMP", `${name} must be a string`);
  const parsed = new Date(value);
  invariant(!Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value, "VERIFY_TIMESTAMP", `${name} must be a canonical UTC ISO-8601 timestamp`);
}

function validateRoutingPolicy(policy) {
  plainObject(policy, "routingPolicy");
  exactFields(policy, ["id", "version", "shardCount"], "routingPolicy");
  invariant(policy.id === ROUTING_POLICY_ID && policy.version === 1, "VERIFY_ROUTING_POLICY", "Unsupported routing policy");
  safeInteger(policy.shardCount, "routingPolicy.shardCount", { min: 1, max: 65_536 });
}

function validateCompressionProfile(profile) {
  plainObject(profile, "compression profile");
  exactFields(profile, ["algorithm", "profile", "level", "checksum", "contentSize"], "compression profile");
  invariant(
    profile.algorithm === ZSTD_PROFILE.algorithm
      && profile.profile === ZSTD_PROFILE.profile
      && profile.level === ZSTD_PROFILE.level
      && profile.checksum === ZSTD_PROFILE.checksum
      && profile.contentSize === ZSTD_PROFILE.contentSize,
    "VERIFY_COMPRESSION_PROFILE",
    "Unsupported compression profile",
  );
}

function validateHeader(header, formatVersion) {
  plainObject(header, "header");
  const fields = [
    "kind",
    "formatVersion",
    "ledgerId",
    "shardId",
    "segmentNumber",
    "createdAt",
    "previousSegmentHash",
    "routingPolicy",
    "compression",
  ];
  if (formatVersion === 2) fields.push("routingEpochNumber", "routingEpochHash");
  exactFields(header, fields, "header", formatVersion);
  invariant(header.kind === "g9p-segment" && header.formatVersion === formatVersion, "VERIFY_FORMAT_VERSION", "Unsupported G9P segment format");
  invariant(typeof header.ledgerId === "string" && header.ledgerId.length > 0, "VERIFY_LEDGER", "header.ledgerId is invalid");
  invariant(typeof header.shardId === "string" && /^shard-[0-9]{4}$/u.test(header.shardId), "VERIFY_SHARD", "header.shardId is invalid");
  safeInteger(header.segmentNumber, "header.segmentNumber");
  canonicalTimestamp(header.createdAt, "header.createdAt");
  if (header.previousSegmentHash !== null) bytesOfLength(header.previousSegmentHash, 32, "header.previousSegmentHash");
  if (formatVersion === 2) {
    safeInteger(header.routingEpochNumber, "header.routingEpochNumber");
    bytesOfLength(header.routingEpochHash, 32, "header.routingEpochHash");
  }
  validateRoutingPolicy(header.routingPolicy);
  validateCompressionProfile(header.compression);
}

function validateBlock(block, limits) {
  plainObject(block, "block");
  exactFields(block, ["blockIndex", "firstRecordIndex", "recordCount", "uncompressedLength", "compression", "recordsHash", "data"], "block");
  safeInteger(block.blockIndex, "block.blockIndex", { max: limits.maxBlocks - 1 });
  safeInteger(block.firstRecordIndex, "block.firstRecordIndex", { max: limits.maxRecords });
  safeInteger(block.recordCount, "block.recordCount", { min: 1, max: limits.maxRecords });
  safeInteger(block.uncompressedLength, "block.uncompressedLength", { min: 1, max: limits.maxBlockOutputBytes });
  invariant(block.compression === ZSTD_PROFILE.algorithm, "VERIFY_BLOCK_COMPRESSION", "Unsupported block compression algorithm");
  bytesOfLength(block.recordsHash, 32, "block.recordsHash");
  invariant(block.data instanceof Uint8Array && block.data.byteLength > 0, "VERIFY_BLOCK_DATA", "Compressed block data is missing");
}

function validateManifest(manifest, limits, formatVersion) {
  plainObject(manifest, "manifest");
  exactFields(manifest, ["kind", "manifestVersion", "headerHash", "recordCount", "blockCount", "recordMerkleRoot", "blocks", "signer"], "manifest", formatVersion);
  invariant(manifest.kind === "g9p-segment-manifest" && manifest.manifestVersion === formatVersion, "VERIFY_MANIFEST_VERSION", "Unsupported G9P manifest format");
  bytesOfLength(manifest.headerHash, 32, "manifest.headerHash");
  safeInteger(manifest.recordCount, "manifest.recordCount", { min: 1, max: limits.maxRecords });
  safeInteger(manifest.blockCount, "manifest.blockCount", { min: 1, max: limits.maxBlocks });
  bytesOfLength(manifest.recordMerkleRoot, 32, "manifest.recordMerkleRoot");
  invariant(Array.isArray(manifest.blocks) && manifest.blocks.length === manifest.blockCount, "VERIFY_MANIFEST_BLOCKS", "Manifest block list does not match blockCount");

  manifest.blocks.forEach((commitment, index) => {
    plainObject(commitment, `manifest.blocks[${index}]`);
    exactFields(commitment, ["blockIndex", "firstRecordIndex", "recordCount", "payloadHash"], `manifest.blocks[${index}]`);
    invariant(commitment.blockIndex === index, "VERIFY_BLOCK_ORDER", "Manifest block indexes must be contiguous and ordered");
    safeInteger(commitment.firstRecordIndex, "block commitment firstRecordIndex", { max: limits.maxRecords });
    safeInteger(commitment.recordCount, "block commitment recordCount", { min: 1, max: limits.maxRecords });
    bytesOfLength(commitment.payloadHash, 32, "block commitment payloadHash");
  });

  plainObject(manifest.signer, "manifest.signer");
  exactFields(manifest.signer, ["algorithm", "keyId", "publicKey"], "manifest.signer");
  invariant(manifest.signer.algorithm === "ed25519", "VERIFY_SIGNATURE_ALGORITHM", "Unsupported segment signature algorithm");
  invariant(typeof manifest.signer.keyId === "string" && /^[0-9a-f]{64}$/u.test(manifest.signer.keyId), "VERIFY_KEY_ID", "Signer key ID is invalid");
  invariant(manifest.signer.publicKey instanceof Uint8Array, "VERIFY_PUBLIC_KEY", "Signer public key is missing");
}

function validateSignature(signature, manifest) {
  plainObject(signature, "signature");
  exactFields(signature, ["algorithm", "keyId", "signature"], "signature");
  invariant(signature.algorithm === manifest.signer.algorithm, "VERIFY_SIGNATURE_ALGORITHM", "Signature algorithm does not match manifest signer");
  invariant(signature.keyId === manifest.signer.keyId, "VERIFY_KEY_ID", "Signature key ID does not match manifest signer");
  invariant(signature.signature instanceof Uint8Array && signature.signature.byteLength === 64, "VERIFY_SIGNATURE_LENGTH", "Ed25519 signature must contain 64 bytes");
}

function buffersEqual(left, right, code, message) {
  invariant(Buffer.from(left).equals(Buffer.from(right)), code, message);
}

export async function verifySegment(path, options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const fileStat = await stat(path);
  invariant(fileStat.isFile(), "VERIFY_FILE", "Segment path is not a file");
  invariant(fileStat.size <= limits.maxFileBytes, "VERIFY_FILE_LIMIT", `Segment exceeds the ${limits.maxFileBytes} byte file limit`);
  return verifySegmentBytes(await readFile(path), { ...options, source: path });
}

export async function verifySegmentBytes(bytes, options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  invariant(bytes instanceof Uint8Array, "VERIFY_FILE", "Segment content must be bytes");
  invariant(bytes.byteLength <= limits.maxFileBytes, "VERIFY_FILE_LIMIT", `Segment exceeds the ${limits.maxFileBytes} byte file limit`);
  const fileBytes = Buffer.from(bytes);

  const profile = fileBytes.subarray(0, G9P_MAGIC.length).equals(G9P_MAGIC)
    ? {
        formatVersion: 1,
        magic: G9P_MAGIC,
        headerFrame: FRAME_TYPES.header,
        manifestFrame: FRAME_TYPES.manifest,
        headerHashDomain: "header-payload-v1",
        blockHashDomain: "block-payload-v1",
        signatureDomain: "segment-signature-v1",
        fileHashDomain: "segment-file-v1",
      }
    : fileBytes.subarray(0, G9P_MAGIC_V2.length).equals(G9P_MAGIC_V2)
      ? {
          formatVersion: 2,
          magic: G9P_MAGIC_V2,
          headerFrame: FRAME_TYPES.headerV2,
          manifestFrame: FRAME_TYPES.manifestV2,
          headerHashDomain: "header-payload-v2",
          blockHashDomain: "block-payload-v2",
          signatureDomain: "segment-signature-v2",
          fileHashDomain: "segment-file-v2",
        }
      : null;
  invariant(profile !== null, "FORMAT_MAGIC", "File does not contain a supported G9P segment magic header");

  const reader = new FrameReader(fileBytes, { maxFrameBytes: limits.maxFrameBytes });
  reader.readMagic(profile.magic);
  const headerFrame = reader.readFrame(profile.headerFrame);

  const blockFrames = [];
  while (reader.peekType() === FRAME_TYPES.block) {
    invariant(blockFrames.length < limits.maxBlocks, "VERIFY_BLOCK_LIMIT", `Segment exceeds the ${limits.maxBlocks} block limit`);
    blockFrames.push(reader.readFrame(FRAME_TYPES.block));
  }
  invariant(blockFrames.length > 0, "VERIFY_BLOCKS", "Segment does not contain a record block");

  const manifestFrame = reader.readFrame(profile.manifestFrame);
  const signatureFrame = reader.readFrame(FRAME_TYPES.signature);
  const endFrame = reader.readFrame(FRAME_TYPES.end);
  invariant(endFrame.payload.length === 0, "VERIFY_END_FRAME", "End frame must be empty");
  reader.assertEnd();

  const header = decodeCanonical(headerFrame.payload);
  const blocks = blockFrames.map((frame) => decodeCanonical(frame.payload));
  const manifest = decodeCanonical(manifestFrame.payload);
  const signature = decodeCanonical(signatureFrame.payload);

  validateHeader(header, profile.formatVersion);
  blocks.forEach((block) => validateBlock(block, limits));
  validateManifest(manifest, limits, profile.formatVersion);
  validateSignature(signature, manifest);

  invariant(blocks.length === manifest.blockCount, "VERIFY_BLOCK_COUNT", "Physical block count does not match manifest");
  buffersEqual(
    manifest.headerHash,
    domainHash(profile.headerHashDomain, headerFrame.payload),
    "VERIFY_HEADER_HASH",
    "Header commitment does not match the stored header",
  );

  let expectedFirstRecordIndex = 0;
  blocks.forEach((block, index) => {
    const commitment = manifest.blocks[index];
    invariant(block.blockIndex === index && commitment.blockIndex === index, "VERIFY_BLOCK_ORDER", "Block indexes must be contiguous and ordered");
    invariant(block.firstRecordIndex === expectedFirstRecordIndex && commitment.firstRecordIndex === expectedFirstRecordIndex, "VERIFY_RECORD_ORDER", "Block record ranges are not contiguous");
    invariant(block.recordCount === commitment.recordCount, "VERIFY_BLOCK_RECORD_COUNT", "Block record count does not match its commitment");
    buffersEqual(
      commitment.payloadHash,
      domainHash(profile.blockHashDomain, blockFrames[index].payload),
      "VERIFY_BLOCK_HASH",
      `Block ${index} payload commitment does not match`,
    );
    expectedFirstRecordIndex += block.recordCount;
  });
  invariant(expectedFirstRecordIndex === manifest.recordCount, "VERIFY_RECORD_COUNT", "Block record ranges do not match manifest recordCount");

  const publicKeyDer = Buffer.from(manifest.signer.publicKey);
  invariant(publicKeyId(publicKeyDer) === manifest.signer.keyId, "VERIFY_KEY_ID", "Embedded public key does not match its key ID");
  let publicKey;
  try {
    publicKey = importPublicKey(publicKeyDer);
  } catch (error) {
    fail("VERIFY_PUBLIC_KEY", "Embedded Ed25519 public key could not be imported", error);
  }
  const signatureValid = profile.formatVersion === 1
    ? verifyCommitment(publicKey, manifestFrame.payload, Buffer.from(signature.signature))
    : verifyDomainCommitment(publicKey, profile.signatureDomain, manifestFrame.payload, Buffer.from(signature.signature));
  invariant(
    signatureValid,
    "VERIFY_SIGNATURE",
    "Segment signature is invalid",
  );

  const trustedKeyIds = options.trustedKeyIds === undefined
    ? new Set()
    : options.trustedKeyIds instanceof Set
      ? options.trustedKeyIds
      : new Set(options.trustedKeyIds);
  const signerTrusted = trustedKeyIds.has(manifest.signer.keyId);
  if (options.requireTrustedSigner === true) {
    invariant(signerTrusted, "VERIFY_UNTRUSTED_SIGNER", `Signer ${manifest.signer.keyId} is not in the trusted key set`);
  }

  if (options.expectedPreviousSegmentHash !== undefined) {
    if (options.expectedPreviousSegmentHash === null) {
      invariant(header.previousSegmentHash === null, "VERIFY_PREVIOUS_SEGMENT", "Segment unexpectedly links to a previous segment");
    } else {
      buffersEqual(header.previousSegmentHash, options.expectedPreviousSegmentHash, "VERIFY_PREVIOUS_SEGMENT", "Previous segment link does not match the expected segment hash");
    }
  }

  if (options.expectedLedgerId !== undefined) {
    invariant(header.ledgerId === options.expectedLedgerId, "VERIFY_LEDGER", "Segment ledger ID does not match the expected ledger");
  }
  if (options.expectedShardId !== undefined) {
    invariant(header.shardId === options.expectedShardId, "VERIFY_SHARD", "Segment shard ID does not match the expected shard");
  }
  if (options.expectedRoutingEpochNumber !== undefined) {
    invariant(profile.formatVersion === 2 && header.routingEpochNumber === options.expectedRoutingEpochNumber, "VERIFY_ROUTING_EPOCH", "Segment routing epoch number does not match the expected epoch");
  }
  if (options.expectedRoutingEpochHash !== undefined) {
    invariant(profile.formatVersion === 2, "VERIFY_ROUTING_EPOCH", "Version 1 segment does not authenticate a routing epoch");
    buffersEqual(header.routingEpochHash, options.expectedRoutingEpochHash, "VERIFY_ROUTING_EPOCH", "Segment routing epoch hash does not match the expected descriptor");
  }

  const events = [];
  const recordHashes = [];
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const block = blocks[blockIndex];
    const uncompressed = decompressBlock(block.data, block.uncompressedLength, limits.maxBlockOutputBytes);
    buffersEqual(
      block.recordsHash,
      domainHash("record-block-v1", uncompressed),
      "VERIFY_RECORD_BLOCK_HASH",
      `Block ${blockIndex} uncompressed record commitment does not match`,
    );

    const recordBytes = readFramedRecords(uncompressed, block.recordCount, { maxRecordBytes: limits.maxRecordBytes });
    for (const bytes of recordBytes) {
      const event = decodeEvent(bytes);
      invariant(event.ledgerId === header.ledgerId, "VERIFY_EVENT_LEDGER", `Event ${event.eventId} belongs to a different ledger`);
      const route = routeEvent(event, header.routingPolicy);
      invariant(route.shardId === header.shardId, "VERIFY_EVENT_SHARD", `Event ${event.eventId} does not route to this segment's shard`);
      events.push(event);
      recordHashes.push(eventHash(bytes));
    }
  }

  invariant(events.length === manifest.recordCount, "VERIFY_RECORD_COUNT", "Decoded record count does not match manifest");
  buffersEqual(
    manifest.recordMerkleRoot,
    merkleRoot(recordHashes),
    "VERIFY_MERKLE_ROOT",
    "Record Merkle root does not match decoded records",
  );

  const segmentHash = domainHash(profile.fileHashDomain, fileBytes);
  return {
    valid: true,
    path: options.source ?? null,
    formatVersion: profile.formatVersion,
    ledgerId: header.ledgerId,
    shardId: header.shardId,
    segmentNumber: header.segmentNumber,
    previousSegmentHash: header.previousSegmentHash === null ? null : toHex(header.previousSegmentHash),
    routingEpochNumber: profile.formatVersion === 2 ? header.routingEpochNumber : null,
    routingEpochHash: profile.formatVersion === 2 ? toHex(header.routingEpochHash) : null,
    routingPolicy: {
      id: header.routingPolicy.id,
      version: header.routingPolicy.version,
      shardCount: header.routingPolicy.shardCount,
    },
    blockCount: manifest.blockCount,
    recordCount: manifest.recordCount,
    logicalRoot: toHex(manifest.recordMerkleRoot),
    segmentHash: toHex(segmentHash),
    signerKeyId: manifest.signer.keyId,
    signerTrusted,
    trustStatus: signerTrusted ? "trusted-key" : "untrusted-embedded-key",
    byteLength: fileBytes.length,
    events: options.includeEvents === false ? undefined : events,
  };
}

export const verifierLimits = DEFAULT_LIMITS;
