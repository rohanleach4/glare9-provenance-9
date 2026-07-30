import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DurableIntake } from "../src/durable-intake.js";

test("recovery emits a redacted warning when invalid intake provisional bytes are discarded", async () => {
  const directory = await mkdtemp(join(tmpdir(), "g9p-intake-warning-"));
  const warnings = [];
  try {
    const name = `intake-000000000000-${"0".repeat(64)}.intake.part`;
    await writeFile(join(directory, name), Buffer.from("corrupt provisional bytes"));
    const intake = new DurableIntake(directory, { onRecoveryWarning: (warning) => warnings.push(warning) });
    assert.deepEqual(await intake.initialize(), []);
    assert.deepEqual(warnings, [{ code: "INTAKE_PART_DISCARDED", action: "discarded-invalid-provisional-intake" }]);
    assert.deepEqual(await readdir(directory), []);
    assert.equal(JSON.stringify(warnings).includes("corrupt"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
