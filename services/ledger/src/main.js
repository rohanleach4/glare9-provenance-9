import { readFile } from "node:fs/promises";

import { loadLedgerConfig } from "./config.js";
import { loadOrCreateLocalSigner, loadOrCreateLocalTopologyAuthority } from "./key-store.js";
import { LocalLedger } from "./local-ledger.js";
import { createLedgerServer } from "./server.js";

async function main() {
  const config = loadLedgerConfig();
  const [signer, topologyAuthority] = await Promise.all([
    loadOrCreateLocalSigner(config.dataDirectory),
    loadOrCreateLocalTopologyAuthority(config.dataDirectory),
  ]);
  const ledger = await new LocalLedger({
    dataDirectory: config.dataDirectory,
    signer,
    topologyAuthority,
    shardCount: config.shardCount,
    adoptLegacyRoutingHistory: config.adoptLegacyRoutingHistory,
    lifecycle: config.lifecycle,
  }).initialize();
  const tls = config.tls === undefined ? undefined : {
    cert: await readFile(config.tls.certPath),
    key: await readFile(config.tls.keyPath),
    ...(config.tls.caPath === undefined ? {} : { ca: await readFile(config.tls.caPath) }),
    requestCert: config.tls.requireClientCertificate,
    rejectUnauthorized: config.tls.requireClientCertificate,
    minVersion: "TLSv1.3",
  };
  const service = createLedgerServer({
    ledger,
    apiTokens: config.apiTokens,
    adminTokens: config.adminTokens,
    tls,
    maxBatchEvents: config.maxBatchEvents,
    maxRequestBytes: config.maxRequestBytes,
  });
  const address = await service.listen(config);
  console.log(JSON.stringify({
    service: "glare9-provenance-ledger",
    status: "listening",
    host: address.address,
    port: address.port,
    signerKeyId: signer.keyId,
    topologyAuthorityKeyId: topologyAuthority.keyId,
  }));

  const stop = async (signal) => {
    console.log(JSON.stringify({ service: "glare9-provenance-ledger", status: "stopping", signal }));
    await service.close();
    await ledger.close({ seal: true });
  };
  process.once("SIGINT", () => stop("SIGINT").then(() => process.exit(0)));
  process.once("SIGTERM", () => stop("SIGTERM").then(() => process.exit(0)));
}

main().catch((error) => {
  console.error(JSON.stringify({ service: "glare9-provenance-ledger", status: "failed", code: error.code ?? "UNEXPECTED" }));
  process.exitCode = 1;
});
