import assert from "node:assert/strict";
import test from "node:test";

import { loadConnectorConfig } from "../src/config.js";
import { quoteTablePath } from "../src/table.js";

const baseEnvironment = {
  MYSQL_HOST: "mysql.example",
  MYSQL_USER: "connector",
  MYSQL_PASSWORD: "secret",
  MYSQL_DATABASE: "application",
  PROVENANCE_URL: "https://ledger.example",
  PROVENANCE_API_TOKEN: "ledger-secret-123456",
  CONNECTOR_ID: "connector-1",
};

test("connector configuration requires TLS by default", () => {
  const config = loadConnectorConfig(baseEnvironment);
  assert.equal(config.mysql.ssl.rejectUnauthorized, true);
  assert.equal(config.outboxTable, "provenance_outbox");
});

test("TLS can be disabled explicitly for local development", () => {
  const config = loadConnectorConfig({ ...baseEnvironment, MYSQL_SSL_MODE: "disabled" });
  assert.equal(config.mysql.ssl, undefined);
});

test("connector metrics require an optional distinct long secret", () => {
  assert.equal(loadConnectorConfig(baseEnvironment).metricsToken, undefined);
  assert.equal(loadConnectorConfig({ ...baseEnvironment, CONNECTOR_METRICS_TOKEN: "metrics-token-123456" }).metricsToken, "metrics-token-123456");
  assert.throws(() => loadConnectorConfig({ ...baseEnvironment, CONNECTOR_METRICS_TOKEN: "short" }));
});

test("connector can overlap bounded ledger credentials during rotation", () => {
  const config = loadConnectorConfig({
    ...baseEnvironment,
    PROVENANCE_API_TOKEN: undefined,
    PROVENANCE_API_TOKENS: "new-ledger-token-123456,old-ledger-token-123456",
  });
  assert.deepEqual(config.provenanceTokens, ["new-ledger-token-123456", "old-ledger-token-123456"]);
});

test("table paths accept only safe one- or two-part identifiers", () => {
  assert.equal(quoteTablePath("provenance_outbox"), "`provenance_outbox`");
  assert.equal(quoteTablePath("audit.provenance_outbox"), "`audit`.`provenance_outbox`");
  assert.throws(() => quoteTablePath("outbox; DROP TABLE users"));
  assert.throws(() => quoteTablePath("one.two.three"));
});
