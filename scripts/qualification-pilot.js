import { createHash } from "node:crypto";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { LocalFilesystemSealedStorage, verifyRoutingEpochBytes, verifySegmentBytes } from "@glare9/provenance";
import { loadLedgerConfig } from "../services/ledger/src/config.js";
import { validateInstallationManifest } from "../services/ledger/src/installation-manifest.js";
import { loadProtectedSigner } from "../services/ledger/src/key-store.js";
import { LocalLedger } from "../services/ledger/src/local-ledger.js";
import { loadSocketSigner } from "../services/ledger/src/socket-signer.js";
import { loadSignerConfig } from "../services/signer/src/config.js";
import { loadCustodySigner, readProtectedPassphrase } from "../services/signer/src/key-store.js";
import { createSignerServer } from "../services/signer/src/server.js";
import { createInstallation } from "./setup.js";

function parseEnvironment(text) {
  return Object.fromEntries(text.trim().split("\n").map((line) => {
    const separator = line.indexOf("=");
    return [line.slice(0, separator), JSON.parse(line.slice(separator + 1))];
  }));
}

function qualificationEvent(custodyMode) {
  const time = "2026-08-20T12:00:00.000Z";
  return { version: 1, eventId: `pilot-${custodyMode}`, ledgerId: `pilot-${custodyMode}`, subject: `installation:${custodyMode}`, type: "g9p.qualification.recorded", schemaVersion: 1, occurredAt: time, recordedAt: time, source: { kind: "semantic", identity: "glare9:pilot-qualification" }, payload: { custodyMode, exercise: "failure-backup-restore" } };
}

function failOnce(stageName) {
  let failed = false;
  return (stage, context) => {
    if (!failed && stage === stageName && (context?.storageKey?.startsWith("segments/") || context?.outputPath?.includes("/segments/"))) {
      failed = true;
      const error = new Error("Injected qualification interruption");
      error.code = "TEST_FAULT_INJECTED";
      throw error;
    }
  };
}

