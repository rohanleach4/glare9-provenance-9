import { spawnSync } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const commands = [
  ["test"],
  ["test", "--workspace=@glare9/provenance-connector-contract"],
  ["test", "--workspace=@glare9/provenance-ledger-service"],
  ["test", "--workspace=@glare9/provenance-connector-mysql"],
];

for (const arguments_ of commands) {
  const result = spawnSync(npm, arguments_, {
    cwd: process.cwd(),
    stdio: "inherit",
    env: process.env,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
