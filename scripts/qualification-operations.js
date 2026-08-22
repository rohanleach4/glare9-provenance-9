import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { LocalLedger } from "../services/ledger/src/local-ledger.js";
import { createLedgerServer } from "../services/ledger/src/server.js";
import { configuredRoles } from "./qualification-pilot.js";
import { createInstallation } from "./setup.js";

function runOpenSsl(args) {
  try {
    execFileSync("openssl", args, { stdio: "ignore" });
  } catch (cause) {
    const error = new Error("OpenSSL is required for the disposable mutual-TLS qualification");
    error.code = "QUALIFICATION_OPENSSL";
    error.cause = cause;
    throw error;
  }
}

async function createTlsFixture(directory) {
  const caKey = join(directory, "ca.key");
  const caCert = join(directory, "ca.pem");
  const serverKey = join(directory, "server.key");
  const serverCsr = join(directory, "server.csr");
  const serverCert = join(directory, "server.pem");
  const clientKey = join(directory, "client.key");
  const clientCsr = join(directory, "client.csr");
  const clientCert = join(directory, "client.pem");
  const extensions = join(directory, "extensions.cnf");
  await writeFile(extensions, [
    "[server_ext]",
    "basicConstraints=critical,CA:FALSE",
    "keyUsage=critical,digitalSignature,keyEncipherment",
    "extendedKeyUsage=serverAuth",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
    "[client_ext]",
    "basicConstraints=critical,CA:FALSE",
    "keyUsage=critical,digitalSignature",
    "extendedKeyUsage=clientAuth",
    "",
  ].join("\n"), { mode: 0o600 });
  runOpenSsl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1", "-subj", "/CN=Glare9 Qualification CA", "-keyout", caKey, "-out", caCert]);
  runOpenSsl(["req", "-newkey", "rsa:2048", "-nodes", "-sha256", "-subj", "/CN=localhost", "-keyout", serverKey, "-out", serverCsr]);
  runOpenSsl(["x509", "-req", "-sha256", "-days", "1", "-in", serverCsr, "-CA", caCert, "-CAkey", caKey, "-CAcreateserial", "-extfile", extensions, "-extensions", "server_ext", "-out", serverCert]);
  runOpenSsl(["req", "-newkey", "rsa:2048", "-nodes", "-sha256", "-subj", "/CN=Glare9 Qualification Client", "-keyout", clientKey, "-out", clientCsr]);
  runOpenSsl(["x509", "-req", "-sha256", "-days", "1", "-in", clientCsr, "-CA", caCert, "-CAkey", caKey, "-CAcreateserial", "-extfile", extensions, "-extensions", "client_ext", "-out", clientCert]);
  return {
    ca: await readFile(caCert),
    serverCert: await readFile(serverCert),
    serverKey: await readFile(serverKey),
    clientCert: await readFile(clientCert),
    clientKey: await readFile(clientKey),
  };
}

function callService({ port, tls, path, method = "GET", token, body, includeClientCertificate = true }) {
  return new Promise((resolveResponse, reject) => {
    const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body), "utf8");
    const client = request({
      hostname: "127.0.0.1",
      port,
      path,
      method,
      ca: tls.ca,
      ...(includeClientCertificate ? { cert: tls.clientCert, key: tls.clientKey } : {}),
      minVersion: "TLSv1.3",
      rejectUnauthorized: true,
      headers: {
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...(bytes === null ? {} : { "content-type": "application/json", "content-length": bytes.length }),
      },
    }, (response) => {
      const chunks = [];
      const tlsVersion = response.socket.getProtocol();
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolveResponse({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString("utf8"),
        tlsVersion,
      }));
    });
    client.once("error", reject);
    if (bytes !== null) client.write(bytes);
    client.end();
  });
}

function qualificationEvent(custodyMode) {
  const time = "2026-08-22T12:00:00.000Z";
  return {
    version: 1,
    eventId: `operations-${custodyMode}`,
    ledgerId: `operations-${custodyMode}`,
    subject: `installation:${custodyMode}`,
    type: "g9p.operations.qualified",
    schemaVersion: 1,
    occurredAt: time,
    recordedAt: time,
    source: { kind: "semantic", identity: "glare9:operations-qualification" },
    payload: { custodyMode, exercise: "mtls-readiness-metrics-ingestion-checkpoint" },
  };
}

