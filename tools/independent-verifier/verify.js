#!/usr/bin/env node

// Deliberately imports no Glare•9 production modules. This is a second
// implementation of the stored-byte verification rules, kept in one file so
// reviewers can audit its independence from src/.
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { zstdDecompressSync } from "node:zlib";

const MAGIC_V1 = Buffer.from([0x47, 0x39, 0x50, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
const MAGIC_V2 = Buffer.from([0x47, 0x39, 0x50, 0x0d, 0x0a, 0x1a, 0x0a, 0x02]);
const MAX_FILE = 512 * 1024 * 1024;
const MAX_FRAME = 64 * 1024 * 1024;
const MAX_BLOCK_OUTPUT = 64 * 1024 * 1024;
const MAX_RECORD = 16 * 1024 * 1024;

function reject(category, code, message) {
  const error = new Error(message);
  error.category = category;
  error.code = code;
  throw error;
}

function requireThat(condition, category, code, message) {
  if (!condition) reject(category, code, message);
}

function u64(value) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}

function domainHash(domain, ...parts) {
  const hash = createHash("sha256");
  const prefix = Buffer.from(`G9P\0${domain}`, "utf8");
  hash.update(u64(prefix.length));
  hash.update(prefix);
  for (const part of parts) {
    const bytes = Buffer.from(part);
    hash.update(u64(bytes.length));
    hash.update(bytes);
  }
  return hash.digest();
}

function varUint(value) {
  const output = [];
  let remaining = BigInt(value);
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining > 0n) byte |= 0x80;
    output.push(byte);
  } while (remaining > 0n);
  return Buffer.from(output);
}

