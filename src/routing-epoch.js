import { readFile, stat } from "node:fs/promises";

import { decodeCanonical, encodeCanonical } from "./codec/canonical.js";
import {
  domainHash,
  importPublicKey,
  publicKeyId,
  signDomainCommitment,
  toHex,
  verifyDomainCommitment,
} from "./crypto.js";
import { fail, invariant } from "./errors.js";
import { encodeFrame, FrameReader, FRAME_TYPES, G9P_MAGIC_V2 } from "./format/framing.js";
import { writeExclusiveAndPromote } from "./sealed-file.js";
import { requireSealedStorage } from "./sealed-storage.js";
import { ROUTING_POLICY_ID } from "./sharding.js";

const DESCRIPTOR_KIND = "g9p-routing-epoch";
const PROTOCOL_VERSION = 1;
const AUTHORIZATION_POLICY = Object.freeze({
  kind: "single-ed25519",
  version: 1,
  threshold: 1,
});

const DEFAULT_LIMITS = Object.freeze({
  maxFileBytes: 64 * 1024 * 1024,
  maxFrameBytes: 64 * 1024 * 1024,
  maxPreviousShardHeads: 65_536,
  maxLedgerIdBytes: 1024,
  maxReasonBytes: 4096,
});

function plainObject(value, name) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Uint8Array), "EPOCH_OBJECT", `${name} must be an object`);
  return value;
}

function exactFields(value, fields, name) {
  const expected = [...fields].sort();
  const actual = Object.keys(value).sort();
  invariant(actual.length === expected.length && actual.every((field, index) => field === expected[index]), "EPOCH_FIELDS", `${name} fields do not match routing epoch protocol version 1`);
}

function safeInteger(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  invariant(Number.isSafeInteger(value) && value >= min && value <= max, "EPOCH_INTEGER", `${name} is outside its permitted range`);
  return value;
}

function canonicalText(value, name, maxBytes, { allowEmpty = false } = {}) {
  invariant(typeof value === "string" && (allowEmpty || value.length > 0), "EPOCH_TEXT", `${name} must be ${allowEmpty ? "a" : "a non-empty"} string`);
  invariant(value.normalize("NFC") === value, "EPOCH_TEXT", `${name} must use Unicode NFC`);
  invariant(Buffer.byteLength(value, "utf8") <= maxBytes, "EPOCH_TEXT", `${name} exceeds its ${maxBytes} byte limit`);
  return value;
}

function canonicalTimestamp(value, name) {
  invariant(typeof value === "string", "EPOCH_TIMESTAMP", `${name} must be a string`);
  const parsed = new Date(value);
  invariant(!Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value, "EPOCH_TIMESTAMP", `${name} must be a canonical UTC ISO-8601 timestamp`);
  return value;
}

function bytesOfLength(value, length, name) {
  invariant(value instanceof Uint8Array && value.byteLength === length, "EPOCH_BYTES", `${name} must contain ${length} bytes`);
  return Buffer.from(value);
}

function validateRoutingPolicy(value) {
  plainObject(value, "routingPolicy");
  exactFields(value, ["id", "version", "shardCount"], "routingPolicy");
  invariant(value.id === ROUTING_POLICY_ID && value.version === 1, "EPOCH_ROUTING_POLICY", "Unsupported routing policy");
  safeInteger(value.shardCount, "routingPolicy.shardCount", { min: 1, max: 65_536 });
  return {
    id: value.id,
    version: value.version,
    shardCount: value.shardCount,
  };
}

function validateAuthorizationPolicy(value) {
  plainObject(value, "authorizationPolicy");
  exactFields(value, ["kind", "version", "threshold"], "authorizationPolicy");
  invariant(
    value.kind === AUTHORIZATION_POLICY.kind
      && value.version === AUTHORIZATION_POLICY.version
      && value.threshold === AUTHORIZATION_POLICY.threshold,
    "EPOCH_AUTHORIZATION_POLICY",
    "Unsupported routing epoch authorization policy",
  );
  return { ...AUTHORIZATION_POLICY };
}

