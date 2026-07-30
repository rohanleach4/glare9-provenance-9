import assert from "node:assert/strict";
import test from "node:test";

import { evaluateSegmentTrust, generateSigner, requireTrustedSegmentSigner, segmentTrustKeyIds, validateSegmentTrustBundle } from "../src/index.js";

function binding(keyId, firstSegmentNumber, lastSegmentNumber, status = "trusted") {
  return { ledgerId: "rotation-ledger", epochNumber: 0, shardId: "shard-0000", firstSegmentNumber, lastSegmentNumber, keyId, status };
}

test("segment trust bundle assigns historical and successor keys to exact positions", () => {
  const oldSigner = generateSigner();
  const newSigner = generateSigner();
  const bundle = validateSegmentTrustBundle({ kind: "g9p-segment-trust-bundle", version: 1, bundleId: "rotation-ledger-2026-07-30", bindings: [binding(oldSigner.keyId, 0, 0), binding(newSigner.keyId, 1, null)] });
  assert.equal(segmentTrustKeyIds(bundle).size, 2);
  assert.equal(evaluateSegmentTrust(bundle, { ledgerId: "rotation-ledger", epochNumber: 0, shardId: "shard-0000", segmentNumber: 0, keyId: oldSigner.keyId }).status, "trusted");
  assert.equal(evaluateSegmentTrust(bundle, { ledgerId: "rotation-ledger", epochNumber: 0, shardId: "shard-0000", segmentNumber: 1, keyId: newSigner.keyId }).status, "trusted");
  assert.equal(evaluateSegmentTrust(bundle, { ledgerId: "rotation-ledger", epochNumber: 0, shardId: "shard-0000", segmentNumber: 1, keyId: oldSigner.keyId }).status, "untrusted");
  assert.equal(requireTrustedSegmentSigner(bundle, { ledgerId: "rotation-ledger", epochNumber: 0, shardId: "shard-0000", segmentNumber: 1, keyId: newSigner.keyId }).status, "trusted");
});

test("segment trust bundle rejects overlapping ranges and reports revoked positions", () => {
  const first = generateSigner();
  const second = generateSigner();
  assert.throws(() => validateSegmentTrustBundle({ kind: "g9p-segment-trust-bundle", version: 1, bundleId: "overlap", bindings: [binding(first.keyId, 0, 2), binding(second.keyId, 2, null)] }), (error) => error.code === "TRUST_BINDING_OVERLAP");
  const revoked = validateSegmentTrustBundle({ kind: "g9p-segment-trust-bundle", version: 1, bundleId: "revoked", bindings: [binding(first.keyId, 0, null, "revoked")] });
  assert.equal(evaluateSegmentTrust(revoked, { ledgerId: "rotation-ledger", epochNumber: 0, shardId: "shard-0000", segmentNumber: 4, keyId: first.keyId }).status, "revoked");
  assert.throws(() => requireTrustedSegmentSigner(revoked, { ledgerId: "rotation-ledger", epochNumber: 0, shardId: "shard-0000", segmentNumber: 4, keyId: first.keyId }), (error) => error.code === "SEGMENT_SIGNER_TRUST");
  assert.equal(evaluateSegmentTrust(revoked, { ledgerId: "other-ledger", epochNumber: 0, shardId: "shard-0000", segmentNumber: 0, keyId: first.keyId }).status, "indeterminate");
});