function encodeCanonical(value) {
  if (value === null) return Buffer.from([0x00]);
  if (value === false) return Buffer.from([0x01]);
  if (value === true) return Buffer.from([0x02]);
  if (typeof value === "number") {
    if (Number.isSafeInteger(value)) {
      const integer = BigInt(value);
      const zigzag = integer >= 0n ? integer * 2n : (-integer * 2n) - 1n;
      return Buffer.concat([Buffer.from([0x10]), varUint(zigzag)]);
    }
    const bytes = Buffer.alloc(9);
    bytes[0] = 0x11;
    bytes.writeDoubleBE(value, 1);
    return bytes;
  }
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([Buffer.from([0x20]), varUint(bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) {
    const bytes = Buffer.from(value);
    return Buffer.concat([Buffer.from([0x30]), varUint(bytes.length), bytes]);
  }
  if (Array.isArray(value)) {
    return Buffer.concat([Buffer.from([0x40]), varUint(value.length), ...value.map(encodeCanonical)]);
  }
  requireThat(value !== null && typeof value === "object", "CANONICAL", "VALUE_TYPE", "unsupported canonical value");
  const entries = Object.entries(value).map(([key, item]) => [Buffer.from(key, "utf8"), key, item]);
  entries.sort((left, right) => Buffer.compare(left[0], right[0]));
  return Buffer.concat([
    Buffer.from([0x50]),
    varUint(entries.length),
    ...entries.flatMap(([, key, item]) => [encodeCanonical(key), encodeCanonical(item)]),
  ]);
}

class CanonicalReader {
  constructor(bytes) {
    this.bytes = Buffer.from(bytes);
    this.offset = 0;
  }

  take(length) {
    requireThat(Number.isSafeInteger(length) && length >= 0 && this.offset + length <= this.bytes.length, "CANONICAL", "TRUNCATED", "canonical value is truncated");
    const result = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return result;
  }

  byte() {
    return this.take(1)[0];
  }

  uintBig() {
    let value = 0n;
    let shift = 0n;
    let count = 0;
    let final = 0;
    while (true) {
      requireThat(count < 10, "CANONICAL", "VARUINT", "canonical varuint is too large");
      const byte = this.byte();
      final = byte & 0x7f;
      value |= BigInt(final) << shift;
      count += 1;
      if ((byte & 0x80) === 0) break;
      shift += 7n;
    }
    requireThat(count === 1 || final !== 0, "CANONICAL", "NON_MINIMAL", "canonical varuint is not minimal");
    return value;
  }

  length() {
    const value = this.uintBig();
    requireThat(value <= BigInt(Number.MAX_SAFE_INTEGER), "RESOURCE_LIMIT", "INTEGER_LIMIT", "canonical length exceeds safe range");
    return Number(value);
  }

  value(depth = 0) {
    requireThat(depth <= 64, "RESOURCE_LIMIT", "DEPTH_LIMIT", "canonical nesting exceeds 64");
    const tag = this.byte();
    if (tag === 0x00) return null;
    if (tag === 0x01) return false;
    if (tag === 0x02) return true;
    if (tag === 0x10) {
      const encoded = this.uintBig();
      const integer = (encoded & 1n) === 0n ? encoded / 2n : -((encoded + 1n) / 2n);
      requireThat(integer >= BigInt(Number.MIN_SAFE_INTEGER) && integer <= BigInt(Number.MAX_SAFE_INTEGER), "RESOURCE_LIMIT", "INTEGER_LIMIT", "canonical integer exceeds safe range");
      return Number(integer);
    }
    if (tag === 0x11) {
      const number = this.take(8).readDoubleBE(0);
      requireThat(Number.isFinite(number) && !Number.isSafeInteger(number), "CANONICAL", "NUMBER", "non-canonical float");
      return number;
    }
    if (tag === 0x20 || tag === 0x30) {
      const length = this.length();
      requireThat(length <= MAX_FRAME, "RESOURCE_LIMIT", "VALUE_LIMIT", "canonical byte value exceeds limit");
      const bytes = this.take(length);
      if (tag === 0x30) return Uint8Array.from(bytes);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return text;
    }
    if (tag === 0x40) {
      const length = this.length();
      requireThat(length <= 1_000_000, "RESOURCE_LIMIT", "COLLECTION_LIMIT", "canonical array exceeds limit");
      return Array.from({ length }, () => this.value(depth + 1));
    }
    if (tag === 0x50) {
      const length = this.length();
      requireThat(length <= 1_000_000, "RESOURCE_LIMIT", "COLLECTION_LIMIT", "canonical map exceeds limit");
      const result = Object.create(null);
      let previous = null;
      for (let index = 0; index < length; index += 1) {
        requireThat(this.byte() === 0x20, "CANONICAL", "MAP_KEY", "canonical map key is not text");
        const keyLength = this.length();
        const keyBytes = this.take(keyLength);
        requireThat(previous === null || Buffer.compare(previous, keyBytes) < 0, "CANONICAL", "MAP_ORDER", "canonical map keys are duplicated or unordered");
        previous = keyBytes;
        const key = new TextDecoder("utf-8", { fatal: true }).decode(keyBytes);
        result[key] = this.value(depth + 1);
      }
      return result;
    }
    reject("CANONICAL", "TAG", `unknown canonical tag ${tag}`);
  }
}

function decodeCanonical(bytes) {
  const reader = new CanonicalReader(bytes);
  const value = reader.value();
  requireThat(reader.offset === reader.bytes.length, "CANONICAL", "TRAILING_VALUE", "canonical value has trailing bytes");
  requireThat(Buffer.from(bytes).equals(encodeCanonical(value)), "CANONICAL", "REENCODE", "canonical value does not round trip identically");
  return value;
}

class ContainerReader {
  constructor(bytes, magic) {
    this.bytes = Buffer.from(bytes);
    this.offset = magic.length;
    requireThat(this.bytes.subarray(0, magic.length).equals(magic), "FORMAT", "MAGIC", "unsupported G9P magic");
  }

  peek() {
    requireThat(this.offset + 8 <= this.bytes.length, "FORMAT", "TRUNCATED", "container is truncated before a frame");
    return this.bytes.toString("ascii", this.offset, this.offset + 4);
  }

  frame(expected) {
    const type = this.peek();
    requireThat(type === expected, "FORMAT", "FRAME_ORDER", `expected ${expected}, found ${type}`);
    const length = this.bytes.readUInt32BE(this.offset + 4);
    requireThat(length <= MAX_FRAME, "RESOURCE_LIMIT", "FRAME_LIMIT", "frame exceeds limit");
    requireThat(this.offset + 8 + length <= this.bytes.length, "FORMAT", "TRUNCATED", `${type} frame is truncated`);
    const payload = this.bytes.subarray(this.offset + 8, this.offset + 8 + length);
    this.offset += 8 + length;
    return { type, payload };
  }

  end() {
    requireThat(this.offset === this.bytes.length, "FORMAT", "TRAILING", "container has trailing bytes");
  }
}

function exact(value, fields, code) {
  requireThat(value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Uint8Array), "SEMANTIC", code, `${code} is not a map`);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  requireThat(actual.length === expected.length && actual.every((field, index) => field === expected[index]), "SEMANTIC", code, `${code} fields differ`);
}

function integer(value, min, max, code) {
  requireThat(Number.isSafeInteger(value) && value >= min && value <= max, "SEMANTIC", code, `${code} is outside its permitted range`);
}

function text(value, min, max, code) {
  requireThat(typeof value === "string" && value.length >= min && value.length <= max && value.normalize("NFC") === value && !value.includes("\0"), "SEMANTIC", code, `${code} is not canonical text`);
}

function timestamp(value, code) {
  text(value, 1, 64, code);
  const parsed = new Date(value);
  requireThat(!Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value, "SEMANTIC", code, `${code} is not a canonical UTC timestamp`);
}

function validateData(value, depth = 0) {
  requireThat(depth <= 64, "RESOURCE_LIMIT", "EVENT_DEPTH", "event data nesting exceeds limit");
  if (value === null || typeof value === "boolean" || value instanceof Uint8Array) return;
  if (typeof value === "string") {
    requireThat(value.normalize("NFC") === value, "SEMANTIC", "EVENT_TEXT", "event data text is not NFC");
    return;
  }
  if (typeof value === "number") {
    requireThat(Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)), "SEMANTIC", "EVENT_NUMBER", "event data number is invalid");
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => validateData(item, depth + 1));
    return;
  }
  requireThat(value !== null && typeof value === "object", "SEMANTIC", "EVENT_DATA", "event data type is invalid");
  for (const [key, item] of Object.entries(value)) {
    text(key, 1, 256, "EVENT_KEY");
    validateData(item, depth + 1);
  }
}