function validatePreviousShardHeads(value, epochNumber, limits) {
  invariant(Array.isArray(value), "EPOCH_SHARD_HEADS", "previousShardHeads must be an array");
  invariant(value.length <= limits.maxPreviousShardHeads, "EPOCH_SHARD_HEADS", `previousShardHeads exceeds the ${limits.maxPreviousShardHeads} entry limit`);

  if (epochNumber === 0) {
    invariant(value.length === 0, "EPOCH_GENESIS", "Epoch zero cannot contain previous shard heads");
    return [];
  }
  invariant(value.length > 0, "EPOCH_SHARD_HEADS", "A non-genesis epoch requires a complete previous shard head list");

  return value.map((head, index) => {
    plainObject(head, `previousShardHeads[${index}]`);
    exactFields(head, ["epochNumber", "shardId", "segmentNumber", "segmentHash"], `previousShardHeads[${index}]`);
    invariant(head.epochNumber === epochNumber - 1, "EPOCH_SHARD_HEAD", `previousShardHeads[${index}].epochNumber must identify the preceding epoch`);
    const expectedShardId = `shard-${index.toString().padStart(4, "0")}`;
    invariant(head.shardId === expectedShardId, "EPOCH_SHARD_HEAD", `previousShardHeads[${index}].shardId must be ${expectedShardId}`);
    const isEmpty = head.segmentNumber === null && head.segmentHash === null;
    const isSealed = Number.isSafeInteger(head.segmentNumber) && head.segmentNumber >= 0
      && head.segmentHash instanceof Uint8Array && head.segmentHash.byteLength === 32;
    invariant(isEmpty || isSealed, "EPOCH_SHARD_HEAD", `previousShardHeads[${index}] must contain either a complete sealed head or an explicit empty-shard statement`);
    return {
      epochNumber: head.epochNumber,
      shardId: head.shardId,
      segmentNumber: head.segmentNumber,
      segmentHash: head.segmentHash === null ? null : Uint8Array.from(head.segmentHash),
    };
  });
}

function validateTopologyAuthority(value) {
  plainObject(value, "topologyAuthority");
  exactFields(value, ["algorithm", "keyId", "publicKey"], "topologyAuthority");
  invariant(value.algorithm === "ed25519", "EPOCH_SIGNATURE_ALGORITHM", "Unsupported topology authority algorithm");
  invariant(typeof value.keyId === "string" && /^[0-9a-f]{64}$/u.test(value.keyId), "EPOCH_KEY_ID", "Topology authority key ID is invalid");
  invariant(value.publicKey instanceof Uint8Array && value.publicKey.byteLength === 44, "EPOCH_PUBLIC_KEY", "Topology authority Ed25519 SPKI DER public key must contain 44 bytes");
  return {
    algorithm: value.algorithm,
    keyId: value.keyId,
    publicKey: Uint8Array.from(value.publicKey),
  };
}

function validateDescriptor(value, limits) {
  plainObject(value, "routing epoch descriptor");
  exactFields(value, [
    "kind",
    "protocolVersion",
    "ledgerId",
    "epochNumber",
    "createdAt",
    "previousEpochHash",
    "previousShardHeads",
    "routingPolicy",
    "topologyAuthority",
    "authorizationPolicy",
    "reason",
  ], "routing epoch descriptor");
  invariant(value.kind === DESCRIPTOR_KIND && value.protocolVersion === PROTOCOL_VERSION, "EPOCH_VERSION", "Unsupported routing epoch descriptor");
  const ledgerId = canonicalText(value.ledgerId, "ledgerId", limits.maxLedgerIdBytes);
  const epochNumber = safeInteger(value.epochNumber, "epochNumber");
  const createdAt = canonicalTimestamp(value.createdAt, "createdAt");
  if (epochNumber === 0) {
    invariant(value.previousEpochHash === null, "EPOCH_GENESIS", "Epoch zero cannot link to a previous epoch");
  } else {
    bytesOfLength(value.previousEpochHash, 32, "previousEpochHash");
  }

  return {
    kind: value.kind,
    protocolVersion: value.protocolVersion,
    ledgerId,
    epochNumber,
    createdAt,
    previousEpochHash: value.previousEpochHash === null ? null : Uint8Array.from(value.previousEpochHash),
    previousShardHeads: validatePreviousShardHeads(value.previousShardHeads, epochNumber, limits),
    routingPolicy: validateRoutingPolicy(value.routingPolicy),
    topologyAuthority: validateTopologyAuthority(value.topologyAuthority),
    authorizationPolicy: validateAuthorizationPolicy(value.authorizationPolicy),
    reason: canonicalText(value.reason, "reason", limits.maxReasonBytes),
  };
}

