import { readFile } from "node:fs/promises";

import { loadLedgerConfig } from "./config.js";
import { validateInstallationManifest } from "./installation-manifest.js";
import { loadExternalSigner, loadOrCreateLocalCheckpointPublisher, loadOrCreateLocalSigner, loadOrCreateLocalTopologyAuthority, loadProtectedSigner } from "./key-store.js";
import { LocalLedger } from "./local-ledger.js";
import { createLedgerServer } from "./server.js";
import { loadSocketSigner } from "./socket-signer.js";
import { acquireWriterLock } from "./writer-lock.js";

async function loadSigningRoles(config) {
  if (config.custodyMode === "integrated") {
    const [segment, topology, checkpoint] = await Promise.all([
      loadProtectedSigner(config.segmentSigningKeyPath, config.keyPassphrasePath),
      loadProtectedSigner(config.topologySigningKeyPath, config.keyPassphrasePath),
      loadProtectedSigner(config.checkpointSigningKeyPath, config.keyPassphrasePath),
    ]);
    return { segment, topology, checkpoint };
  }
  if (config.custodyMode === "separated") {
    const options = { timeoutMs: config.signerTimeoutMs };
    const [segment, topology, checkpoint] = await Promise.all([
      loadSocketSigner(config.signerSocketPath, "segment", options),
      loadSocketSigner(config.signerSocketPath, "topology", options),
      loadSocketSigner(config.signerSocketPath, "checkpoint", options),
    ]);
    return { segment, topology, checkpoint };
  }
  const [segment, topology, checkpoint] = await Promise.all([
    config.segmentSigningKeyPath === undefined ? loadOrCreateLocalSigner(config.dataDirectory) : loadExternalSigner(config.segmentSigningKeyPath),
    loadOrCreateLocalTopologyAuthority(config.dataDirectory),
    loadOrCreateLocalCheckpointPublisher(config.dataDirectory),
  ]);
  return { segment, topology, checkpoint };
}

async function main() {
  const config = loadLedgerConfig();
  const writerLock = await acquireWriterLock(config.dataDirectory);
  let ledger;
  let service;
  try {
    const signingRoles = await loadSigningRoles(config);
    const signer = signingRoles.segment;
    const topologyAuthority = signingRoles.topology;
    const checkpointPublisher = signingRoles.checkpoint;
    const installation = config.installationManifestPath === undefined ? null : validateInstallationManifest(
      JSON.parse(await readFile(config.installationManifestPath, "utf8")),
      { config, signers: signingRoles },
    );
    const segmentTrustBundle = config.segmentTrustBundlePath === undefined
      ? undefined
      : JSON.parse(await readFile(config.segmentTrustBundlePath, "utf8"));
    ledger = await new LocalLedger({
      dataDirectory: config.dataDirectory,
      signer,
      topologyAuthority,
      checkpointPublisher,
      segmentTrustBundle,
      shardCount: config.shardCount,
      adoptLegacyRoutingHistory: config.adoptLegacyRoutingHistory,
      lifecycle: config.lifecycle,
      onRecoveryWarning: (warning) => console.warn(JSON.stringify({ service: "glare9-provenance-ledger", status: "recovery-warning", ...warning })),
    }).initialize();
    const tls = config.tls === undefined ? undefined : {
      cert: await readFile(config.tls.certPath),
      key: await readFile(config.tls.keyPath),
      ...(config.tls.caPath === undefined ? {} : { ca: await readFile(config.tls.caPath) }),
      requestCert: config.tls.requireClientCertificate,
      rejectUnauthorized: config.tls.requireClientCertificate,
      minVersion: "TLSv1.3",
    };
    service = createLedgerServer({
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
      checkpointPublisherKeyId: checkpointPublisher.keyId,
      installationId: installation?.installationId ?? null,
      custodyMode: config.custodyMode,
    }));

    const stop = async (signal) => {
      console.log(JSON.stringify({ service: "glare9-provenance-ledger", status: "stopping", signal }));
      await service.close();
      await ledger.close({ seal: true });
      await writerLock.release();
    };
    process.once("SIGINT", () => stop("SIGINT").then(() => process.exit(0)));
    process.once("SIGTERM", () => stop("SIGTERM").then(() => process.exit(0)));
  } catch (error) {
    await service?.close().catch(() => {});
    await ledger?.close({ seal: false }).catch(() => {});
    await writerLock.release().catch(() => {});
    throw error;
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ service: "glare9-provenance-ledger", status: "failed", code: error.code ?? "UNEXPECTED" }));
  process.exitCode = 1;
});
