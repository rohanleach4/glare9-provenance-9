import { resolve } from "node:path";

function integer(value, fallback, name, { min, max }) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function boolean(value, fallback, name) {
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function optionalToken(value, name) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length < 16) {
    throw new Error(`${name} must contain at least 16 characters when configured`);
  }
  return value;
}

export function loadLedgerConfig(environment = process.env) {
  const token = environment.PROVENANCE_API_TOKEN;
  if (typeof token !== "string" || token.length < 16) {
    throw new Error("PROVENANCE_API_TOKEN must contain at least 16 characters");
  }
  const adminToken = optionalToken(environment.PROVENANCE_ADMIN_TOKEN, "PROVENANCE_ADMIN_TOKEN");
  if (adminToken === token) {
    throw new Error("PROVENANCE_ADMIN_TOKEN must be different from PROVENANCE_API_TOKEN");
  }

  return Object.freeze({
    host: environment.PROVENANCE_HOST ?? "127.0.0.1",
    port: integer(environment.PROVENANCE_PORT, 8787, "PROVENANCE_PORT", { min: 1, max: 65_535 }),
    apiToken: token,
    adminToken,
    dataDirectory: resolve(environment.PROVENANCE_DATA_DIR ?? "runtime/ledger-service"),
    shardCount: integer(environment.PROVENANCE_SHARD_COUNT, 1, "PROVENANCE_SHARD_COUNT", { min: 1, max: 65_536 }),
    adoptLegacyRoutingHistory: boolean(environment.PROVENANCE_ADOPT_LEGACY_ROUTING_HISTORY, false, "PROVENANCE_ADOPT_LEGACY_ROUTING_HISTORY"),
    maxBatchEvents: integer(environment.PROVENANCE_MAX_BATCH_EVENTS, 500, "PROVENANCE_MAX_BATCH_EVENTS", { min: 1, max: 10_000 }),
    maxRequestBytes: integer(environment.PROVENANCE_MAX_REQUEST_BYTES, 8 * 1024 * 1024, "PROVENANCE_MAX_REQUEST_BYTES", { min: 1024, max: 64 * 1024 * 1024 }),
    lifecycle: Object.freeze({
      blockMaxBytes: integer(environment.PROVENANCE_BLOCK_MAX_BYTES, 1024 * 1024, "PROVENANCE_BLOCK_MAX_BYTES", { min: 1024, max: 64 * 1024 * 1024 }),
      blockMaxRecords: integer(environment.PROVENANCE_BLOCK_MAX_RECORDS, 1_000, "PROVENANCE_BLOCK_MAX_RECORDS", { min: 1, max: 100_000 }),
      segmentMaxBytes: integer(environment.PROVENANCE_SEGMENT_MAX_BYTES, 32 * 1024 * 1024, "PROVENANCE_SEGMENT_MAX_BYTES", { min: 1024, max: 64 * 1024 * 1024 }),
      segmentMaxRecords: integer(environment.PROVENANCE_SEGMENT_MAX_RECORDS, 10_000, "PROVENANCE_SEGMENT_MAX_RECORDS", { min: 1, max: 100_000 }),
      segmentMaxAgeMs: integer(environment.PROVENANCE_SEGMENT_MAX_AGE_MS, 30_000, "PROVENANCE_SEGMENT_MAX_AGE_MS", { min: 100, max: 7 * 24 * 60 * 60 * 1000 }),
      maxAcceptedEvents: integer(environment.PROVENANCE_MAX_ACCEPTED_EVENTS, 100_000, "PROVENANCE_MAX_ACCEPTED_EVENTS", { min: 1, max: 10_000_000 }),
      maxAcceptedBytes: integer(environment.PROVENANCE_MAX_ACCEPTED_BYTES, 1024 * 1024 * 1024, "PROVENANCE_MAX_ACCEPTED_BYTES", { min: 1024, max: Number.MAX_SAFE_INTEGER }),
      maxActiveBlockBytes: integer(environment.PROVENANCE_MAX_ACTIVE_BLOCK_BYTES, 16 * 1024 * 1024, "PROVENANCE_MAX_ACTIVE_BLOCK_BYTES", { min: 1024, max: 1024 * 1024 * 1024 }),
    }),
  });
}
