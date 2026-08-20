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

function tokenSet(value, fallback, name) {
  const source = value ?? fallback;
  if (typeof source !== "string") throw new Error(`${name} is required`);
  const tokens = source.split(",").map((token) => token.trim());
  if (tokens.length < 1 || tokens.length > 4 || tokens.some((token) => token.length < 16) || new Set(tokens).size !== tokens.length) {
    throw new Error(`${name} must contain one to four distinct comma-separated tokens of at least 16 characters`);
  }
  return Object.freeze(tokens);
}

function optionalPath(value) {
  return value === undefined ? undefined : resolve(value);
}

function custodyMode(value) {
  const mode = value ?? "development";
  if (!new Set(["development", "integrated", "separated"]).has(mode)) throw new Error("PROVENANCE_CUSTODY_MODE must be development, integrated or separated");
  return mode;
}

export function loadLedgerConfig(environment = process.env) {
  const apiTokens = tokenSet(environment.PROVENANCE_API_TOKENS, environment["PROVENANCE_API_TOKEN"], "PROVENANCE_API_TOKENS");
  const adminTokens = environment.PROVENANCE_ADMIN_TOKENS === undefined && environment["PROVENANCE_ADMIN_TOKEN"] === undefined
    ? Object.freeze([])
    : tokenSet(environment.PROVENANCE_ADMIN_TOKENS, environment["PROVENANCE_ADMIN_TOKEN"], "PROVENANCE_ADMIN_TOKENS");
  if (apiTokens.some((token) => adminTokens.includes(token))) throw new Error("Administration tokens must be different from ingestion tokens");
  const tlsCertPath = optionalPath(environment.PROVENANCE_TLS_CERT_PATH);
  const tlsKeyPath = optionalPath(environment.PROVENANCE_TLS_KEY_PATH);
  if ((tlsCertPath === undefined) !== (tlsKeyPath === undefined)) throw new Error("PROVENANCE_TLS_CERT_PATH and PROVENANCE_TLS_KEY_PATH must be configured together");
  const requireClientCertificate = boolean(environment.PROVENANCE_TLS_REQUIRE_CLIENT_CERTIFICATE, false, "PROVENANCE_TLS_REQUIRE_CLIENT_CERTIFICATE");
  const tlsClientCaPath = optionalPath(environment.PROVENANCE_TLS_CLIENT_CA_PATH);
  if (requireClientCertificate && tlsClientCaPath === undefined) throw new Error("PROVENANCE_TLS_CLIENT_CA_PATH is required when client certificates are required");
  const selectedCustodyMode = custodyMode(environment.PROVENANCE_CUSTODY_MODE);
  const installationManifestPath = optionalPath(environment.PROVENANCE_INSTALLATION_MANIFEST_PATH);
  const keyPassphrasePath = optionalPath(environment.PROVENANCE_KEY_PASSPHRASE_FILE);
  const segmentSigningKeyPath = optionalPath(environment.PROVENANCE_SEGMENT_SIGNING_KEY_PATH);
  const topologySigningKeyPath = optionalPath(environment.PROVENANCE_TOPOLOGY_SIGNING_KEY_PATH);
  const checkpointSigningKeyPath = optionalPath(environment.PROVENANCE_CHECKPOINT_SIGNING_KEY_PATH);
  const signerSocketPath = optionalPath(environment.PROVENANCE_SIGNER_SOCKET_PATH);
  if (selectedCustodyMode !== "development" && installationManifestPath === undefined) throw new Error("PROVENANCE_INSTALLATION_MANIFEST_PATH is required for an installed custody profile");
  if (selectedCustodyMode === "integrated" && [keyPassphrasePath, segmentSigningKeyPath, topologySigningKeyPath, checkpointSigningKeyPath].some((value) => value === undefined)) {
    throw new Error("Integrated custody requires the passphrase and all three signing-key paths");
  }
  if (selectedCustodyMode === "separated" && signerSocketPath === undefined) throw new Error("Separated custody requires PROVENANCE_SIGNER_SOCKET_PATH");
  if (selectedCustodyMode === "separated" && [keyPassphrasePath, segmentSigningKeyPath, topologySigningKeyPath, checkpointSigningKeyPath].some((value) => value !== undefined)) {
    throw new Error("Separated custody must not configure local signing-key or passphrase paths");
  }

  return Object.freeze({
    host: environment.PROVENANCE_HOST ?? "127.0.0.1",
    port: integer(environment.PROVENANCE_PORT, 8787, "PROVENANCE_PORT", { min: 1, max: 65_535 }),
    apiTokens,
    adminTokens,
    tls: tlsCertPath === undefined ? undefined : Object.freeze({
      certPath: tlsCertPath,
      keyPath: tlsKeyPath,
      caPath: tlsClientCaPath,
      requireClientCertificate,
    }),
    dataDirectory: resolve(environment.PROVENANCE_DATA_DIR ?? "runtime/ledger-service"),
    custodyMode: selectedCustodyMode,
    installationManifestPath,
    keyPassphrasePath,
    segmentSigningKeyPath,
    topologySigningKeyPath,
    checkpointSigningKeyPath,
    signerSocketPath,
    signerTimeoutMs: integer(environment.PROVENANCE_SIGNER_TIMEOUT_MS, 5_000, "PROVENANCE_SIGNER_TIMEOUT_MS", { min: 100, max: 60_000 }),
    segmentTrustBundlePath: optionalPath(environment.PROVENANCE_SEGMENT_TRUST_BUNDLE_PATH),
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