function validateEvent(event) {
  const allowed = new Set(["version", "eventId", "ledgerId", "subject", "type", "schemaVersion", "occurredAt", "recordedAt", "source", "payload", "payloadHash", "previousStateHash", "resultingStateHash", "correlationId", "causationId", "policyReference", "metadata"]);
  requireThat(event !== null && typeof event === "object" && !Array.isArray(event) && Object.keys(event).every((field) => allowed.has(field)), "SEMANTIC", "EVENT_FIELDS", "event fields are invalid");
  requireThat(event.version === 1, "SEMANTIC", "EVENT_VERSION", "event version is unsupported");
  text(event.eventId, 1, 128, "EVENT_ID");
  text(event.ledgerId, 1, 128, "EVENT_LEDGER");
  text(event.subject, 1, 512, "EVENT_SUBJECT");
  text(event.type, 1, 256, "EVENT_TYPE");
  integer(event.schemaVersion, 1, Number.MAX_SAFE_INTEGER, "EVENT_SCHEMA_VERSION");
  timestamp(event.occurredAt, "EVENT_OCCURRED_AT");
  timestamp(event.recordedAt, "EVENT_RECORDED_AT");
  requireThat(event.source !== null && typeof event.source === "object" && !Array.isArray(event.source), "SEMANTIC", "EVENT_SOURCE", "event source is invalid");
  requireThat(Object.keys(event.source).every((field) => new Set(["kind", "identity", "keyId"]).has(field)), "SEMANTIC", "EVENT_SOURCE_FIELDS", "event source fields are invalid");
  requireThat(new Set(["semantic", "outbox", "cdc", "webhook", "batch"]).has(event.source.kind), "SEMANTIC", "EVENT_SOURCE_KIND", "event source kind is invalid");
  text(event.source.identity, 1, 256, "EVENT_SOURCE_IDENTITY");
  if (event.source.keyId !== undefined) text(event.source.keyId, 1, 256, "EVENT_SOURCE_KEY");
  if (event.payload !== undefined) validateData(event.payload);
  if (event.metadata !== undefined) validateData(event.metadata);
  for (const field of ["payloadHash", "previousStateHash", "resultingStateHash"]) {
    if (event[field] !== undefined) requireThat(typeof event[field] === "string" && /^[0-9a-f]{64}$/u.test(event[field]), "SEMANTIC", "EVENT_HASH", `${field} is invalid`);
  }
  for (const field of ["correlationId", "causationId", "policyReference"]) {
    if (event[field] !== undefined) text(event[field], 1, 512, "EVENT_REFERENCE");
  }
  requireThat(event.payload !== undefined || event.payloadHash !== undefined, "SEMANTIC", "EVENT_PAYLOAD", "event has no payload commitment");
}

function validateCompression(profile) {
  exact(profile, ["algorithm", "profile", "level", "checksum", "contentSize"], "COMPRESSION_PROFILE_FIELDS");
  requireThat(profile.algorithm === "zstd" && profile.profile === "g9p-zstd-v1" && profile.level === 3 && profile.checksum === true && profile.contentSize === true, "SEMANTIC", "COMPRESSION_PROFILE", "compression profile is unsupported");
}

function bytesEqual(left, right, code) {
  requireThat(left instanceof Uint8Array && Buffer.from(left).equals(Buffer.from(right)), "COMMITMENT", code, `${code} mismatch`);
}

