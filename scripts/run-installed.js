import { resolve } from "node:path";

const [service, environmentPath] = process.argv.slice(2);
if (!new Set(["ledger", "signer"]).has(service) || environmentPath === undefined) {
  process.stderr.write("Usage: npm run start:installed -- <ledger|signer> /absolute/path/to/service.env\n");
  process.exit(2);
}
process.loadEnvFile(resolve(environmentPath));
await import(service === "ledger" ? "../services/ledger/src/main.js" : "../services/signer/src/main.js");
