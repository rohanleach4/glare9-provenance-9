import { createPrivateKey, createPublicKey } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { publicKeyId, validateSegmentTrustBundle } from "../src/index.js";

function exact(value, fields, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || !actual.every((field, index) => field === expected[index])) throw new Error(`${name} fields are invalid`);
}

export function validateFindingsRegister(value) {
  exact(value, ["kind", "version", "updatedAt", "findings"], "findings register");
  if (value.kind !== "g9p-security-findings-register" || value.version !== 1 || new Date(value.updatedAt).toISOString() !== value.updatedAt || !Array.isArray(value.findings)) throw new Error("findings register header is invalid");
  const ids = new Set();
  for (const [index, finding] of value.findings.entries()) {
    exact(finding, ["id", "severity", "status", "title", "source", "openedAt", "resolvedAt"], `findings[${index}]`);
    if (typeof finding.id !== "string" || ids.has(finding.id) || !["critical", "high", "medium", "low"].includes(finding.severity)
      || !["open", "resolved", "accepted"].includes(finding.status) || typeof finding.title !== "string" || typeof finding.source !== "string"
      || new Date(finding.openedAt).toISOString() !== finding.openedAt
      || (finding.resolvedAt !== null && new Date(finding.resolvedAt).toISOString() !== finding.resolvedAt)
      || (finding.status === "open") !== (finding.resolvedAt === null)) throw new Error(`findings[${index}] is invalid`);
    ids.add(finding.id);
  }
  return value;
}

async function assessSigner(environment) {
  const keyPath = environment.PROVENANCE_SEGMENT_SIGNING_KEY_PATH;
  const bundlePath = environment.PROVENANCE_SEGMENT_TRUST_BUNDLE_PATH;
  if (keyPath === undefined && bundlePath === undefined) return { configured: false, valid: false, reason: "not-configured" };
  if (keyPath === undefined || bundlePath === undefined) return { configured: true, valid: false, reason: "incomplete-configuration" };
  try {
    const privateKey = createPrivateKey({ key: await readFile(resolve(keyPath)), format: "der", type: "pkcs8" });
    const publicKeyDer = Buffer.from(createPublicKey(privateKey).export({ format: "der", type: "spki" }));
    const keyId = publicKeyId(publicKeyDer);
    const bundle = validateSegmentTrustBundle(JSON.parse(await readFile(resolve(bundlePath), "utf8")));
    const trustedBindings = bundle.bindings.filter((binding) => binding.keyId === keyId && binding.status === "trusted").length;
    return { configured: true, valid: trustedBindings > 0, reason: trustedBindings > 0 ? null : "key-not-trusted", keyId, bundleId: bundle.bundleId, trustedBindings };
  } catch {
    return { configured: true, valid: false, reason: "invalid-key-or-bundle" };
  }
}

export async function assessTechnicalQualification({ environment = process.env, findingsRegister, commit, clean }) {
  const register = validateFindingsRegister(findingsRegister);
  const open = register.findings.filter((finding) => finding.status === "open");
  const critical = open.filter((finding) => finding.severity === "critical").length;
  const high = open.filter((finding) => finding.severity === "high").length;
  const signer = await assessSigner(environment);
  const mysql = {
    integrationConfigured: typeof environment.MYSQL_INTEGRATION_URL === "string" && environment.MYSQL_INTEGRATION_URL.length > 0,
    qualificationConfigured: typeof environment.MYSQL_QUALIFICATION_URL === "string" && environment.MYSQL_QUALIFICATION_URL.length > 0,
  };
  const security = { registerUpdatedAt: register.updatedAt, openFindings: open.length, openCritical: critical, openHigh: high, noKnownCriticalOrHigh: critical === 0 && high === 0 };
  return {
    kind: "g9p-technical-qualification-preflight",
    version: 1,
    commit,
    clean,
    signer,
    mysql,
    security,
    readyForLiveExercises: clean && signer.valid && mysql.integrationConfigured && mysql.qualificationConfigured && security.noKnownCriticalOrHigh,
    approvalsRecorded: false,
  };
}

async function main() {
  const findingsRegister = JSON.parse(await readFile(resolve("qualification/security-findings.json"), "utf8"));
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const clean = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim() === "";
  const report = await assessTechnicalQualification({ findingsRegister, commit, clean });
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (process.argv[2] === undefined) process.stdout.write(output);
  else await writeFile(resolve(process.argv[2]), output, { flag: "wx" });
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ status: "failed", code: error.code ?? "QUALIFICATION_ERROR" })}\n`);
    process.exitCode = 1;
  });
}
