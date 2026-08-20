import { randomBytes } from "node:crypto";
import { lstat, mkdir, open } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";

import { createEncryptedSigner } from "../services/ledger/src/key-store.js";

const PRODUCT = "Glare•9 Provenance";
const ROLES = Object.freeze({
  segment: "segment-signing-key",
  topology: "topology-authority-key",
  checkpoint: "checkpoint-publisher-key",
});

function setupError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function writeExclusive(path, bytes, mode = 0o600) {
  let handle;
  try { handle = await open(path, "wx", mode); } catch (cause) {
    if (cause.code === "EEXIST") throw setupError("SETUP_EXISTS", `Installation file already exists: ${path}`);
    throw cause;
  }
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

async function requireAbsent(paths) {
  for (const path of paths) {
    try { await lstat(path); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    throw setupError("SETUP_EXISTS", `Installation file already exists: ${path}`);
  }
}

function envValue(value) {
  return JSON.stringify(String(value));
}

function envFile(entries) {
  return `${entries.map(([name, value]) => `${name}=${envValue(value)}`).join("\n")}\n`;
}

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!new Set(["--custody", "--install-dir", "--data-dir", "--signer-socket"]).has(name)) throw setupError("SETUP_ARGUMENT", `Unsupported setup argument: ${name}`);
    const value = argv[index += 1];
    if (value === undefined || value.length === 0) throw setupError("SETUP_ARGUMENT", `${name} requires a value`);
    result[name.slice(2).replaceAll("-", "_")] = value;
  }
  return result;
}

async function interactiveOptions(options) {
  if (options.custody !== undefined && options.install_dir !== undefined) return options;
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write(`\n${PRODUCT} — Installation Mode\n\n1. Integrated Custody (self-contained default)\n2. Separated Custody (optional self-hosted signer)\n\n`);
    const selected = options.custody ?? await terminal.question("Select custody mode [1]: ");
    const custody = selected === "" || selected === "1" ? "integrated" : selected === "2" ? "separated" : selected;
    const defaultDirectory = resolve("runtime/installation");
    const installDirectory = options.install_dir ?? await terminal.question(`Installation directory [${defaultDirectory}]: `);
    return { ...options, custody, install_dir: installDirectory || defaultDirectory };
  } finally { terminal.close(); }
}

