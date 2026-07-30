import { G9pError, invariant } from "./errors.js";

const KEY_ID = /^[0-9a-f]{64}$/u;
const SHARD_ID = /^shard-[0-9]{4}$/u;
const VALIDATED = new WeakSet();
const INDEXES = new WeakMap();

function exact(value, fields, code, name) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), code, `${name} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  invariant(actual.length === expected.length && actual.every((field, index) => field === expected[index]), code, `${name} fields do not match version 1`);
}

function positionCompare(left, right) {
  return left.ledgerId.localeCompare(right.ledgerId)
    || left.epochNumber - right.epochNumber
    || left.shardId.localeCompare(right.shardId)
    || left.firstSegmentNumber - right.firstSegmentNumber;
}

function sameStream(left, right) {
  return left.ledgerId === right.ledgerId && left.epochNumber === right.epochNumber && left.shardId === right.shardId;
}

export function validateSegmentTrustBundle(value) {
  if (value !== null && typeof value === "object" && VALIDATED.has(value)) return value;
  exact(value, ["kind", "version", "bundleId", "bindings"], "TRUST_BUNDLE_FIELDS", "segment trust bundle");
  invariant(value.kind === "g9p-segment-trust-bundle" && value.version === 1, "TRUST_BUNDLE_VERSION", "Unsupported segment trust bundle");
  invariant(typeof value.bundleId === "string" && value.bundleId.length >= 1 && value.bundleId.length <= 256, "TRUST_BUNDLE_ID", "Trust bundle ID is invalid");
  invariant(Array.isArray(value.bindings) && value.bindings.length >= 1 && value.bindings.length <= 65_536, "TRUST_BUNDLE_BINDINGS", "Trust bundle requires a bounded binding list");
  const bindings = value.bindings.map((binding, index) => {
    exact(binding, ["ledgerId", "epochNumber", "shardId", "firstSegmentNumber", "lastSegmentNumber", "keyId", "status"], "TRUST_BINDING_FIELDS", `bindings[${index}]`);
    invariant(typeof binding.ledgerId === "string" && binding.ledgerId.length >= 1 && binding.ledgerId.length <= 1024, "TRUST_BINDING_LEDGER", `bindings[${index}] ledger is invalid`);
    invariant(Number.isSafeInteger(binding.epochNumber) && binding.epochNumber >= 0 && SHARD_ID.test(binding.shardId), "TRUST_BINDING_STREAM", `bindings[${index}] stream is invalid`);
    invariant(Number.isSafeInteger(binding.firstSegmentNumber) && binding.firstSegmentNumber >= 0, "TRUST_BINDING_RANGE", `bindings[${index}] first segment is invalid`);
    invariant(binding.lastSegmentNumber === null || (Number.isSafeInteger(binding.lastSegmentNumber) && binding.lastSegmentNumber >= binding.firstSegmentNumber), "TRUST_BINDING_RANGE", `bindings[${index}] last segment is invalid`);
    invariant(KEY_ID.test(binding.keyId) && (binding.status === "trusted" || binding.status === "revoked"), "TRUST_BINDING_IDENTITY", `bindings[${index}] identity or status is invalid`);
    return Object.freeze({ ...binding });
  });
  for (let index = 1; index < bindings.length; index += 1) {
    const previous = bindings[index - 1];
    const current = bindings[index];
    invariant(positionCompare(previous, current) < 0, "TRUST_BINDING_ORDER", "Trust bindings must be strictly ordered by ledger, epoch, shard and first segment");
    invariant(!sameStream(previous, current) || (previous.lastSegmentNumber !== null && previous.lastSegmentNumber < current.firstSegmentNumber), "TRUST_BINDING_OVERLAP", "Trust bindings for one shard stream must not overlap");
  }
  const normalized = Object.freeze({ kind: value.kind, version: value.version, bundleId: value.bundleId, bindings: Object.freeze(bindings) });
  const index = new Map();
  for (const binding of bindings) {
    const key = `${binding.ledgerId}\0${binding.epochNumber}\0${binding.shardId}`;
    const stream = index.get(key) ?? [];
    stream.push(binding);
    index.set(key, stream);
  }
  VALIDATED.add(normalized);
  INDEXES.set(normalized, index);
  return normalized;
}

export function segmentTrustKeyIds(bundle) {
  return new Set(validateSegmentTrustBundle(bundle).bindings.map((binding) => binding.keyId));
}

export function evaluateSegmentTrust(bundle, { ledgerId, epochNumber, shardId, segmentNumber, keyId }) {
  const policy = validateSegmentTrustBundle(bundle);
  invariant(typeof ledgerId === "string" && Number.isSafeInteger(epochNumber) && epochNumber >= 0 && SHARD_ID.test(shardId)
    && Number.isSafeInteger(segmentNumber) && segmentNumber >= 0 && KEY_ID.test(keyId), "TRUST_POSITION", "Segment trust position is invalid");
  const binding = (INDEXES.get(policy).get(`${ledgerId}\0${epochNumber}\0${shardId}`) ?? []).find((candidate) => candidate.firstSegmentNumber <= segmentNumber
    && (candidate.lastSegmentNumber === null || candidate.lastSegmentNumber >= segmentNumber));
  if (binding === undefined) return Object.freeze({ status: "indeterminate", bundleId: policy.bundleId, keyId });
  if (binding.keyId !== keyId) return Object.freeze({ status: "untrusted", bundleId: policy.bundleId, keyId, expectedKeyId: binding.keyId });
  return Object.freeze({ status: binding.status, bundleId: policy.bundleId, keyId });
}

export function requireTrustedSegmentSigner(bundle, position) {
  const decision = evaluateSegmentTrust(bundle, position);
  if (decision.status !== "trusted") throw new G9pError("SEGMENT_SIGNER_TRUST", `Segment signer is ${decision.status} at the authenticated ledger position`);
  return decision;
}