function validateSignature(value, descriptor) {
  plainObject(value, "routing epoch signature");
  exactFields(value, ["algorithm", "keyId", "signature"], "routing epoch signature");
  invariant(value.algorithm === descriptor.topologyAuthority.algorithm, "EPOCH_SIGNATURE_ALGORITHM", "Signature algorithm does not match the topology authority");
  invariant(value.keyId === descriptor.topologyAuthority.keyId, "EPOCH_KEY_ID", "Signature key ID does not match the topology authority");
  invariant(value.signature instanceof Uint8Array && value.signature.byteLength === 64, "EPOCH_SIGNATURE_LENGTH", "Ed25519 signature must contain 64 bytes");
}

function buffersEqual(left, right, code, message) {
  invariant(Buffer.from(left).equals(Buffer.from(right)), code, message);
}

function descriptorForWrite({
  ledgerId,
  epochNumber,
  createdAt,
  previousEpochHash,
  previousShardHeads,
  previousRoutingPolicy,
  routingPolicy,
  topologyAuthority,
  authorizationPolicy,
  reason,
}, limits) {
  invariant(topologyAuthority?.algorithm === "ed25519" && topologyAuthority.privateKey && topologyAuthority.publicKeyDer instanceof Uint8Array, "EPOCH_SIGNER", "An Ed25519 topology authority is required");
  invariant(topologyAuthority.keyId === publicKeyId(topologyAuthority.publicKeyDer), "EPOCH_SIGNER", "Topology authority keyId does not match its public key");

  const descriptor = validateDescriptor({
    kind: DESCRIPTOR_KIND,
    protocolVersion: PROTOCOL_VERSION,
    ledgerId,
    epochNumber,
    createdAt,
    previousEpochHash,
    previousShardHeads,
    routingPolicy,
    topologyAuthority: {
      algorithm: topologyAuthority.algorithm,
      keyId: topologyAuthority.keyId,
      publicKey: Uint8Array.from(topologyAuthority.publicKeyDer),
    },
    authorizationPolicy,
    reason,
  }, limits);
  if (descriptor.epochNumber === 0) {
    invariant(previousRoutingPolicy === null, "EPOCH_GENESIS", "Epoch zero cannot have a previous routing policy");
  } else {
    const validatedPreviousPolicy = validateRoutingPolicy(previousRoutingPolicy);
    invariant(descriptor.previousShardHeads.length === validatedPreviousPolicy.shardCount, "EPOCH_SHARD_HEADS", "Previous shard head list is incomplete for the previous routing policy");
  }
  return descriptor;
}

