import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const tracked = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);

const forbiddenNames = [
  /(^|\/)Global-readme\.md$/u,
  /(^|\/)\.env$/u,
  /(^|\/)node_modules\//u,
  /\.g9p(?:\.part)?$/u,
  /(?:^|\/)(?:id_ed25519|private[-_.]?key)(?:$|\.)/iu,
];

const forbiddenContent = [
  { name: "private key PEM", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u },
  { name: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/u },
  { name: "GitHub token", pattern: /\bgh[opsu]_[A-Za-z0-9]{30,}\b/u },
  { name: "assigned bearer token", pattern: /(?:PROVENANCE_(?:API|ADMIN)_TOKEN|CONNECTOR_PROVENANCE_TOKEN)\s*=\s*(?!change-me|replace-(?:me|with)|example|$)[^\s#]+/u },
];

const failures = [];
for (const path of tracked) {
  for (const pattern of forbiddenNames) {
    if (pattern.test(path)) failures.push(`${path}: forbidden tracked path`);
  }
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    continue;
  }
  for (const rule of forbiddenContent) {
    if (rule.pattern.test(text)) failures.push(`${path}: possible ${rule.name}`);
  }
}

const javascript = tracked.filter((path) => path.endsWith(".js"));
for (const path of javascript) {
  try {
    execFileSync(process.execPath, ["--check", path], { stdio: "pipe" });
  } catch (error) {
    failures.push(`${path}: JavaScript syntax check failed\n${error.stderr?.toString() ?? ""}`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Security repository scan passed for ${tracked.length} tracked files and ${javascript.length} JavaScript files.\n`);
}