function verifyEd25519(publicKeyDer, signature, domain, payload, expectedKeyId) {
  const keyId = domainHash("public-key-id-v1", publicKeyDer).toString("hex");
  requireThat(keyId === expectedKeyId, "IDENTITY", "KEY_ID", "embedded public key does not match key ID");
  let key;
  try {
    key = createPublicKey({ key: Buffer.from(publicKeyDer), format: "der", type: "spki" });
  } catch {
    reject("IDENTITY", "PUBLIC_KEY", "embedded public key is invalid");
  }
  const valid = verifySignature(null, domainHash(domain, payload), key, Buffer.from(signature));
  requireThat(valid, "SIGNATURE", "SIGNATURE", "Ed25519 signature is invalid");
}

function merkle(recordHashes) {
  let level = recordHashes.map((hash) => domainHash("merkle-leaf-v1", hash));
  while (level.length > 1) {
    const next = [];
    for (let index = 0; index < level.length; index += 2) {
      next.push(index + 1 === level.length ? level[index] : domainHash("merkle-node-v1", level[index], level[index + 1]));
    }
    level = next;
  }
  return level[0] ?? domainHash("merkle-empty-v1");
}

function route(event, policy) {
  requireThat(policy.id === "subject-sha256-v1" && policy.version === 1 && Number.isSafeInteger(policy.shardCount) && policy.shardCount >= 1 && policy.shardCount <= 65_536, "SEMANTIC", "ROUTING_POLICY", "routing policy is invalid");
  requireThat(typeof event.ledgerId === "string" && typeof event.subject === "string", "SEMANTIC", "EVENT_ROUTE", "event routing identity is invalid");
  const digest = domainHash("shard-route-v1", Buffer.from(event.ledgerId), Buffer.from(event.subject));
  const index = Number(digest.readBigUInt64BE(0) % BigInt(policy.shardCount));
  return `shard-${index.toString().padStart(4, "0")}`;
}

