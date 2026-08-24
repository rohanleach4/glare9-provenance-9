import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { publicKeyId } from "../src/index.js";
import { createInstallation } from "../scripts/setup.js";
import { assessTechnicalQualification, validateFindingsRegister } from "../scripts/technical-qualification.js";

const emptyRegister = { kind: "g9p-security-findings-register", version: 1, updatedAt: "2026-07-30T00:00:00.000Z", findings: [] };

function parseEnvironment(text) {
  return Object.fromEntries(text.trim().split("\n").map((line) => {
    const separator = line.indexOf("=");
    return [line.slice(0, separator), JSON.parse(line.slice(separator + 1))];
  }));
}

test("technical qualification preflight is redacted and incomplete without live configuration", async () => {
  const report = await assessTechnicalQualification({ environment: {}, findingsRegister: emptyRegister, commit: "a".repeat(40), clean: true });
  assert.equal(report.security.noKnownCriticalOrHigh, true);
  assert.equal(report.signer.configured, false);
  assert.equal(report.mysql.integrationConfigured, false);
  assert.equal(report.readyForLiveExercises, false);
  assert.equal(report.deploymentDecisionRecorded, false);
  assert.equal(Object.hasOwn(report, "approvalsRecorded"), false);
  assert.equal(JSON.stringify(report).includes("URL"), false);
});

test("technical qualification verifies an installed integrated custody manifest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "g9p-installed-qualification-"));
  try {
    const installation = await createInstallation({ custody: "integrated", install_dir: join(directory, "installation") });
    const environment = { ...parseEnvironment(await readFile(installation.ledgerEnvironmentPath, "utf8")), MYSQL_INTEGRATION_URL: "secret-admin-url", MYSQL_QUALIFICATION_URL: "secret-restricted-url" };
    const report = await assessTechnicalQualification({ environment, findingsRegister: emptyRegister, commit: "d".repeat(40), clean: true });
    assert.equal(report.signer.valid, true);
    assert.equal(report.signer.custodyMode, "integrated");
    assert.equal(report.signer.installationId, installation.installationId);
    assert.deepEqual(Object.keys(report.signer.keyIds).sort(), ["checkpoint", "segment", "topology"]);
    assert.equal(report.readyForLiveExercises, true);
    assert.equal(JSON.stringify(report).includes("secret"), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("technical qualification recognizes a customer-controlled signer and configured live exercises", async () => {
  const directory = await mkdtemp(join(tmpdir(), "g9p-qualification-"));
  try {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const privateKeyPath = join(directory, "signer.pk8");
    const bundlePath = join(directory, "trust.json");
    const keyId = publicKeyId(Buffer.from(publicKey.export({ format: "der", type: "spki" })));
    await writeFile(privateKeyPath, privateKey.export({ format: "der", type: "pkcs8" }));
    await writeFile(bundlePath, JSON.stringify({ kind: "g9p-segment-trust-bundle", version: 1, bundleId: "qualification", bindings: [{ ledgerId: "qualification-ledger", epochNumber: 0, shardId: "shard-0000", firstSegmentNumber: 0, lastSegmentNumber: null, keyId, status: "trusted" }] }));
    const report = await assessTechnicalQualification({ environment: { PROVENANCE_SEGMENT_SIGNING_KEY_PATH: privateKeyPath, PROVENANCE_SEGMENT_TRUST_BUNDLE_PATH: bundlePath, MYSQL_INTEGRATION_URL: "secret-admin-url", MYSQL_QUALIFICATION_URL: "secret-restricted-url" }, findingsRegister: emptyRegister, commit: "b".repeat(40), clean: true });
    assert.equal(report.signer.valid, true);
    assert.equal(report.readyForLiveExercises, true);
    assert.equal(JSON.stringify(report).includes("secret"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("findings register prevents a zero-high finding claim when a high issue is open", async () => {
  const register = { ...emptyRegister, findings: [{ id: "G9P-SEC-1", severity: "high", status: "open", title: "Example", source: "review", openedAt: "2026-07-30T00:00:00.000Z", resolvedAt: null }] };
  validateFindingsRegister(register);
  const report = await assessTechnicalQualification({ environment: {}, findingsRegister: register, commit: "c".repeat(40), clean: true });
  assert.equal(report.security.noKnownCriticalOrHigh, false);
  assert.equal(report.readyForLiveExercises, false);
});
