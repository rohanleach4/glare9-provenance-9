import assert from "node:assert/strict";
import test from "node:test";

import { runOperationsQualification } from "../scripts/qualification-operations.js";

test("installed custody profiles pass mutual-TLS and operations qualification", { timeout: 30_000 }, async () => {
  const result = await runOperationsQualification();
  assert.equal(result.passed, true);
  assert.deepEqual(result.profiles.map((profile) => profile.custodyMode), ["integrated", "separated"]);
  for (const profile of result.profiles) {
    assert.equal(profile.tlsVersion, "TLSv1.3");
    assert.equal(profile.mutualTlsClientIdentityEnforced, true);
    assert.equal(profile.metricsAuthenticationEnforced, true);
    assert.equal(profile.sealedIngestionPassed, true);
    assert.equal(profile.checkpointPublicationPassed, true);
  }
});
