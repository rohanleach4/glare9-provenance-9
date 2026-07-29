import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  loadOrCreateLocalSigner,
  loadOrCreateLocalTopologyAuthority,
} from "../src/key-store.js";

test("local segment and topology keys are separate and stable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "g9p-key-store-"));
  try {
    const segmentSigner = await loadOrCreateLocalSigner(directory);
    const topologyAuthority = await loadOrCreateLocalTopologyAuthority(directory);
    assert.notEqual(segmentSigner.keyId, topologyAuthority.keyId);

    const reloadedSegmentSigner = await loadOrCreateLocalSigner(directory);
    const reloadedTopologyAuthority = await loadOrCreateLocalTopologyAuthority(directory);
    assert.equal(reloadedSegmentSigner.keyId, segmentSigner.keyId);
    assert.equal(reloadedTopologyAuthority.keyId, topologyAuthority.keyId);

    const segmentPrivate = await stat(join(directory, "keys", "segment-signing-key.pk8"));
    const topologyPrivate = await stat(join(directory, "keys", "topology-authority-key.pk8"));
    assert.equal(segmentPrivate.mode & 0o777, 0o600);
    assert.equal(topologyPrivate.mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
