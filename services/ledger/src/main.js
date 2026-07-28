import { loadLedgerConfig } from "./config.js";
import { loadOrCreateLocalSigner } from "./key-store.js";
import { LocalLedger } from "./local-ledger.js";
import { createLedgerServer } from "./server.js";

async function main() {
  const config = loadLedgerConfig();
  const signer = await loadOrCreateLocalSigner(config.dataDirectory);
  const ledger = await new LocalLedger({
    dataDirectory: config.dataDirectory,
    signer,
    shardCount: config.shardCount,
  }).initialize();
  const service = createLedgerServer({
    ledger,
    apiToken: config.apiToken,
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
  }));

  const stop = async (signal) => {
    console.log(JSON.stringify({ service: "glare9-provenance-ledger", status: "stopping", signal }));
    await service.close();
  };
  process.once("SIGINT", () => stop("SIGINT").then(() => process.exit(0)));
  process.once("SIGTERM", () => stop("SIGTERM").then(() => process.exit(0)));
}

main().catch((error) => {
  console.error(JSON.stringify({ service: "glare9-provenance-ledger", status: "failed", code: error.code ?? "UNEXPECTED", message: error.message }));
  process.exitCode = 1;
});