export async function createInstallation(input) {
  const custodyMode = input.custody;
  if (!new Set(["integrated", "separated"]).has(custodyMode)) throw setupError("SETUP_CUSTODY", "Custody must be integrated or separated");
  if (process.platform === "win32" && custodyMode === "separated") throw setupError("SETUP_PLATFORM", "Separated custody currently requires macOS or Linux Unix-domain sockets");
  const installationDirectory = resolve(input.install_dir);
  const dataDirectory = resolve(input.data_dir ?? `${installationDirectory}/data`);
  const keyDirectory = resolve(`${installationDirectory}/custody/keys`);
  const credentialDirectory = resolve(`${installationDirectory}/custody/credentials`);
  const passphrasePath = resolve(`${credentialDirectory}/key-passphrase`);
  const manifestPath = resolve(`${installationDirectory}/installation.json`);
  const ledgerEnvironmentPath = resolve(`${installationDirectory}/ledger.env`);
  const signerEnvironmentPath = custodyMode === "separated" ? resolve(`${installationDirectory}/signer.env`) : null;
  const signerSocketPath = custodyMode === "separated" ? resolve(input.signer_socket ?? `${installationDirectory}/run/glare9-provenance.sock`) : null;
  if (signerSocketPath !== null && Buffer.byteLength(signerSocketPath, "utf8") > 100) throw setupError("SETUP_SOCKET_PATH", "Separated-custody socket path is too long; select a shorter absolute --signer-socket path");

  await requireAbsent([
    passphrasePath,
    manifestPath,
    ledgerEnvironmentPath,
    ...(signerEnvironmentPath === null ? [] : [signerEnvironmentPath]),
    ...Object.values(ROLES).flatMap((name) => [resolve(`${keyDirectory}/${name}.pem`), resolve(`${keyDirectory}/${name}.spki`)]),
  ]);

  await mkdir(installationDirectory, { recursive: true, mode: 0o700 });
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  await mkdir(credentialDirectory, { recursive: true, mode: 0o700 });
  const passphrase = Buffer.from(randomBytes(48).toString("base64"), "utf8");
  await writeExclusive(passphrasePath, passphrase, 0o600);

  const createdKeys = {};
  for (const [role, name] of Object.entries(ROLES)) createdKeys[role] = await createEncryptedSigner(keyDirectory, name, passphrase);
  const installationId = randomBytes(32).toString("hex");
  const manifest = {
    kind: "g9p-installation",
    version: 1,
    product: PRODUCT,
    installationId,
    createdAt: new Date().toISOString(),
    custodyMode,
    dataDirectory,
    signerSocketPath,
    keys: Object.fromEntries(Object.entries(createdKeys).map(([role, value]) => [role, { algorithm: value.signer.algorithm, keyId: value.signer.keyId }])),
  };

  const commonLedger = [
    ["PROVENANCE_HOST", "127.0.0.1"],
    ["PROVENANCE_PORT", "8787"],
    ["PROVENANCE_API_TOKEN", randomBytes(32).toString("hex")],
    ["PROVENANCE_ADMIN_TOKEN", randomBytes(32).toString("hex")],
    ["PROVENANCE_DATA_DIR", dataDirectory],
    ["PROVENANCE_CUSTODY_MODE", custodyMode],
    ["PROVENANCE_INSTALLATION_MANIFEST_PATH", manifestPath],
    ["PROVENANCE_SHARD_COUNT", "1"],
  ];
  const ledgerCustody = custodyMode === "integrated" ? [
    ["PROVENANCE_KEY_PASSPHRASE_FILE", passphrasePath],
    ["PROVENANCE_SEGMENT_SIGNING_KEY_PATH", createdKeys.segment.privateKeyPath],
    ["PROVENANCE_TOPOLOGY_SIGNING_KEY_PATH", createdKeys.topology.privateKeyPath],
    ["PROVENANCE_CHECKPOINT_SIGNING_KEY_PATH", createdKeys.checkpoint.privateKeyPath],
  ] : [
    ["PROVENANCE_SIGNER_SOCKET_PATH", signerSocketPath],
    ["PROVENANCE_SIGNER_TIMEOUT_MS", "5000"],
  ];
  await writeExclusive(ledgerEnvironmentPath, envFile([...commonLedger, ...ledgerCustody]), 0o600);

  if (signerEnvironmentPath !== null) {
    await writeExclusive(signerEnvironmentPath, envFile([
      ["PROVENANCE_SIGNER_SOCKET_PATH", signerSocketPath],
      ["PROVENANCE_SIGNER_SOCKET_MODE", "0600"],
      ["PROVENANCE_SIGNER_PASSPHRASE_FILE", passphrasePath],
      ["PROVENANCE_SIGNER_SEGMENT_KEY_PATH", createdKeys.segment.privateKeyPath],
      ["PROVENANCE_SIGNER_TOPOLOGY_KEY_PATH", createdKeys.topology.privateKeyPath],
      ["PROVENANCE_SIGNER_CHECKPOINT_KEY_PATH", createdKeys.checkpoint.privateKeyPath],
    ]), 0o600);
  }
  await writeExclusive(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
  passphrase.fill(0);
  return Object.freeze({ product: PRODUCT, installationId, custodyMode, installationDirectory, dataDirectory, manifestPath, ledgerEnvironmentPath, signerEnvironmentPath, signerSocketPath, keyIds: manifest.keys });
}

async function main() {
  const options = await interactiveOptions(parseArguments(process.argv.slice(2)));
  const result = await createInstallation(options);
  process.stdout.write(`${JSON.stringify({ status: "installed", ...result }, null, 2)}\n`);
  process.stdout.write(`\nStart with:\n${result.signerEnvironmentPath === null ? "" : `  npm run start:installed -- signer ${JSON.stringify(result.signerEnvironmentPath)}\n`}  npm run start:installed -- ledger ${JSON.stringify(result.ledgerEnvironmentPath)}\n`);
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) main().catch((error) => { process.stderr.write(`${JSON.stringify({ status: "failed", code: error.code ?? "UNEXPECTED" })}\n`); process.exitCode = 1; });