async function exerciseProfile(root, tls, custodyMode) {
  const installation = await createInstallation({
    custody: custodyMode,
    install_dir: join(root, custodyMode),
    ...(custodyMode === "separated" ? { signer_socket: join(root, "signer.sock") } : {}),
  });
  const { config, signers, server: signerServer } = await configuredRoles(installation);
  let ledger;
  let service;
  try {
    ledger = await new LocalLedger({
      dataDirectory: installation.dataDirectory,
      signer: signers.segment,
      topologyAuthority: signers.topology,
      checkpointPublisher: signers.checkpoint,
      lifecycle: config.lifecycle,
    }).initialize();
    service = createLedgerServer({
      ledger,
      apiTokens: config.apiTokens,
      adminTokens: config.adminTokens,
      tls: {
        cert: tls.serverCert,
        key: tls.serverKey,
        ca: tls.ca,
        requestCert: true,
        rejectUnauthorized: true,
        minVersion: "TLSv1.3",
      },
    });
    const address = await service.listen({ host: "127.0.0.1", port: 0 });
    const rejectedWithoutClientIdentity = await callService({ port: address.port, tls, path: "/health", includeClientCertificate: false }).then(() => false, () => true);
    const health = await callService({ port: address.port, tls, path: "/health" });
    const ready = await callService({ port: address.port, tls, path: "/ready" });
    const unauthorisedMetrics = await callService({ port: address.port, tls, path: "/metrics" });
    const metrics = await callService({ port: address.port, tls, path: "/metrics", token: config.apiTokens[0] });
    const ingestion = await callService({
      port: address.port,
      tls,
      path: "/v1/events:batch",
      method: "POST",
      token: config.apiTokens[0],
      body: { contractVersion: 1, events: [qualificationEvent(custodyMode)] },
    });
    const checkpoint = await callService({
      port: address.port,
      tls,
      path: "/v1/admin/checkpoints",
      method: "POST",
      token: config.adminTokens[0],
      body: { contractVersion: 1, ledgerId: `operations-${custodyMode}` },
    });
    const ingestionBody = JSON.parse(ingestion.body);
    const checkpointBody = JSON.parse(checkpoint.body);
    const passed = rejectedWithoutClientIdentity
      && health.status === 200
      && ready.status === 200
      && unauthorisedMetrics.status === 401
      && metrics.status === 200
      && metrics.body.includes("g9p_ledger_ready 1")
      && ingestion.status === 200
      && ingestionBody.receipts?.[0]?.status === "sealed"
      && checkpoint.status === 200
      && typeof checkpointBody.checkpoint?.checkpointHash === "string"
      && health.tlsVersion === "TLSv1.3";
    return {
      custodyMode,
      installedManifestValidated: true,
      mutualTlsClientIdentityEnforced: rejectedWithoutClientIdentity,
      tlsVersion: health.tlsVersion,
      livenessPassed: health.status === 200,
      readinessPassed: ready.status === 200,
      metricsAuthenticationEnforced: unauthorisedMetrics.status === 401 && metrics.status === 200,
      sealedIngestionPassed: ingestion.status === 200 && ingestionBody.receipts?.[0]?.status === "sealed",
      checkpointPublicationPassed: checkpoint.status === 200 && typeof checkpointBody.checkpoint?.checkpointHash === "string",
      passed,
    };
  } finally {
    await service?.close();
    await ledger?.close({ seal: false });
    await signerServer?.close();
  }
}

export async function runOperationsQualification() {
  const root = await mkdtemp(join(tmpdir(), "g9p-operations-qualification-"));
  try {
    const tls = await createTlsFixture(root);
    const profiles = [];
    for (const custodyMode of ["integrated", "separated"]) profiles.push(await exerciseProfile(root, tls, custodyMode));
    return {
      kind: "g9p-non-production-operations-qualification",
      version: 1,
      product: "Glare•9 Provenance",
      executedAt: new Date().toISOString(),
      profiles,
      passed: profiles.every((profile) => profile.passed),
      limitations: [
        "Uses a disposable local certificate authority and does not approve a deployment identity",
        "Does not qualify MySQL, host power-loss behavior, service-manager policy or external monitoring retention",
        "Does not constitute operator approval or an incident-response decision",
      ],
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function main() {
  const report = await runOperationsQualification();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ status: "failed", code: error.code ?? "UNEXPECTED" })}\n`);
    process.exitCode = 1;
  });
}