function verifySegment(bytes, version) {
  const profile = version === 1
    ? { magic: MAGIC_V1, head: "HEAD", manifest: "MNF1", hd: "header-payload-v1", bd: "block-payload-v1", sd: "segment-signature-v1", fd: "segment-file-v1" }
    : { magic: MAGIC_V2, head: "HED2", manifest: "MNF2", hd: "header-payload-v2", bd: "block-payload-v2", sd: "segment-signature-v2", fd: "segment-file-v2" };
  const reader = new ContainerReader(bytes, profile.magic);
  const headerFrame = reader.frame(profile.head);
  const blockFrames = [];
  while (reader.peek() === "BLK1") blockFrames.push(reader.frame("BLK1"));
  requireThat(blockFrames.length > 0, "SEMANTIC", "BLOCKS", "segment has no blocks");
  const manifestFrame = reader.frame(profile.manifest);
  const signatureFrame = reader.frame("SIG1");
  requireThat(reader.frame("END!").payload.length === 0, "FORMAT", "END", "END frame is not empty");
  reader.end();

  const header = decodeCanonical(headerFrame.payload);
  const blocks = blockFrames.map(({ payload }) => decodeCanonical(payload));
  const manifest = decodeCanonical(manifestFrame.payload);
  const signature = decodeCanonical(signatureFrame.payload);
  const headerFields = ["kind", "formatVersion", "ledgerId", "shardId", "segmentNumber", "createdAt", "previousSegmentHash", "routingPolicy", "compression"];
  if (version === 2) headerFields.push("routingEpochNumber", "routingEpochHash");
  exact(header, headerFields, "HEADER_FIELDS");
  exact(manifest, ["kind", "manifestVersion", "headerHash", "recordCount", "blockCount", "recordMerkleRoot", "blocks", "signer"], "MANIFEST_FIELDS");
  exact(signature, ["algorithm", "keyId", "signature"], "SIGNATURE_FIELDS");
  requireThat(header.kind === "g9p-segment" && header.formatVersion === version && manifest.kind === "g9p-segment-manifest" && manifest.manifestVersion === version, "SEMANTIC", "VERSION", "segment profile is inconsistent");
  requireThat(typeof header.ledgerId === "string" && /^shard-[0-9]{4}$/u.test(header.shardId), "SEMANTIC", "IDENTITY", "segment identity is invalid");
  integer(header.segmentNumber, 0, Number.MAX_SAFE_INTEGER, "SEGMENT_NUMBER");
  timestamp(header.createdAt, "SEGMENT_CREATED_AT");
  requireThat(header.previousSegmentHash === null || (header.previousSegmentHash instanceof Uint8Array && header.previousSegmentHash.length === 32), "SEMANTIC", "PREVIOUS_SEGMENT", "previous segment hash is invalid");
  if (version === 2) {
    integer(header.routingEpochNumber, 0, Number.MAX_SAFE_INTEGER, "ROUTING_EPOCH_NUMBER");
    requireThat(header.routingEpochHash instanceof Uint8Array && header.routingEpochHash.length === 32, "SEMANTIC", "ROUTING_EPOCH_HASH", "routing epoch hash is invalid");
  }
  validateCompression(header.compression);
  route({ ledgerId: header.ledgerId, subject: "profile-check" }, header.routingPolicy);
  bytesEqual(manifest.headerHash, domainHash(profile.hd, headerFrame.payload), "HEADER_HASH");
  requireThat(manifest.blockCount === blocks.length && manifest.blocks.length === blocks.length, "SEMANTIC", "BLOCK_COUNT", "block count differs");
  integer(manifest.recordCount, 1, 10_000_000, "MANIFEST_RECORD_COUNT");
  integer(manifest.blockCount, 1, 65_536, "MANIFEST_BLOCK_COUNT");
  requireThat(manifest.recordMerkleRoot instanceof Uint8Array && manifest.recordMerkleRoot.length === 32, "SEMANTIC", "MERKLE_ROOT_LENGTH", "Merkle root length is invalid");

  let firstRecord = 0;
  const recordHashes = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    const commitment = manifest.blocks[index];
    exact(block, ["blockIndex", "firstRecordIndex", "recordCount", "uncompressedLength", "compression", "recordsHash", "data"], "BLOCK_FIELDS");
    exact(commitment, ["blockIndex", "firstRecordIndex", "recordCount", "payloadHash"], "BLOCK_COMMITMENT_FIELDS");
    integer(block.blockIndex, 0, 65_535, "BLOCK_INDEX");
    integer(block.firstRecordIndex, 0, 10_000_000, "BLOCK_FIRST_RECORD");
    integer(block.recordCount, 1, 10_000_000, "BLOCK_RECORD_COUNT");
    requireThat(block.recordsHash instanceof Uint8Array && block.recordsHash.length === 32 && block.data instanceof Uint8Array && block.data.length > 0, "SEMANTIC", "BLOCK_BYTES", "block byte fields are invalid");
    requireThat(commitment.payloadHash instanceof Uint8Array && commitment.payloadHash.length === 32, "SEMANTIC", "BLOCK_COMMITMENT_HASH", "block commitment hash is invalid");
    requireThat(block.blockIndex === index && commitment.blockIndex === index && block.firstRecordIndex === firstRecord && commitment.firstRecordIndex === firstRecord && block.recordCount === commitment.recordCount, "SEMANTIC", "BLOCK_ORDER", "block ranges differ");
    bytesEqual(commitment.payloadHash, domainHash(profile.bd, blockFrames[index].payload), "BLOCK_HASH");
    requireThat(block.compression === "zstd" && Number.isSafeInteger(block.uncompressedLength) && block.uncompressedLength > 0 && block.uncompressedLength <= MAX_BLOCK_OUTPUT, "RESOURCE_LIMIT", "BLOCK_OUTPUT", "block output declaration is invalid");
    let output;
    try {
      output = zstdDecompressSync(Buffer.from(block.data), { maxOutputLength: MAX_BLOCK_OUTPUT });
    } catch {
      reject("COMPRESSION", "ZSTD", "Zstandard block could not be decompressed");
    }
    requireThat(output.length === block.uncompressedLength, "COMPRESSION", "OUTPUT_LENGTH", "decompressed length differs");
    bytesEqual(block.recordsHash, domainHash("record-block-v1", output), "RECORD_BLOCK_HASH");
    let offset = 0;
    let count = 0;
    while (offset < output.length) {
      requireThat(offset + 4 <= output.length, "FORMAT", "RECORD_TRUNCATED", "record length is truncated");
      const length = output.readUInt32BE(offset);
      offset += 4;
      requireThat(length <= MAX_RECORD, "RESOURCE_LIMIT", "RECORD_LIMIT", "record exceeds limit");
      requireThat(offset + length <= output.length, "FORMAT", "RECORD_TRUNCATED", "record is truncated");
      const eventBytes = output.subarray(offset, offset + length);
      offset += length;
      const event = decodeCanonical(eventBytes);
      validateEvent(event);
      requireThat(event.ledgerId === header.ledgerId && route(event, header.routingPolicy) === header.shardId, "SEMANTIC", "EVENT", "event does not belong in segment");
      recordHashes.push(domainHash("event-record-v1", eventBytes));
      count += 1;
    }
    requireThat(count === block.recordCount, "SEMANTIC", "RECORD_COUNT", "record count differs");
    firstRecord += block.recordCount;
  }
  requireThat(firstRecord === manifest.recordCount, "SEMANTIC", "RECORD_COUNT", "manifest record count differs");
  bytesEqual(manifest.recordMerkleRoot, merkle(recordHashes), "MERKLE_ROOT");
  exact(manifest.signer, ["algorithm", "keyId", "publicKey"], "SIGNER_FIELDS");
  requireThat(manifest.signer.algorithm === "ed25519" && manifest.signer.publicKey instanceof Uint8Array && manifest.signer.publicKey.length === 44 && typeof manifest.signer.keyId === "string" && /^[0-9a-f]{64}$/u.test(manifest.signer.keyId), "IDENTITY", "SIGNER_IDENTITY", "manifest signer identity is invalid");
  requireThat(signature.algorithm === "ed25519" && signature.keyId === manifest.signer.keyId && signature.signature instanceof Uint8Array && signature.signature.length === 64, "IDENTITY", "SIGNATURE_IDENTITY", "signature identity is invalid");
  verifyEd25519(manifest.signer.publicKey, signature.signature, profile.sd, manifestFrame.payload, manifest.signer.keyId);
  return {
    valid: true,
    kind: "segment",
    formatVersion: version,
    ledgerId: header.ledgerId,
    shardId: header.shardId,
    recordCount: manifest.recordCount,
    blockCount: manifest.blockCount,
    logicalRoot: Buffer.from(manifest.recordMerkleRoot).toString("hex"),
    fileHash: domainHash(profile.fd, bytes).toString("hex"),
    signerKeyId: manifest.signer.keyId,
  };
}

