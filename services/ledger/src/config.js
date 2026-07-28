import { resolve } from "node:path";

function integer(value, fallback, name, { min, max }) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

export function loadLedgerConfig(environment = process.env) {
  const token = environment.PROVENANCE_API_TOKEN;
  if (typeof token !== "string" || token.length < 16) {
    throw new Error("PROVENANCE_API_TOKEN must contain at least 16 characters");
  }

  return Object.freeze({
    host: environment.PROVENANCE_HOST ?? "127.0.0.1",
    port: integer(environment.PROVENANCE_PORT, 8787, "PROVENANCE_PORT", { min: 1, max: 65_535 }),
    apiToken: token,
    dataDirectory: resolve(environment.PROVENANCE_DATA_DIR ?? "runtime/ledger-service"),
    shardCount: integer(environment.PROVENANCE_SHARD_COUNT, 1, "PROVENANCE_SHARD_COUNT", { min: 1, max: 65_536 }),
    maxBatchEvents: integer(environment.PROVENANCE_MAX_BATCH_EVENTS, 500, "PROVENANCE_MAX_BATCH_EVENTS", { min: 1, max: 10_000 }),
    maxRequestBytes: integer(environment.PROVENANCE_MAX_REQUEST_BYTES, 8 * 1024 * 1024, "PROVENANCE_MAX_REQUEST_BYTES", { min: 1024, max: 64 * 1024 * 1024 }),
  });
}