export async function writeRoutingEpoch({
  outputPath,
  sealedStorage,
  storageKey,
  ledgerId,
  epochNumber,
  routingPolicy,
  topologyAuthority,
  reason,
  createdAt = new Date().toISOString(),
  previousEpochHash = null,
  previousShardHeads = [],
  previousRoutingPolicy = null,
  authorizationPolicy = AUTHORIZATION_POLICY,
  testFaultInjector,
}) {
  const descriptor = descriptorForWrite({
    ledgerId,
    epochNumber,
    createdAt,
    previousEpochHash,
    previousShardHeads,
    previousRoutingPolicy,
    routingPolicy,
    topologyAuthority,
    authorizationPolicy,
    reason,
  }, DEFAULT_LIMITS);
  const descriptorPayload = encodeCanonical(descriptor);
  const signature = signDomainCommitment(topologyAuthority.privateKey, "routing-epoch-signature-v1", descriptorPayload);
  const signaturePayload = encodeCanonical({
    algorithm: topologyAuthority.algorithm,
    keyId: topologyAuthority.keyId,
    signature: Uint8Array.from(signature),
  });
  const fileBytes = Buffer.concat([
    G9P_MAGIC_V2,
    encodeFrame(FRAME_TYPES.routingEpoch, descriptorPayload),
    encodeFrame(FRAME_TYPES.signature, signaturePayload),
    encodeFrame(FRAME_TYPES.end),
  ]);

  if (sealedStorage === undefined) {
    await writeExclusiveAndPromote(outputPath, fileBytes, {
      errorCode: "EPOCH_WRITE",
      extensionErrorCode: "EPOCH_EXTENSION",
      description: "sealed routing epoch",
      testFaultInjector,
    });
  } else {
    invariant(typeof storageKey === "string" && storageKey.length > 0, "EPOCH_STORAGE_KEY", "A sealed storage key is required");
    await requireSealedStorage(sealedStorage).publish(storageKey, fileBytes, {
      errorCode: "EPOCH_WRITE",
      extensionErrorCode: "EPOCH_EXTENSION",
      description: "sealed routing epoch",
      testFaultInjector,
    });
  }

  return {
    outputPath: storageKey ?? outputPath,
    ledgerId: descriptor.ledgerId,
    epochNumber: descriptor.epochNumber,
    routingPolicy: descriptor.routingPolicy,
    epochHash: toHex(domainHash("routing-epoch-v1", descriptorPayload)),
    fileHash: toHex(domainHash("routing-epoch-file-v1", fileBytes)),
    topologyAuthorityKeyId: descriptor.topologyAuthority.keyId,
    byteLength: fileBytes.length,
  };
}

export async function verifyRoutingEpoch(path, options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const fileStat = await stat(path);
  invariant(fileStat.isFile(), "EPOCH_FILE", "Routing epoch path is not a file");
  invariant(fileStat.size <= limits.maxFileBytes, "EPOCH_FILE_LIMIT", `Routing epoch exceeds the ${limits.maxFileBytes} byte file limit`);
  return verifyRoutingEpochBytes(await readFile(path), { ...options, source: path });
}

