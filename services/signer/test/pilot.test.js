import assert from "node:assert/strict";
import test from "node:test";

import { runPilotQualification } from "../../../scripts/qualification-pilot.js";

test("reference pilot exercises both custody profiles through failure, backup and restore", async () => {
  const report = await runPilotQualification();
  assert.equal(report.passed, true);
  assert.deepEqual(report.profiles.map((profile) => profile.custodyMode), ["integrated", "separated"]);
  for (const profile of report.profiles) {
    assert.equal(profile.installationCreated, true);
    assert.equal(profile.interruptionRecovered, true);
    assert.equal(profile.exactByteBackupRestored, true);
    assert.equal(profile.offlineVerificationPassed, true);
  }
});