function verifyEpoch(bytes) {
  const reader = new ContainerReader(bytes, MAGIC_V2);
  const descriptorFrame = reader.frame("RTE1");
  const signatureFrame = reader.frame("SIG1");
  requireThat(reader.frame("END!").payload.length === 0, "FORMAT", "END", "END frame is not empty");
  reader.end();
  const descriptor = decodeCanonical(descriptorFrame.payload);
  const signature = decodeCanonical(signatureFrame.payload);
  exact(descriptor, ["kind", "protocolVersion", "ledgerId", "epochNumber", "createdAt", "previousEpochHash", "previousShardHeads", "routingPolicy", "topologyAuthority", "authorizationPolicy", "reason"], "EPOCH_FIELDS");
  exact(descriptor.topologyAuthority, ["algorithm", "keyId", "publicKey"], "AUTHORITY_FIELDS");
  exact(descriptor.authorizationPolicy, ["kind", "version", "threshold"], "AUTHORIZATION_FIELDS");
  exact(signature, ["algorithm", "keyId", "signature"], "SIGNATURE_FIELDS");
  requireThat(descriptor.kind === "g9p-routing-epoch" && descriptor.protocolVersion === 1 && typeof descriptor.ledgerId === "string" && Number.isSafeInteger(descriptor.epochNumber) && descriptor.epochNumber >= 0, "SEMANTIC", "EPOCH", "routing epoch identity is invalid");
  text(descriptor.ledgerId, 1, 1024, "EPOCH_LEDGER");
  timestamp(descriptor.createdAt, "EPOCH_CREATED_AT");
  text(descriptor.reason, 1, 4096, "EPOCH_REASON");
  requireThat((descriptor.epochNumber === 0 && descriptor.previousEpochHash === null) || (descriptor.epochNumber > 0 && descriptor.previousEpochHash instanceof Uint8Array && descriptor.previousEpochHash.length === 32), "SEMANTIC", "EPOCH_LINK", "routing epoch link is invalid");
  requireThat(descriptor.authorizationPolicy.kind === "single-ed25519" && descriptor.authorizationPolicy.version === 1 && descriptor.authorizationPolicy.threshold === 1, "SEMANTIC", "AUTHORIZATION_POLICY", "authorization policy is unsupported");
  requireThat(Array.isArray(descriptor.previousShardHeads) && descriptor.previousShardHeads.length <= 65_536, "RESOURCE_LIMIT", "SHARD_HEAD_LIMIT", "previous shard head list is invalid");
  if (descriptor.epochNumber === 0) requireThat(descriptor.previousShardHeads.length === 0, "SEMANTIC", "GENESIS_HEADS", "genesis epoch has previous shard heads");
  descriptor.previousShardHeads.forEach((head, index) => {
    exact(head, ["epochNumber", "shardId", "segmentNumber", "segmentHash"], "SHARD_HEAD_FIELDS");
    requireThat(head.epochNumber === descriptor.epochNumber - 1 && head.shardId === `shard-${index.toString().padStart(4, "0")}`, "SEMANTIC", "SHARD_HEAD_ORDER", "previous shard head is unordered");
    const empty = head.segmentNumber === null && head.segmentHash === null;
    const sealed = Number.isSafeInteger(head.segmentNumber) && head.segmentNumber >= 0 && head.segmentHash instanceof Uint8Array && head.segmentHash.length === 32;
    requireThat(empty || sealed, "SEMANTIC", "SHARD_HEAD", "previous shard head is incomplete");
  });
  route({ ledgerId: descriptor.ledgerId, subject: "conformance-check" }, descriptor.routingPolicy);
  requireThat(descriptor.topologyAuthority.algorithm === "ed25519" && descriptor.topologyAuthority.publicKey instanceof Uint8Array && descriptor.topologyAuthority.publicKey.length === 44 && typeof descriptor.topologyAuthority.keyId === "string" && /^[0-9a-f]{64}$/u.test(descriptor.topologyAuthority.keyId), "IDENTITY", "AUTHORITY_IDENTITY", "topology authority identity is invalid");
  requireThat(signature.algorithm === "ed25519" && signature.keyId === descriptor.topologyAuthority.keyId && signature.signature instanceof Uint8Array && signature.signature.length === 64, "IDENTITY", "SIGNATURE_IDENTITY", "routing signature identity is invalid");
  verifyEd25519(descriptor.topologyAuthority.publicKey, signature.signature, "routing-epoch-signature-v1", descriptorFrame.payload, descriptor.topologyAuthority.keyId);
  return {
    valid: true,
    kind: "routing-epoch",
    containerVersion: 2,
    protocolVersion: 1,
    ledgerId: descriptor.ledgerId,
    epochNumber: descriptor.epochNumber,
    epochHash: domainHash("routing-epoch-v1", descriptorFrame.payload).toString("hex"),
    fileHash: domainHash("routing-epoch-file-v1", bytes).toString("hex"),
    topologyAuthorityKeyId: descriptor.topologyAuthority.keyId,
  };
}