export async function verifyRoutingEpochBytes(bytes, options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  invariant(bytes instanceof Uint8Array, "EPOCH_FILE", "Routing epoch content must be bytes");
  invariant(bytes.byteLength <= limits.maxFileBytes, "EPOCH_FILE_LIMIT", `Routing epoch exceeds the ${limits.maxFileBytes} byte file limit`);
  const fileBytes = Buffer.from(bytes);

  const reader = new FrameReader(fileBytes, { maxFrameBytes: limits.maxFrameBytes });
  reader.readMagic(G9P_MAGIC_V2);
  const descriptorFrame = reader.readFrame(FRAME_TYPES.routingEpoch);
  const signatureFrame = reader.readFrame(FRAME_TYPES.signature);
  const endFrame = reader.readFrame(FRAME_TYPES.end);
  invariant(endFrame.payload.length === 0, "EPOCH_END_FRAME", "End frame must be empty");
  reader.assertEnd();

  const descriptor = validateDescriptor(decodeCanonical(descriptorFrame.payload), limits);
  const signature = decodeCanonical(signatureFrame.payload);
  validateSignature(signature, descriptor);

  const publicKeyDer = Buffer.from(descriptor.topologyAuthority.publicKey);
  invariant(publicKeyId(publicKeyDer) === descriptor.topologyAuthority.keyId, "EPOCH_KEY_ID", "Embedded topology authority public key does not match its key ID");
  let publicKey;
  try {
    publicKey = importPublicKey(publicKeyDer);
  } catch (error) {
    fail("EPOCH_PUBLIC_KEY", "Embedded topology authority public key could not be imported", error);
  }
  invariant(
    verifyDomainCommitment(publicKey, "routing-epoch-signature-v1", descriptorFrame.payload, Buffer.from(signature.signature)),
    "EPOCH_SIGNATURE",
    "Routing epoch signature is invalid",
  );

  const trustedKeyIds = options.trustedKeyIds === undefined
    ? new Set()
    : options.trustedKeyIds instanceof Set
      ? options.trustedKeyIds
      : new Set(options.trustedKeyIds);
  const topologyAuthorityTrusted = trustedKeyIds.has(descriptor.topologyAuthority.keyId);
  if (options.requireTrustedAuthority === true) {
    invariant(topologyAuthorityTrusted, "EPOCH_UNTRUSTED_AUTHORITY", `Topology authority ${descriptor.topologyAuthority.keyId} is not in the trusted key set`);
  }

  if (options.expectedLedgerId !== undefined) {
    invariant(descriptor.ledgerId === options.expectedLedgerId, "EPOCH_LEDGER", "Routing epoch ledger ID does not match the expected ledger");
  }
  if (options.expectedEpochNumber !== undefined) {
    invariant(descriptor.epochNumber === options.expectedEpochNumber, "EPOCH_NUMBER", "Routing epoch number does not match the expected epoch");
  }
  if (options.expectedPreviousEpochHash !== undefined) {
    if (options.expectedPreviousEpochHash === null) {
      invariant(descriptor.previousEpochHash === null, "EPOCH_PREVIOUS", "Routing epoch unexpectedly links to a previous epoch");
    } else {
      buffersEqual(descriptor.previousEpochHash, options.expectedPreviousEpochHash, "EPOCH_PREVIOUS", "Previous routing epoch link does not match the expected epoch hash");
    }
  }
  if (options.expectedPreviousRoutingPolicy !== undefined) {
    const previousPolicy = validateRoutingPolicy(options.expectedPreviousRoutingPolicy);
    invariant(descriptor.epochNumber > 0, "EPOCH_PREVIOUS_POLICY", "Genesis epoch cannot have a previous routing policy");
    invariant(descriptor.previousShardHeads.length === previousPolicy.shardCount, "EPOCH_SHARD_HEADS", "Previous shard head list is incomplete for the expected routing policy");
  }

  const epochHash = domainHash("routing-epoch-v1", descriptorFrame.payload);
  return {
    valid: true,
    path: options.source ?? null,
    containerVersion: 2,
    protocolVersion: descriptor.protocolVersion,
    ledgerId: descriptor.ledgerId,
    epochNumber: descriptor.epochNumber,
    createdAt: descriptor.createdAt,
    previousEpochHash: descriptor.previousEpochHash === null ? null : toHex(descriptor.previousEpochHash),
    previousShardHeads: descriptor.previousShardHeads.map((head) => ({
      epochNumber: head.epochNumber,
      shardId: head.shardId,
      segmentNumber: head.segmentNumber,
      segmentHash: head.segmentHash === null ? null : toHex(head.segmentHash),
    })),
    routingPolicy: descriptor.routingPolicy,
    authorizationPolicy: descriptor.authorizationPolicy,
    reason: descriptor.reason,
    epochHash: toHex(epochHash),
    fileHash: toHex(domainHash("routing-epoch-file-v1", fileBytes)),
    topologyAuthorityKeyId: descriptor.topologyAuthority.keyId,
    topologyAuthorityTrusted,
    trustStatus: topologyAuthorityTrusted ? "trusted-key" : "untrusted-embedded-key",
    byteLength: fileBytes.length,
  };
}

export const routingEpochLimits = DEFAULT_LIMITS;
