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
