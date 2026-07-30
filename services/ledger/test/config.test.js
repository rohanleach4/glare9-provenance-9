import assert from "node:assert/strict";
import test from "node:test";

import { loadLedgerConfig } from "../src/config.js";

const baseEnvironment = {
  PROVENANCE_API_TOKEN: "a-sufficiently-long-test-token",
};

test("legacy routing adoption is disabled by default and requires an explicit boolean", () => {
  assert.equal(loadLedgerConfig(baseEnvironment).adoptLegacyRoutingHistory, false);
  assert.equal(loadLedgerConfig({
    ...baseEnvironment,
    PROVENANCE_ADOPT_LEGACY_ROUTING_HISTORY: "true",
  }).adoptLegacyRoutingHistory, true);
  assert.throws(
    () => loadLedgerConfig({
      ...baseEnvironment,
      PROVENANCE_ADOPT_LEGACY_ROUTING_HISTORY: "yes",
    }),
    /must be true or false/u,
  );
});

test("routing administration is disabled by default and requires a separate long token", () => {
  assert.deepEqual(loadLedgerConfig(baseEnvironment).adminTokens, []);
  assert.deepEqual(loadLedgerConfig({
    ...baseEnvironment,
    PROVENANCE_ADMIN_TOKEN: "a-separate-long-admin-token",
  }).adminTokens, ["a-separate-long-admin-token"]);
  assert.throws(
    () => loadLedgerConfig({ ...baseEnvironment, PROVENANCE_ADMIN_TOKEN: "too-short" }),
    /at least 16 characters/u,
  );
  assert.throws(
    () => loadLedgerConfig({ ...baseEnvironment, PROVENANCE_ADMIN_TOKEN: baseEnvironment.PROVENANCE_API_TOKEN }),
    /must be different/u,
  );
});

test("ingestion and administration credentials support bounded overlap during rotation", () => {
  const config = loadLedgerConfig({
    PROVENANCE_API_TOKENS: "new-ingestion-token-123,old-ingestion-token-123",
    PROVENANCE_ADMIN_TOKENS: "new-administration-token-123,old-administration-token-123",
  });
  assert.deepEqual(config.apiTokens, ["new-ingestion-token-123", "old-ingestion-token-123"]);
  assert.deepEqual(config.adminTokens, ["new-administration-token-123", "old-administration-token-123"]);
  assert.throws(() => loadLedgerConfig({ PROVENANCE_API_TOKENS: "same-token-value-123,same-token-value-123" }), /distinct/u);
});

test("TLS configuration requires a complete server pair and client CA for mutual TLS", () => {
  assert.throws(() => loadLedgerConfig({ ...baseEnvironment, PROVENANCE_TLS_CERT_PATH: "server.pem" }), /configured together/u);
  assert.throws(() => loadLedgerConfig({
    ...baseEnvironment,
    PROVENANCE_TLS_CERT_PATH: "server.pem",
    PROVENANCE_TLS_KEY_PATH: "server-key.pem",
    PROVENANCE_TLS_REQUIRE_CLIENT_CERTIFICATE: "true",
  }), /CLIENT_CA_PATH/u);
  const config = loadLedgerConfig({
    ...baseEnvironment,
    PROVENANCE_TLS_CERT_PATH: "server.pem",
    PROVENANCE_TLS_KEY_PATH: "server-key.pem",
    PROVENANCE_TLS_CLIENT_CA_PATH: "client-ca.pem",
    PROVENANCE_TLS_REQUIRE_CLIENT_CERTIFICATE: "true",
  });
  assert.equal(config.tls.requireClientCertificate, true);
});

test("bounded lifecycle limits have safe defaults and reject invalid values", () => {
  const config = loadLedgerConfig(baseEnvironment);
  assert.equal(config.lifecycle.blockMaxBytes, 1024 * 1024);
  assert.equal(config.lifecycle.blockMaxRecords, 1_000);
  assert.equal(config.lifecycle.segmentMaxBytes, 32 * 1024 * 1024);
  assert.equal(config.lifecycle.segmentMaxRecords, 10_000);
  assert.equal(config.lifecycle.segmentMaxAgeMs, 30_000);
  assert.equal(config.lifecycle.maxAcceptedEvents, 100_000);
  assert.throws(
    () => loadLedgerConfig({ ...baseEnvironment, PROVENANCE_BLOCK_MAX_BYTES: "100" }),
    /between 1024/u,
  );
  assert.throws(
    () => loadLedgerConfig({ ...baseEnvironment, PROVENANCE_SEGMENT_MAX_AGE_MS: "not-a-number" }),
    /must be an integer/u,
  );
});

test("external segment signer and trust bundle paths are optional resolved configuration", () => {
  const config = loadLedgerConfig({
    ...baseEnvironment,
    PROVENANCE_SEGMENT_SIGNING_KEY_PATH: "keys/successor.pk8",
    PROVENANCE_SEGMENT_TRUST_BUNDLE_PATH: "trust/segments.json",
  });
  assert.equal(config.segmentSigningKeyPath.endsWith("/keys/successor.pk8"), true);
  assert.equal(config.segmentTrustBundlePath.endsWith("/trust/segments.json"), true);
});
