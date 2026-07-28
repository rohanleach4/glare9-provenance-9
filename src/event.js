import { decodeCanonical, encodeCanonical } from "./codec/canonical.js";
import { domainHash, toHex } from "./crypto.js";
import { fail, invariant } from "./errors.js";

const EVENT_FIELDS = new Set([
  "version",
  "eventId",
  "ledgerId",
  "subject",
  "type",
  "schemaVersion",
  "occurredAt",
  "recordedAt",
  "source",
  "payload",
  "payloadHash",
  "previousStateHash",
  "resultingStateHash",
  "correlationId",
  "causationId",
  "policyReference",
  "metadata",
]);

const SOURCE_FIELDS = new Set(["kind", "identity", "keyId"]);
const SOURCE_KINDS = new Set(["semantic", "outbox", "cdc", "webhook", "batch"]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateText(value, name, { min = 1, max = 512 } = {}) {
  invariant(typeof value === "string", "EVENT_TEXT", `${name} must be a string`);
  invariant(value.length >= min && value.length <= max, "EVENT_TEXT_LENGTH", `${name} must contain between ${min} and ${max} characters`);
  invariant(value.normalize("NFC") === value, "EVENT_TEXT_NORMALIZATION", `${name} must use Unicode NFC normalization`);
  invariant(!value.includes("\0"), "EVENT_TEXT_NULL", `${name} must not contain a null character`);
}

function validateTimestamp(value, name) {
  validateText(value, name, { max: 64 });
  const parsed = new Date(value);
  invariant(!Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value, "EVENT_TIMESTAMP", `${name} must be a canonical UTC ISO-8601 timestamp`);
}

function validateHash(value, name) {
  invariant(typeof value === "string" && /^[0-9a-f]{64}$/u.test(value), "EVENT_HASH", `${name} must be a lowercase 32-byte hexadecimal hash`);
}

function validateData(value, path = "value", depth = 0) {
  invariant(depth <= 64, "EVENT_DATA_DEPTH", `${path} exceeds the maximum depth`);

  if (value === null || typeof value === "boolean") return;

  if (typeof value === "string") {
    invariant(value.normalize("NFC") === value, "EVENT_DATA_NORMALIZATION", `${path} must use Unicode NFC normalization`);
    return;
  }

  if (typeof value === "number") {
    invariant(Number.isFinite(value), "EVENT_DATA_NUMBER", `${path} must contain a finite number`);
    invariant(!Number.isInteger(value) || Number.isSafeInteger(value), "EVENT_DATA_INTEGER", `${path} contains an unsafe integer`);
    return;
  }

  if (value instanceof Uint8Array) return;

  if (Array.isArray(value)) {
    value.forEach((item, index) => validateData(item, `${path}[${index}]`, depth + 1));
    return;
  }

  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      validateText(key, `${path} key`, { max: 256 });
      validateData(item, `${path}.${key}`, depth + 1);
    }
    return;
  }

  fail("EVENT_DATA_TYPE", `${path} contains an unsupported value type`);
}

function rejectUnknownFields(value, allowed, name) {
  for (const key of Object.keys(value)) {
    invariant(allowed.has(key), "EVENT_UNKNOWN_FIELD", `${name} contains unknown field ${key}`);
  }
}

export function validateEvent(event) {
  invariant(isPlainObject(event), "EVENT_OBJECT", "Event must be a plain object");
  rejectUnknownFields(event, EVENT_FIELDS, "Event");

  invariant(event.version === 1, "EVENT_VERSION", "Event version must be 1");
  validateText(event.eventId, "eventId", { max: 128 });
  validateText(event.ledgerId, "ledgerId", { max: 128 });
  validateText(event.subject, "subject", { max: 512 });
  validateText(event.type, "type", { max: 256 });
  invariant(Number.isSafeInteger(event.schemaVersion) && event.schemaVersion >= 1, "EVENT_SCHEMA_VERSION", "schemaVersion must be a positive safe integer");
  validateTimestamp(event.occurredAt, "occurredAt");
  validateTimestamp(event.recordedAt, "recordedAt");

  invariant(isPlainObject(event.source), "EVENT_SOURCE", "source must be a plain object");
  rejectUnknownFields(event.source, SOURCE_FIELDS, "source");
  invariant(SOURCE_KINDS.has(event.source.kind), "EVENT_SOURCE_KIND", "source.kind is not supported");
  validateText(event.source.identity, "source.identity", { max: 256 });
  if (event.source.keyId !== undefined) validateText(event.source.keyId, "source.keyId", { max: 256 });

  if (event.payload !== undefined) validateData(event.payload, "payload");
  if (event.metadata !== undefined) validateData(event.metadata, "metadata");

  for (const field of ["payloadHash", "previousStateHash", "resultingStateHash"]) {
    if (event[field] !== undefined) validateHash(event[field], field);
  }

  for (const field of ["correlationId", "causationId", "policyReference"]) {
    if (event[field] !== undefined) validateText(event[field], field, { max: 512 });
  }

  invariant(event.payload !== undefined || event.payloadHash !== undefined, "EVENT_PAYLOAD", "Event must include payload or payloadHash");
  return event;
}

export function canonicalEventBytes(event) {
  validateEvent(event);
  return encodeCanonical(event);
}

export function decodeEvent(bytes) {
  const event = decodeCanonical(bytes);
  validateEvent(event);
  return event;
}

export function eventHash(eventOrBytes) {
  const bytes = eventOrBytes instanceof Uint8Array ? Buffer.from(eventOrBytes) : canonicalEventBytes(eventOrBytes);
  return domainHash("event-record-v1", bytes);
}

export function eventHashHex(eventOrBytes) {
  return toHex(eventHash(eventOrBytes));
}