function verifyAttestation(bytes, profile) {
  const reader = new ContainerReader(bytes, MAGIC_V2);
  const statementFrame = reader.frame(profile.frame);
  const signatureFrame = reader.frame("SIG1");
  requireThat(reader.frame("END!").payload.length === 0, "FORMAT", "END", "END frame is not empty");
  reader.end();
  const statement = decodeCanonical(statementFrame.payload);
  const signed = decodeCanonical(signatureFrame.payload);
  exact(statement, profile.fields, `${profile.code}_FIELDS`);
  exact(statement[profile.identityField], ["algorithm", "keyId", "publicKey"], `${profile.code}_IDENTITY_FIELDS`);
  exact(signed, ["algorithm", "keyId", "signature"], "SIGNATURE_FIELDS");
  requireThat(statement.kind === profile.kind && statement.protocolVersion === 1, "SEMANTIC", `${profile.code}_VERSION`, `unsupported ${profile.kind}`);
  text(statement.ledgerId, 1, 1024, `${profile.code}_LEDGER`);
  integer(statement.checkpointNumber, 0, Number.MAX_SAFE_INTEGER, `${profile.code}_NUMBER`);
  if (profile.frame === "CHK1") {
    timestamp(statement.createdAt, "CHECKPOINT_CREATED_AT");
    requireThat(statement.previousCheckpointHash === null || (statement.previousCheckpointHash instanceof Uint8Array && statement.previousCheckpointHash.length === 32), "SEMANTIC", "CHECKPOINT_LINK", "checkpoint link is invalid");
    integer(statement.routingEpochNumber, 0, Number.MAX_SAFE_INTEGER, "CHECKPOINT_EPOCH");
    requireThat(statement.routingEpochHash instanceof Uint8Array && statement.routingEpochHash.length === 32, "SEMANTIC", "CHECKPOINT_EPOCH_HASH", "checkpoint routing hash is invalid");
    requireThat(Array.isArray(statement.shardHeads) && statement.shardHeads.length >= 1 && statement.shardHeads.length <= 65_536, "RESOURCE_LIMIT", "CHECKPOINT_HEAD_LIMIT", "checkpoint shard heads are not bounded");
    statement.shardHeads.forEach((head, index) => {
      exact(head, ["epochNumber", "shardId", "segmentNumber", "segmentHash"], "CHECKPOINT_HEAD_FIELDS");
      requireThat(head.epochNumber === statement.routingEpochNumber && head.shardId === `shard-${index.toString().padStart(4, "0")}`, "SEMANTIC", "CHECKPOINT_HEAD_ORDER", "checkpoint shard heads are unordered");
      const empty = head.segmentNumber === null && head.segmentHash === null;
      const sealed = Number.isSafeInteger(head.segmentNumber) && head.segmentNumber >= 0 && head.segmentHash instanceof Uint8Array && head.segmentHash.length === 32;
      requireThat(empty || sealed, "SEMANTIC", "CHECKPOINT_HEAD", "checkpoint shard head is incomplete");
    });
  } else {
    requireThat(statement.checkpointHash instanceof Uint8Array && statement.checkpointHash.length === 32
      && statement.checkpointFileHash instanceof Uint8Array && statement.checkpointFileHash.length === 32, "SEMANTIC", "WITNESS_CHECKPOINT_HASH", "witness checkpoint commitment is invalid");
    timestamp(statement.observedAt, "WITNESS_OBSERVED_AT");
  }
  const identity = statement[profile.identityField];
  requireThat(identity.algorithm === "ed25519" && typeof identity.keyId === "string" && /^[0-9a-f]{64}$/u.test(identity.keyId)
    && identity.publicKey instanceof Uint8Array && identity.publicKey.length === 44 && signed.algorithm === "ed25519"
    && signed.keyId === identity.keyId && signed.signature instanceof Uint8Array && signed.signature.length === 64, "IDENTITY", `${profile.code}_IDENTITY`, "attestation signer identity is invalid");
  verifyEd25519(identity.publicKey, signed.signature, profile.signatureDomain, statementFrame.payload, identity.keyId);
  return {
    valid: true,
    kind: profile.resultKind,
    protocolVersion: 1,
    ledgerId: statement.ledgerId,
    checkpointNumber: statement.checkpointNumber,
    [profile.hashName]: domainHash(profile.hashDomain, statementFrame.payload).toString("hex"),
    fileHash: domainHash(profile.fileDomain, bytes).toString("hex"),
    [profile.keyName]: identity.keyId,
    ...(profile.frame === "WIT1" ? { checkpointHash: Buffer.from(statement.checkpointHash).toString("hex"), checkpointFileHash: Buffer.from(statement.checkpointFileHash).toString("hex") } : {}),
  };
}

