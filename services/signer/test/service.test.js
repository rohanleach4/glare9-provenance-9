import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { generateSigner, signDomainWithSigner } from "@glare9/provenance";
import { loadSocketSigner, requestSigner } from "../../ledger/src/socket-signer.js";
import { createSignerServer } from "../src/server.js";

async function temporary(run) {
  const directory = await mkdtemp(join(tmpdir(), "g9p-signer-service-"));
  try { return await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test("self-hosted signer exposes pinned identities and signs G9P commitments", async () => {
  await temporary(async (directory) => {
    const signers = { segment: generateSigner(), topology: generateSigner(), checkpoint: generateSigner() };
    const audits = [];
    const socketPath = join(directory, "signer.sock");
    const server = createSignerServer({ socketPath, signers, audit: (record) => audits.push(record) });
    await server.listen();
    try {
      for (const role of Object.keys(signers)) {
        const remote = await loadSocketSigner(socketPath, role);
        assert.equal(remote.keyId, signers[role].keyId);
        const signature = await signDomainWithSigner(remote, "signer-service-test-v1", Buffer.from(role));
        assert.equal(signature.byteLength, 64);
      }
      assert.equal(audits.filter((record) => record.operation === "identity").length, 3);
      assert.equal(audits.filter((record) => record.operation === "sign").length, 3);
      assert.equal(audits.every((record) => Object.keys(record).sort().join(",") === "keyId,operation,role,status"), true);
    } finally { await server.close(); }
  });
});

test("self-hosted signer rejects malformed and unknown-role requests without details", async () => {
  await temporary(async (directory) => {
    const signers = { segment: generateSigner(), topology: generateSigner(), checkpoint: generateSigner() };
    const socketPath = join(directory, "signer.sock");
    const server = createSignerServer({ socketPath, signers });
    await server.listen();
    try {
      await assert.rejects(requestSigner(socketPath, { kind: "g9p-signer-request", version: 1, operation: "identity", role: "unknown" }), (error) => error.code === "SIGNER_REQUEST");
      await assert.rejects(requestSigner(socketPath, { kind: "g9p-signer-request", version: 1, operation: "sign", role: "segment", message: "not-base64" }), (error) => error.code === "SIGNER_MESSAGE");
    } finally { await server.close(); }
  });
});
