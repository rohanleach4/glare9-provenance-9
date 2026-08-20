import { loadSignerConfig } from "./config.js";
import { loadCustodySigner, readProtectedPassphrase } from "./key-store.js";
import { createSignerServer } from "./server.js";

const config = loadSignerConfig();
const passphrase = await readProtectedPassphrase(config.passphrasePath);
const signers = Object.fromEntries(await Promise.all(Object.entries(config.keyPaths).map(async ([role, path]) => [role, await loadCustodySigner(path, passphrase)])));
passphrase.fill(0);
const server = createSignerServer({
  socketPath: config.socketPath,
  socketMode: config.socketMode,
  signers,
  audit: (record) => console.log(JSON.stringify({ service: "glare9-provenance-signer", ...record })),
});

try {
  await server.listen();
  console.log(JSON.stringify({ service: "glare9-provenance-signer", status: "listening", roles: Object.fromEntries(Object.entries(signers).map(([role, signer]) => [role, signer.keyId])) }));
} catch (error) {
  console.error(JSON.stringify({ service: "glare9-provenance-signer", status: "failed", code: error.code ?? "UNEXPECTED" }));
  process.exitCode = 1;
}

for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close().then(() => process.exit(0)));
