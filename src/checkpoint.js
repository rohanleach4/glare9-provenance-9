import { readFile, stat } from "node:fs/promises";

import { decodeCanonical, encodeCanonical } from "./codec/canonical.js";
import { domainHash, importPublicKey, publicKeyId, signDomainCommitment, toHex, verifyDomainCommitment } from "./crypto.js";
import { fail, invariant } from "./errors.js";
import { encodeFrame, FRAME_TYPES, FrameReader, G9P_MAGIC_V2 } from "./format/framing.js";
import { writeExclusiveAndPromote } from "./sealed-file.js";
import { requireSealedStorage } from "./sealed-storage.js";

const LIMITS = Object.freeze({ maxFileBytes: 64 * 1024 * 1024, maxFrameBytes: 64 * 1024 * 1024, maxShardHeads: 65_536, maxWitnesses: 1_024 });

function exact(value, fields, code, name) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Uint8Array), code, `${name} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  invariant(actual.length === expected.length && actual.every((field, index) => field === expected[index]), code, `${name} fields do not match protocol version 1`);
}

function integer(value, name, max = Number.MAX_SAFE_INTEGER) {
  invariant(Number.isSafeInteger(value) && value >= 0 && value <= max, "ATTESTATION_INTEGER", `${name} is outside its permitted range`);
  return value;
}

function timestamp(value, name) {
  invariant(typeof value === "string", "ATTESTATION_TIMESTAMP", `${name} must be a string`);
  const parsed = new Date(value);
  invariant(!Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value, "ATTESTATION_TIMESTAMP", `${name} must be a canonical UTC timestamp`);
  return value;
}

function hash(value, name, nullable = false) {
  if (nullable && value === null) return null;
  invariant(value instanceof Uint8Array && value.byteLength === 32, "ATTESTATION_HASH", `${name} must contain 32 bytes`);
  return Uint8Array.from(value);
}

function identity(value, name) {
  exact(value, ["algorithm", "keyId", "publicKey"], "ATTESTATION_IDENTITY", name);
  invariant(value.algorithm === "ed25519" && typeof value.keyId === "string" && /^[0-9a-f]{64}$/u.test(value.keyId), "ATTESTATION_IDENTITY", `${name} identity is invalid`);
  invariant(value.publicKey instanceof Uint8Array && value.publicKey.byteLength === 44, "ATTESTATION_IDENTITY", `${name} public key is invalid`);
  invariant(publicKeyId(value.publicKey) === value.keyId, "ATTESTATION_IDENTITY", `${name} key ID does not match its public key`);
  return { algorithm: value.algorithm, keyId: value.keyId, publicKey: Uint8Array.from(value.publicKey) };
}

function signature(value, signer) {
  exact(value, ["algorithm", "keyId", "signature"], "ATTESTATION_SIGNATURE", "signature");
  invariant(value.algorithm === signer.algorithm && value.keyId === signer.keyId && value.signature instanceof Uint8Array && value.signature.byteLength === 64, "ATTESTATION_SIGNATURE", "Signature identity or length is invalid");
}

function signerIdentity(signer) {
  invariant(signer?.algorithm === "ed25519" && signer.privateKey && signer.publicKeyDer instanceof Uint8Array, "ATTESTATION_SIGNER", "An Ed25519 signer is required");
  invariant(publicKeyId(signer.publicKeyDer) === signer.keyId, "ATTESTATION_SIGNER", "Signer key ID does not match its public key");
  return { algorithm: signer.algorithm, keyId: signer.keyId, publicKey: Uint8Array.from(signer.publicKeyDer) };
}

function validateHeads(heads, epochNumber, limits) {
  invariant(Array.isArray(heads) && heads.length >= 1 && heads.length <= limits.maxShardHeads, "CHECKPOINT_HEADS", "Checkpoint requires a bounded complete shard-head list");
  return heads.map((head, index) => {
    exact(head, ["epochNumber", "shardId", "segmentNumber", "segmentHash"], "CHECKPOINT_HEAD", `shardHeads[${index}]`);
    invariant(head.epochNumber === epochNumber && head.shardId === `shard-${index.toString().padStart(4, "0")}`, "CHECKPOINT_HEAD", `shardHeads[${index}] is not ordered for the checkpoint epoch`);
    const empty = head.segmentNumber === null && head.segmentHash === null;
    const sealed = Number.isSafeInteger(head.segmentNumber) && head.segmentNumber >= 0 && head.segmentHash instanceof Uint8Array && head.segmentHash.byteLength === 32;
    invariant(empty || sealed, "CHECKPOINT_HEAD", `shardHeads[${index}] must be sealed or explicitly empty`);
    return { epochNumber, shardId: head.shardId, segmentNumber: head.segmentNumber, segmentHash: head.segmentHash === null ? null : Uint8Array.from(head.segmentHash) };
  });
}

function validateCheckpoint(value, limits) {
  exact(value, ["kind", "protocolVersion", "ledgerId", "checkpointNumber", "createdAt", "previousCheckpointHash", "routingEpochNumber", "routingEpochHash", "shardHeads", "publisher"], "CHECKPOINT_FIELDS", "checkpoint");
  invariant(value.kind === "g9p-checkpoint" && value.protocolVersion === 1 && typeof value.ledgerId === "string" && value.ledgerId.length > 0, "CHECKPOINT_VERSION", "Unsupported checkpoint descriptor");
  const routingEpochNumber = integer(value.routingEpochNumber, "routingEpochNumber");
  return { ...value, checkpointNumber: integer(value.checkpointNumber, "checkpointNumber"), createdAt: timestamp(value.createdAt, "createdAt"), previousCheckpointHash: hash(value.previousCheckpointHash, "previousCheckpointHash", true), routingEpochNumber, routingEpochHash: hash(value.routingEpochHash, "routingEpochHash"), shardHeads: validateHeads(value.shardHeads, routingEpochNumber, limits), publisher: identity(value.publisher, "publisher") };
}

function validateWitness(value) {
  exact(value, ["kind", "protocolVersion", "ledgerId", "checkpointNumber", "checkpointHash", "checkpointFileHash", "observedAt", "witness"], "WITNESS_FIELDS", "witness receipt");
  invariant(value.kind === "g9p-witness-receipt" && value.protocolVersion === 1 && typeof value.ledgerId === "string" && value.ledgerId.length > 0, "WITNESS_VERSION", "Unsupported witness receipt");
  return { ...value, checkpointNumber: integer(value.checkpointNumber, "checkpointNumber"), checkpointHash: hash(value.checkpointHash, "checkpointHash"), checkpointFileHash: hash(value.checkpointFileHash, "checkpointFileHash"), observedAt: timestamp(value.observedAt, "observedAt"), witness: identity(value.witness, "witness") };
}

async function publish({ outputPath, sealedStorage, storageKey, bytes, description }) {
  if (sealedStorage !== undefined) return requireSealedStorage(sealedStorage).publish(storageKey, bytes, { description });
  await writeExclusiveAndPromote(outputPath, bytes, { errorCode: "ATTESTATION_WRITE", extensionErrorCode: "ATTESTATION_EXTENSION", description });
}

function container(frameType, payload, signer, signatureDomain) {
  const signaturePayload = encodeCanonical({ algorithm: signer.algorithm, keyId: signer.keyId, signature: Uint8Array.from(signDomainCommitment(signer.privateKey, signatureDomain, payload)) });
  return Buffer.concat([G9P_MAGIC_V2, encodeFrame(frameType, payload), encodeFrame(FRAME_TYPES.signature, signaturePayload), encodeFrame(FRAME_TYPES.end)]);
}

function parse(bytes, frameType, limits) {
  invariant(bytes instanceof Uint8Array && bytes.byteLength <= limits.maxFileBytes, "ATTESTATION_FILE_LIMIT", "Attestation input exceeds its file limit");
  const reader = new FrameReader(bytes, { maxFrameBytes: limits.maxFrameBytes });
  reader.readMagic(G9P_MAGIC_V2);
  const statement = reader.readFrame(frameType);
  const signed = reader.readFrame(FRAME_TYPES.signature);
  invariant(reader.readFrame(FRAME_TYPES.end).payload.length === 0, "ATTESTATION_END", "End frame must be empty");
  reader.assertEnd();
  return { statement, signed };
}

function trusted(options, keyId, requiredCode) {
  const ids = options.trustedKeyIds instanceof Set ? options.trustedKeyIds : new Set(options.trustedKeyIds ?? []);
  const result = ids.has(keyId);
  if (options.requireTrustedSigner === true) invariant(result, requiredCode, `Signer ${keyId} is not trusted`);
  return result;
}

export async function writeCheckpoint({ outputPath, sealedStorage, storageKey, ledgerId, checkpointNumber, previousCheckpointHash = null, routingEpochNumber, routingEpochHash, shardHeads, publisher, createdAt = new Date().toISOString() }) {
  const descriptor = validateCheckpoint({ kind: "g9p-checkpoint", protocolVersion: 1, ledgerId, checkpointNumber, createdAt, previousCheckpointHash, routingEpochNumber, routingEpochHash, shardHeads, publisher: signerIdentity(publisher) }, LIMITS);
  const payload = encodeCanonical(descriptor);
  const bytes = container(FRAME_TYPES.checkpoint, payload, publisher, "checkpoint-signature-v1");
  await publish({ outputPath, sealedStorage, storageKey, bytes, description: "sealed checkpoint" });
  return { ledgerId, checkpointNumber, checkpointHash: toHex(domainHash("checkpoint-v1", payload)), fileHash: toHex(domainHash("checkpoint-file-v1", bytes)), publisherKeyId: publisher.keyId, byteLength: bytes.length };
}

export async function verifyCheckpointBytes(bytes, options = {}) {
  const limits = { ...LIMITS, ...options.limits };
  const { statement, signed } = parse(bytes, FRAME_TYPES.checkpoint, limits);
  const descriptor = validateCheckpoint(decodeCanonical(statement.payload), limits);
  const signedValue = decodeCanonical(signed.payload);
  signature(signedValue, descriptor.publisher);
  let key;
  try { key = importPublicKey(descriptor.publisher.publicKey); } catch (error) { fail("CHECKPOINT_PUBLIC_KEY", "Checkpoint publisher key cannot be imported", error); }
  invariant(verifyDomainCommitment(key, "checkpoint-signature-v1", statement.payload, signedValue.signature), "CHECKPOINT_SIGNATURE", "Checkpoint signature is invalid");
  const publisherTrusted = trusted(options, descriptor.publisher.keyId, "CHECKPOINT_UNTRUSTED_PUBLISHER");
  let previousHashVerified = false;
  if (Object.hasOwn(options, "expectedPreviousCheckpointHash")) {
    const expected = hash(options.expectedPreviousCheckpointHash, "expectedPreviousCheckpointHash", true);
    const matches = expected === null
      ? descriptor.previousCheckpointHash === null
      : descriptor.previousCheckpointHash !== null && Buffer.from(expected).equals(Buffer.from(descriptor.previousCheckpointHash));
    invariant(matches, "CHECKPOINT_PREVIOUS_HASH", "Checkpoint does not link to the expected previous checkpoint");
    previousHashVerified = true;
  }
  return { valid: true, ...descriptor, previousCheckpointHash: descriptor.previousCheckpointHash === null ? null : toHex(descriptor.previousCheckpointHash), previousHashVerified, routingEpochHash: toHex(descriptor.routingEpochHash), shardHeads: descriptor.shardHeads.map((head) => ({ ...head, segmentHash: head.segmentHash === null ? null : toHex(head.segmentHash) })), checkpointHash: toHex(domainHash("checkpoint-v1", statement.payload)), fileHash: toHex(domainHash("checkpoint-file-v1", bytes)), publisherKeyId: descriptor.publisher.keyId, publisherTrusted };
}

export async function verifyCheckpoint(path, options = {}) {
  const details = await stat(path);
  invariant(details.isFile() && details.size <= (options.limits?.maxFileBytes ?? LIMITS.maxFileBytes), "ATTESTATION_FILE_LIMIT", "Checkpoint path is not a bounded file");
  return verifyCheckpointBytes(await readFile(path), { ...options, source: path });
}

export async function writeWitnessReceipt({ outputPath, sealedStorage, storageKey, checkpointBytes, witness, observedAt = new Date().toISOString(), trustedPublisherKeyIds, requireTrustedPublisher = true }) {
  const checkpoint = await verifyCheckpointBytes(checkpointBytes, { trustedKeyIds: trustedPublisherKeyIds, requireTrustedSigner: requireTrustedPublisher });
  const receipt = validateWitness({ kind: "g9p-witness-receipt", protocolVersion: 1, ledgerId: checkpoint.ledgerId, checkpointNumber: checkpoint.checkpointNumber, checkpointHash: Uint8Array.from(Buffer.from(checkpoint.checkpointHash, "hex")), checkpointFileHash: Uint8Array.from(Buffer.from(checkpoint.fileHash, "hex")), observedAt, witness: signerIdentity(witness) });
  const payload = encodeCanonical(receipt);
  const bytes = container(FRAME_TYPES.witness, payload, witness, "witness-signature-v1");
  await publish({ outputPath, sealedStorage, storageKey, bytes, description: "sealed witness receipt" });
  return { ledgerId: receipt.ledgerId, checkpointNumber: receipt.checkpointNumber, checkpointHash: checkpoint.checkpointHash, receiptHash: toHex(domainHash("witness-receipt-v1", payload)), fileHash: toHex(domainHash("witness-file-v1", bytes)), witnessKeyId: witness.keyId, byteLength: bytes.length };
}

export async function verifyWitnessReceiptBytes(bytes, options = {}) {
  const limits = { ...LIMITS, ...options.limits };
  const { statement, signed } = parse(bytes, FRAME_TYPES.witness, limits);
  const receipt = validateWitness(decodeCanonical(statement.payload));
  const signedValue = decodeCanonical(signed.payload);
  signature(signedValue, receipt.witness);
  let key;
  try { key = importPublicKey(receipt.witness.publicKey); } catch (error) { fail("WITNESS_PUBLIC_KEY", "Witness key cannot be imported", error); }
  invariant(verifyDomainCommitment(key, "witness-signature-v1", statement.payload, signedValue.signature), "WITNESS_SIGNATURE", "Witness signature is invalid");
  const witnessTrusted = trusted(options, receipt.witness.keyId, "WITNESS_UNTRUSTED");
  return { valid: true, ...receipt, checkpointHash: toHex(receipt.checkpointHash), checkpointFileHash: toHex(receipt.checkpointFileHash), receiptHash: toHex(domainHash("witness-receipt-v1", statement.payload)), fileHash: toHex(domainHash("witness-file-v1", bytes)), witnessKeyId: receipt.witness.keyId, witnessTrusted };
}

export async function verifyWitnessReceipt(path, options = {}) {
  const details = await stat(path);
  invariant(details.isFile() && details.size <= (options.limits?.maxFileBytes ?? LIMITS.maxFileBytes), "ATTESTATION_FILE_LIMIT", "Witness receipt path is not a bounded file");
  return verifyWitnessReceiptBytes(await readFile(path), { ...options, source: path });
}

export async function verifyThresholdAttestation({ checkpointBytes, witnessReceiptBytes, policy, trustedPublisherKeyIds }) {
  exact(policy, ["kind", "version", "threshold", "witnessKeyIds"], "THRESHOLD_POLICY", "threshold policy");
  invariant(policy.kind === "g9p-threshold-policy" && policy.version === 1 && Number.isSafeInteger(policy.threshold) && policy.threshold >= 1, "THRESHOLD_POLICY", "Threshold policy is invalid");
  invariant(Array.isArray(policy.witnessKeyIds) && policy.witnessKeyIds.length <= LIMITS.maxWitnesses && policy.witnessKeyIds.every((id, index) => /^[0-9a-f]{64}$/u.test(id) && (index === 0 || policy.witnessKeyIds[index - 1] < id)), "THRESHOLD_POLICY", "Witness key IDs must be sorted and unique");
  invariant(policy.threshold <= policy.witnessKeyIds.length, "THRESHOLD_POLICY", "Threshold exceeds witness membership");
  invariant(Array.isArray(witnessReceiptBytes) && witnessReceiptBytes.length <= LIMITS.maxWitnesses, "THRESHOLD_RECEIPTS", "Witness receipt input exceeds its count limit");
  const checkpoint = await verifyCheckpointBytes(checkpointBytes, { trustedKeyIds: trustedPublisherKeyIds, requireTrustedSigner: true });
  const receipts = await Promise.all(witnessReceiptBytes.map((bytes) => verifyWitnessReceiptBytes(bytes, { trustedKeyIds: policy.witnessKeyIds, requireTrustedSigner: true })));
  const matching = new Set(receipts.filter((receipt) => receipt.checkpointHash === checkpoint.checkpointHash && receipt.checkpointFileHash === checkpoint.fileHash).map((receipt) => receipt.witnessKeyId));
  invariant(matching.size >= policy.threshold, "THRESHOLD_NOT_MET", `Checkpoint has ${matching.size} valid distinct witness receipts, below threshold ${policy.threshold}`);
  return { valid: true, checkpointHash: checkpoint.checkpointHash, threshold: policy.threshold, witnessCount: matching.size, witnessKeyIds: [...matching].sort() };
}

export const checkpointLimits = LIMITS;
