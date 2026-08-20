import assert from "node:assert/strict";
import test from "node:test";

test("documented package entry points expose bounded supported surfaces", async () => {
  const verify = await import("@glare9/provenance/verify");
  const write = await import("@glare9/provenance/write");
  const custody = await import("@glare9/provenance/custody");
  assert.equal(typeof verify.verifySegmentBytes, "function");
  assert.equal(typeof verify.verifyRoutingEpochBytes, "function");
  assert.equal(Object.hasOwn(verify, "writeSegment"), false);
  assert.equal(typeof write.writeSegment, "function");
  assert.equal(typeof write.writeRoutingEpoch, "function");
  assert.equal(typeof custody.signDomainWithSigner, "function");
  assert.equal(typeof custody.validateSegmentTrustBundle, "function");
});