export async function configuredRoles(result) {
  const ledgerEnvironment = parseEnvironment(await readFile(result.ledgerEnvironmentPath, "utf8"));
  const config = loadLedgerConfig(ledgerEnvironment);
  let server = null;
  let signers;
  if (result.custodyMode === "integrated") {
    signers = {
      segment: await loadProtectedSigner(config.segmentSigningKeyPath, config.keyPassphrasePath),
      topology: await loadProtectedSigner(config.topologySigningKeyPath, config.keyPassphrasePath),
      checkpoint: await loadProtectedSigner(config.checkpointSigningKeyPath, config.keyPassphrasePath),
    };
  } else {
    const signerEnvironment = parseEnvironment(await readFile(result.signerEnvironmentPath, "utf8"));
    const signerConfig = loadSignerConfig(signerEnvironment);
    const passphrase = await readProtectedPassphrase(signerConfig.passphrasePath);
    const local = Object.fromEntries(await Promise.all(Object.entries(signerConfig.keyPaths).map(async ([role, path]) => [role, await loadCustodySigner(path, passphrase)])));
    passphrase.fill(0);
    server = createSignerServer({ socketPath: signerConfig.socketPath, socketMode: signerConfig.socketMode, signers: local });
    await server.listen();
    signers = Object.fromEntries(await Promise.all(["segment", "topology", "checkpoint"].map(async (role) => [role, await loadSocketSigner(config.signerSocketPath, role)])));
  }
  const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
  validateInstallationManifest(manifest, { config, signers });
  return { config, signers, server };
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function copySealedHistory(sourceDirectory, targetDirectory) {
  const source = new LocalFilesystemSealedStorage(sourceDirectory);
  const target = new LocalFilesystemSealedStorage(targetDirectory);
  await source.initialize();
  await target.initialize();
  const keys = [];
  for (const prefix of ["routing/", "segments/", "checkpoints/"]) keys.push(...await source.list(prefix));
  const hashes = {};
  for (const key of keys.sort()) {
    const bytes = await source.read(key);
    await target.publish(key, bytes);
    hashes[key] = digest(bytes);
  }
  return hashes;
}

async function exerciseMode(root, custodyMode) {
  const installation = await createInstallation({ custody: custodyMode, install_dir: join(root, custodyMode), ...(custodyMode === "separated" ? { signer_socket: join(root, "signer.sock") } : {}) });
  const { signers, server } = await configuredRoles(installation);
  const event = qualificationEvent(custodyMode);
  try {
    let ledger = await new LocalLedger({ dataDirectory: installation.dataDirectory, signer: signers.segment, topologyAuthority: signers.topology, checkpointPublisher: signers.checkpoint, testFaultInjector: failOnce("sealed.after-file-sync") }).initialize();
    await ledger.acceptBatch([event]);
    await ledger.drainAccepted().then(() => { throw new Error("Qualification fault was not injected"); }, (error) => { if (!new Set(["SEGMENT_WRITE", "TEST_FAULT_INJECTED"]).has(error.code)) throw error; });
    await ledger.close({ seal: false });

    ledger = await new LocalLedger({ dataDirectory: installation.dataDirectory, signer: signers.segment, topologyAuthority: signers.topology, checkpointPublisher: signers.checkpoint }).initialize();
    const [receipt] = await ledger.ingestBatch([event]);
    if (receipt.status !== "sealed") throw new Error("Recovered pilot event did not seal");
    await ledger.close({ seal: false });

    const backupDirectory = join(root, `${custodyMode}-backup`);
    const restoredDirectory = join(root, `${custodyMode}-restored`);
    const backupHashes = await copySealedHistory(installation.dataDirectory, backupDirectory);
    const restoredHashes = await copySealedHistory(backupDirectory, restoredDirectory);
    if (JSON.stringify(backupHashes) !== JSON.stringify(restoredHashes)) throw new Error("Restored sealed bytes do not match backup bytes");

    const restored = await new LocalLedger({ dataDirectory: restoredDirectory, signer: signers.segment, topologyAuthority: signers.topology, checkpointPublisher: signers.checkpoint }).initialize();
    const [replayed] = await restored.ingestBatch([event]);
    await restored.close({ seal: false });
    if (replayed.segmentHash !== receipt.segmentHash) throw new Error("Restored receipt does not match original sealed history");

    const storage = new LocalFilesystemSealedStorage(restoredDirectory);
    await storage.initialize();
    for (const key of await storage.list("segments/")) await verifySegmentBytes(await storage.read(key), { trustedKeyIds: [signers.segment.keyId], requireTrustedSigner: true });
    for (const key of await storage.list("routing/")) await verifyRoutingEpochBytes(await storage.read(key), { trustedKeyIds: [signers.topology.keyId], requireTrustedAuthority: true });
    return { custodyMode, installationCreated: true, interruptionRecovered: true, exactByteBackupRestored: true, offlineVerificationPassed: true, signerKeyIds: Object.fromEntries(Object.entries(signers).map(([role, signer]) => [role, signer.keyId])), sealedObjectCount: Object.keys(restoredHashes).length };
  } finally { await server?.close(); }
}

export async function runPilotQualification() {
  const root = await mkdtemp(join(tmpdir(), "g9p-pilot-qualification-"));
  try {
    const profiles = [];
    for (const custodyMode of ["integrated", "separated"]) profiles.push(await exerciseMode(root, custodyMode));
    return { kind: "g9p-non-production-pilot", version: 1, product: "Provenance•9", executedAt: new Date().toISOString(), profiles, passed: profiles.every((profile) => profile.installationCreated && profile.interruptionRecovered && profile.exactByteBackupRestored && profile.offlineVerificationPassed), limitations: ["Does not qualify MySQL or TLS", "Does not replace deployment-specific power-loss testing", "Does not constitute operator approval"] };
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function main() {
  const report = await runPilotQualification();
  const outputPath = process.argv[2];
  if (outputPath !== undefined) {
    const handle = await open(resolve(outputPath), "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) main().catch((error) => { process.stderr.write(`${JSON.stringify({ status: "failed", code: error.code ?? "UNEXPECTED" })}\n`); process.exitCode = 1; });
