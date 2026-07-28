function integer(value, fallback, name, { min, max }) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function required(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function boolean(value, fallback, name) {
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

export function loadConnectorConfig(environment = process.env) {
  const sslMode = environment.MYSQL_SSL_MODE ?? "required";
  if (!new Set(["required", "disabled"]).has(sslMode)) {
    throw new Error("MYSQL_SSL_MODE must be required or disabled");
  }

  const mysql = {
    host: required(environment.MYSQL_HOST, "MYSQL_HOST"),
    port: integer(environment.MYSQL_PORT, 3306, "MYSQL_PORT", { min: 1, max: 65_535 }),
    user: required(environment.MYSQL_USER, "MYSQL_USER"),
    password: required(environment.MYSQL_PASSWORD, "MYSQL_PASSWORD"),
    database: required(environment.MYSQL_DATABASE, "MYSQL_DATABASE"),
    waitForConnections: true,
    connectionLimit: 4,
    queueLimit: 0,
    enableKeepAlive: true,
    timezone: "Z",
    decimalNumbers: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
  };

  if (sslMode === "required") {
    mysql.ssl = {
      rejectUnauthorized: boolean(environment.MYSQL_SSL_REJECT_UNAUTHORIZED, true, "MYSQL_SSL_REJECT_UNAUTHORIZED"),
      ...(environment.MYSQL_SSL_CA === undefined ? {} : { ca: environment.MYSQL_SSL_CA }),
    };
  }

  return Object.freeze({
    mysql: Object.freeze(mysql),
    outboxTable: environment.MYSQL_OUTBOX_TABLE ?? "provenance_outbox",
    provenanceUrl: required(environment.PROVENANCE_URL, "PROVENANCE_URL"),
    provenanceToken: required(environment.PROVENANCE_API_TOKEN, "PROVENANCE_API_TOKEN"),
    connectorId: required(environment.CONNECTOR_ID, "CONNECTOR_ID"),
    batchSize: integer(environment.CONNECTOR_BATCH_SIZE, 100, "CONNECTOR_BATCH_SIZE", { min: 1, max: 1_000 }),
    pollIntervalMs: integer(environment.CONNECTOR_POLL_INTERVAL_MS, 1_000, "CONNECTOR_POLL_INTERVAL_MS", { min: 50, max: 300_000 }),
    leaseSeconds: integer(environment.CONNECTOR_LEASE_SECONDS, 30, "CONNECTOR_LEASE_SECONDS", { min: 5, max: 3_600 }),
    maxAttempts: integer(environment.CONNECTOR_MAX_ATTEMPTS, 20, "CONNECTOR_MAX_ATTEMPTS", { min: 1, max: 10_000 }),
    retryBaseMs: integer(environment.CONNECTOR_RETRY_BASE_MS, 1_000, "CONNECTOR_RETRY_BASE_MS", { min: 100, max: 3_600_000 }),
    retryMaxMs: integer(environment.CONNECTOR_RETRY_MAX_MS, 60_000, "CONNECTOR_RETRY_MAX_MS", { min: 100, max: 86_400_000 }),
    healthHost: environment.CONNECTOR_HEALTH_HOST ?? "127.0.0.1",
    healthPort: integer(environment.CONNECTOR_HEALTH_PORT, 8_790, "CONNECTOR_HEALTH_PORT", { min: 1, max: 65_535 }),
  });
}
