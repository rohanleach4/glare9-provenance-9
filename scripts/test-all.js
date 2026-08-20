import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const suiteDirectories = [
  "test",
  "packages/connector-contract/test",
  "services/ledger/test",
  "services/signer/test",
  "connectors/mysql/test",
];

for (const directory of suiteDirectories) {
  const files = readdirSync(join(process.cwd(), directory))
    .filter((name) => name.endsWith(".test.js"))
    .sort()
    .map((name) => join(directory, name));
  const result = spawnSync(process.execPath, ["--test", ...files], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: process.env,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
