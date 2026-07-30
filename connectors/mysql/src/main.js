import mysql from "mysql2/promise";

import { ProvenanceClient } from "@glare9/provenance-connector-contract";

import { loadConnectorConfig } from "./config.js";
import { createHealthServer } from "./health-server.js";
import { MySqlOutboxRepository } from "./outbox-repository.js";
import { MySqlConnectorWorker } from "./worker.js";

async function main() {
  const config = loadConnectorConfig();
  const pool = mysql.createPool(config.mysql);
  const repository = new MySqlOutboxRepository({
    pool,
    table: config.outboxTable,
    leaseSeconds: config.leaseSeconds,
    maxAttempts: config.maxAttempts,
  });
  const client = new ProvenanceClient({
    baseUrl: config.provenanceUrl,
    token: config.provenanceToken,
  });
  const worker = new MySqlConnectorWorker({
    repository,
    provenanceClient: client,
    connectorId: config.connectorId,
    batchSize: config.batchSize,
    pollIntervalMs: config.pollIntervalMs,
    retryBaseMs: config.retryBaseMs,
    retryMaxMs: config.retryMaxMs,
  });
  const health = createHealthServer({ worker, repository, metricsToken: config.metricsToken });
  const healthAddress = await health.listen({ host: config.healthHost, port: config.healthPort });
  await repository.ping();

  console.log(JSON.stringify({
    service: "glare9-provenance-connector-mysql",
    status: "running",
    connectorId: config.connectorId,
    healthHost: healthAddress.address,
    healthPort: healthAddress.port,
  }));

  const controller = new AbortController();
  const stop = async (signal) => {
    controller.abort();
    console.log(JSON.stringify({ service: "glare9-provenance-connector-mysql", status: "stopping", signal }));
    await health.close();
    await repository.close();
  };
  process.once("SIGINT", () => stop("SIGINT").then(() => process.exit(0)));
  process.once("SIGTERM", () => stop("SIGTERM").then(() => process.exit(0)));

  await worker.run(controller.signal);
}

main().catch((error) => {
  console.error(JSON.stringify({
    service: "glare9-provenance-connector-mysql",
    status: "failed",
    code: error.code ?? "UNEXPECTED",
  }));
  process.exitCode = 1;
});