export function verifyG9pBytes(input) {
  requireThat(input instanceof Uint8Array && input.byteLength <= MAX_FILE, "RESOURCE_LIMIT", "FILE_LIMIT", "input is not bounded bytes");
  const bytes = Buffer.from(input);
  if (bytes.subarray(0, 8).equals(MAGIC_V1)) return verifySegment(bytes, 1);
  requireThat(bytes.subarray(0, 8).equals(MAGIC_V2), "FORMAT", "MAGIC", "unsupported G9P magic");
  requireThat(bytes.length >= 12, "FORMAT", "TRUNCATED", "container is truncated before profile selection");
  const profile = bytes.toString("ascii", 8, 12);
  if (profile === "HED2") return verifySegment(bytes, 2);
  if (profile === "RTE1") return verifyEpoch(bytes);
  if (profile === "CHK1") return verifyAttestation(bytes, {
    frame: "CHK1", code: "CHECKPOINT", kind: "g9p-checkpoint", resultKind: "checkpoint", identityField: "publisher",
    fields: ["kind", "protocolVersion", "ledgerId", "checkpointNumber", "createdAt", "previousCheckpointHash", "routingEpochNumber", "routingEpochHash", "shardHeads", "publisher"],
    signatureDomain: "checkpoint-signature-v1", hashDomain: "checkpoint-v1", fileDomain: "checkpoint-file-v1", hashName: "checkpointHash", keyName: "publisherKeyId",
  });
  if (profile === "WIT1") return verifyAttestation(bytes, {
    frame: "WIT1", code: "WITNESS", kind: "g9p-witness-receipt", resultKind: "witness-receipt", identityField: "witness",
    fields: ["kind", "protocolVersion", "ledgerId", "checkpointNumber", "checkpointHash", "checkpointFileHash", "observedAt", "witness"],
    signatureDomain: "witness-signature-v1", hashDomain: "witness-receipt-v1", fileDomain: "witness-file-v1", hashName: "receiptHash", keyName: "witnessKeyId",
  });
  reject("FORMAT", "PROFILE", `unsupported version 2 profile ${profile}`);
}

async function main() {
  const path = process.argv[2];
  if (path === undefined) {
    process.stderr.write("Usage: node tools/independent-verifier/verify.js <file.g9p>\n");
    process.exitCode = 2;
    return;
  }
  try {
    process.stdout.write(`${JSON.stringify(verifyG9pBytes(await readFile(path)), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ valid: false, category: error.category ?? "INTERNAL", code: error.code ?? "INTERNAL" })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
