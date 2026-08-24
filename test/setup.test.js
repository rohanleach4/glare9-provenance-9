import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createInstallation } from "../scripts/setup.js";
import { loadLedgerConfig } from "../services/ledger/src/config.js";
import { validateInstallationManifest } from "../services/ledger/src/installation-manifest.js";
import { loadProtectedSigner } from "../services/ledger/src/key-store.js";

function parseEnvironment(text) {
  return Object.fromEntries(text.trim().split("\n").map((line) => {
    const separator = line.indexOf("=");
    return [line.slice(0, separator), JSON.parse(line.slice(separator + 1))];
  }));
}

async function temporary(run) {
  const directory = await mkdtemp(join(tmpdir(), "g9p-setup-test-"));
  try { return await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test("integrated setup creates encrypted keys, protected configuration and a pinned manifest", async () => {
  await temporary(async (directory) => {
    const result = await createInstallation({ custody: "integrated", install_dir: join(directory, "installation") });
    const environment = parseEnvironment(await readFile(result.ledgerEnvironmentPath, "utf8"));
    const config = loadLedgerConfig(environment);
    const signers = {
      segment: await loadProtectedSigner(config.segmentSigningKeyPath, config.keyPassphrasePath),
      topology: await loadProtectedSigner(config.topologySigningKeyPath, config.keyPassphrasePath),
      checkpoint: await loadProtectedSigner(config.checkpointSigningKeyPath, config.keyPassphrasePath),
    };
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    assert.equal(manifest.product, "Provenance•9");
    assert.deepEqual(validateInstallationManifest(manifest, { config, signers }), { installationId: result.installationId, custodyMode: "integrated" });
    assert.deepEqual(validateInstallationManifest({ ...manifest, product: "Glare•9 Provenance" }, { config, signers }), { installationId: result.installationId, custodyMode: "integrated" });
    assert.equal((await readFile(config.segmentSigningKeyPath, "utf8")).startsWith("-----BEGIN ENCRYPTED PRIVATE KEY-----"), true);
    for (const path of [result.manifestPath, result.ledgerEnvironmentPath, config.keyPassphrasePath, config.segmentSigningKeyPath, config.topologySigningKeyPath, config.checkpointSigningKeyPath]) {
      if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o077, 0);
    }
    assert.equal(environment.PROVENANCE_CUSTODY_MODE, "integrated");
    assert.equal(environment.PROVENANCE_API_TOKEN.length, 64);
    await assert.rejects(createInstallation({ custody: "integrated", install_dir: result.installationDirectory }), (error) => error.code === "SETUP_EXISTS");
  });
});

test("installation manifest rejects custody and signer identity drift", async () => {
  await temporary(async (directory) => {
    const result = await createInstallation({ custody: "integrated", install_dir: join(directory, "installation") });
    const environment = parseEnvironment(await readFile(result.ledgerEnvironmentPath, "utf8"));
    const config = loadLedgerConfig(environment);
    const signers = {
      segment: await loadProtectedSigner(config.segmentSigningKeyPath, config.keyPassphrasePath),
      topology: await loadProtectedSigner(config.topologySigningKeyPath, config.keyPassphrasePath),
      checkpoint: await loadProtectedSigner(config.checkpointSigningKeyPath, config.keyPassphrasePath),
    };
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    assert.throws(() => validateInstallationManifest({ ...manifest, custodyMode: "separated" }, { config, signers }), (error) => error.code === "INSTALLATION_CUSTODY");
    assert.throws(() => validateInstallationManifest({ ...manifest, keys: { ...manifest.keys, segment: { algorithm: "ed25519", keyId: "0".repeat(64) } } }, { config, signers }), (error) => error.code === "INSTALLATION_KEY_ID");
  });
});
