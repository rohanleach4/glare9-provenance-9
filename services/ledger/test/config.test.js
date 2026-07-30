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
  assert.equal(loadLedgerConfig(baseEnvironment).adminToken, undefined);
  assert.equal(loadLedgerConfig({
    ...baseEnvironment,
    PROVENANCE_ADMIN_TOKEN: "a-separate-long-admin-token",
  }).adminToken, "a-separate-long-admin-token");
  assert.throws(
    () => loadLedgerConfig({ ...baseEnvironment, PROVENANCE_ADMIN_TOKEN: "too-short" }),
    /at least 16 characters/u,
  );
  assert.throws(
    () => loadLedgerConfig({ ...baseEnvironment, PROVENANCE_ADMIN_TOKEN: baseEnvironment.PROVENANCE_API_TOKEN }),
    /must be different/u,
  );
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
