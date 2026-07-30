import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { generateSigner } from "@glare9/provenance";
import {
  ProvenanceClient,
  ProvenanceServiceError,
} from "@glare9/provenance-connector-contract";

import { LocalLedger } from "../src/local-ledger.js";
import { createLedgerServer } from "../src/server.js";

const timestamp = "2026-07-30T09:00:00.000Z";

function event(overrides = {}) {
  return {
    version: 1,
    eventId: "fault-event-001",
    ledgerId: "fault-ledger",
    subject: "model:fault-test",
    type: "test.fault.injected",
    schemaVersion: 1,
    occurredAt: timestamp,
    recordedAt: timestamp,
    source: { kind: "semantic", identity: "fault-test" },
    payload: { purpose: "durability fault injection" },
    ...overrides,
  };
}

function failOnce(expectedStage, predicate = () => true) {
  let injected = false;
  return (stage, context) => {
    if (!injected && stage === expectedStage && predicate(context)) {
      injected = true;
      const error = new Error(`Injected fault at ${stage}`);
      error.code = "TEST_FAULT_INJECTED";
      throw error;
    }
  };
}

async function temporaryLedger(run, { testFaultInjector } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "g9p-fault-injection-"));
  const signer = generateSigner();
  const topologyAuthority = generateSigner();
  try {
    const ledger = await new LocalLedger({
      dataDirectory: directory,
      signer,
      topologyAuthority,
      testFaultInjector,
    }).initialize();
    return await run({ directory, signer, topologyAuthority, ledger });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function rebuildAndAssertExactlyOnce({ directory, signer, topologyAuthority, expectedEvent = event() }) {
  const rebuilt = await new LocalLedger({ dataDirectory: directory, signer, topologyAuthority }).initialize();
  assert.equal(rebuilt.info().knownEvents, 1);
  assert.equal(rebuilt.info().acceptedEvents, 0);
  const [first] = await rebuilt.ingestBatch([expectedEvent]);
  const [second] = await rebuilt.ingestBatch([expectedEvent]);
  assert.equal(first.status, "sealed");
  assert.equal(first.segmentNumber, 0);
  assert.deepEqual(second, first);
  assert.deepEqual(await readdir(join(directory, "intake")), []);
  return { rebuilt, receipt: first };
}

async function segmentArtifacts(directory) {
  const root = join(directory, "segments");
  const entries = await readdir(root, { recursive: true });
  const sealedRelative = entries.filter((name) => name.endsWith(".g9p"));
  const partRelative = entries.filter((name) => name.endsWith(".g9p.part"));
  return {
    sealed: sealedRelative.map((name) => join(root, name)),
    parts: partRelative.map((name) => join(root, name)),
  };
}

async function assertInterruptedSegmentState(directory, { sealed, part, linked = false }) {
  const artifacts = await segmentArtifacts(directory);
  assert.equal(artifacts.sealed.length, sealed, "unexpected sealed segment count at interruption");
  assert.equal(artifacts.parts.length, part, "unexpected provisional segment count at interruption");
  if (linked) {
    assert.deepEqual(await readFile(artifacts.sealed[0]), await readFile(artifacts.parts[0]));
    assert.equal((await stat(artifacts.sealed[0])).ino, (await stat(artifacts.parts[0])).ino);
  }
}

test("fault after intake append is recovered without loss or duplication", async () => {
  await temporaryLedger(async ({ directory, signer, topologyAuthority, ledger }) => {
    await assert.rejects(
      ledger.acceptBatch([event()]),
      (error) => error.code === "INTAKE_WRITE",
    );
    await rebuildAndAssertExactlyOnce({ directory, signer, topologyAuthority });
  }, { testFaultInjector: failOnce("intake.after-write") });
});

for (const boundary of [
  { stage: "segment.before-compression", sealed: 0, part: 0 },
  { stage: "segment.after-compression", sealed: 0, part: 0 },
  { stage: "sealed.after-open", sealed: 0, part: 1 },
  { stage: "sealed.after-write", sealed: 0, part: 1 },
  { stage: "sealed.after-file-sync", sealed: 0, part: 1 },
  { stage: "sealed.before-promotion", sealed: 0, part: 1 },
  { stage: "sealed.after-promotion", sealed: 1, part: 1, linked: true },
  { stage: "sealed.after-directory-sync", sealed: 1, part: 1, linked: true },
  { stage: "sealed.after-part-removal", sealed: 1, part: 0 },
  { stage: "sealed.after-cleanup-sync", sealed: 1, part: 0 },
]) {
  test(`fault at ${boundary.stage} recovers retained intake exactly once`, async () => {
    const onlySegmentFiles = (context) => context.outputPath?.includes("/segments/") ?? true;
    await temporaryLedger(async ({ directory, signer, topologyAuthority, ledger }) => {
      await ledger.acceptBatch([event()]);
      await assert.rejects(
        ledger.drainAccepted(),
        (error) => new Set(["SEGMENT_WRITE", "TEST_FAULT_INJECTED"]).has(error.code),
      );
      await assertInterruptedSegmentState(directory, boundary);
      await rebuildAndAssertExactlyOnce({ directory, signer, topologyAuthority });
      await assertInterruptedSegmentState(directory, { sealed: 1, part: 0 });
    }, { testFaultInjector: failOnce(boundary.stage, onlySegmentFiles) });
  });
}

for (const stage of [
  "active-state.after-file-sync",
  "active-state.after-promotion",
  "active-state.after-directory-sync",
]) {
  test(`fault at ${stage} recovers the completed provisional block exactly once`, async () => {
    await temporaryLedger(async ({ directory, signer, topologyAuthority, ledger }) => {
      await ledger.acceptBatch([event()]);
      await assert.rejects(
        ledger.drainAccepted(),
        (error) => error.code === "ACTIVE_STATE_WRITE",
      );
      await rebuildAndAssertExactlyOnce({ directory, signer, topologyAuthority });
    }, { testFaultInjector: failOnce(stage) });
  });
}

test("lost acknowledgement is retryable and does not create a second segment", async () => {
  await temporaryLedger(async ({ directory, ledger }) => {
    const service = createLedgerServer({
      ledger,
      apiToken: "fault-test-api-token",
      testFaultInjector: failOnce("service.before-acknowledgement"),
      logger: { error() {} },
    });
    const address = await service.listen({ host: "127.0.0.1", port: 0 });
    const client = new ProvenanceClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "fault-test-api-token",
    });
    try {
      await assert.rejects(
        client.submitBatch([event()]),
        (error) => error instanceof ProvenanceServiceError
          && error.status === 500
          && error.retryable === true,
      );
      const [receipt] = await client.submitBatch([event()]);
      assert.equal(receipt.status, "sealed");
      assert.equal(receipt.segmentNumber, 0);
      const segmentRoot = join(directory, "segments");
      const entries = await readdir(segmentRoot, { recursive: true });
      assert.equal(entries.filter((name) => name.endsWith(".g9p")).length, 1);
    } finally {
      await service.close();
    }
  });
});

test("lost accepted-first acknowledgement retains one intake record and returns stable receipt state", async () => {
  await temporaryLedger(async ({ directory, ledger }) => {
    const service = createLedgerServer({
      ledger,
      apiToken: "fault-test-api-token",
      testFaultInjector: failOnce("service.before-acknowledgement"),
      logger: { error() {} },
    });
    const address = await service.listen({ host: "127.0.0.1", port: 0 });
    const client = new ProvenanceClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "fault-test-api-token",
    });
    try {
      await assert.rejects(
        client.submitAcceptedBatch([event()]),
        (error) => error instanceof ProvenanceServiceError
          && error.status === 500
          && error.retryable === true,
      );
      const [receipt] = await client.submitAcceptedBatch([event()]);
      assert.equal(receipt.status, "accepted");
      assert.equal(ledger.info().acceptedEvents, 1);
      assert.equal((await readdir(join(directory, "intake"))).length, 1);
      assert.deepEqual(await client.getReceipt(event().eventId, receipt.recordHash), receipt);
      await ledger.drainAccepted();
      assert.equal((await client.getReceipt(event().eventId, receipt.recordHash)).status, "sealed");
    } finally {
      await service.close();
    }
  });
});

test("fault after transition publication activates the signed epoch on restart", async () => {
  const transitionFile = (context) => context.outputPath?.includes("/routing/")
    && context.outputPath.endsWith("epoch-000000000001.g9p");
  await temporaryLedger(async ({ directory, signer, topologyAuthority, ledger }) => {
    await ledger.ingestBatch([event()]);
    await assert.rejects(
      ledger.transitionRouting({
        ledgerId: "fault-ledger",
        shardCount: 2,
        reason: "Inject a failure after signed epoch publication",
        expectedCurrentEpoch: 0,
      }),
      (error) => error.code === "EPOCH_WRITE",
    );

    const rebuilt = await new LocalLedger({ dataDirectory: directory, signer, topologyAuthority }).initialize();
    const nextEvent = event({ eventId: "fault-event-epoch-one", subject: "model:epoch-one" });
    const [receipt] = await rebuilt.ingestBatch([nextEvent]);
    assert.equal(receipt.routingEpochNumber, 1);
    const retry = await rebuilt.transitionRouting({
      ledgerId: "fault-ledger",
      shardCount: 2,
      reason: "Retry after uncertain transition response",
      expectedCurrentEpoch: 0,
    });
    assert.equal(retry.alreadyActive, true);
  }, { testFaultInjector: failOnce("sealed.after-promotion", transitionFile) });
});

test("fault before transition publication leaves the old epoch authoritative", async () => {
  const transitionFile = (context) => context.outputPath?.includes("/routing/")
    && context.outputPath.endsWith("epoch-000000000001.g9p");
  await temporaryLedger(async ({ directory, signer, topologyAuthority, ledger }) => {
    await ledger.ingestBatch([event()]);
    await assert.rejects(
      ledger.transitionRouting({
        ledgerId: "fault-ledger",
        shardCount: 2,
        reason: "Inject a failure before signed epoch publication",
        expectedCurrentEpoch: 0,
      }),
      (error) => error.code === "EPOCH_WRITE",
    );

    const rebuilt = await new LocalLedger({ dataDirectory: directory, signer, topologyAuthority }).initialize();
    const retained = event({ eventId: "fault-event-still-epoch-zero", subject: "model:still-zero" });
    const [oldReceipt] = await rebuilt.ingestBatch([retained]);
    assert.equal(oldReceipt.routingEpochNumber, 0);
    const transition = await rebuilt.transitionRouting({
      ledgerId: "fault-ledger",
      shardCount: 2,
      reason: "Retry safely after pre-publication failure",
      expectedCurrentEpoch: 0,
    });
    assert.equal(transition.epochNumber, 1);
    assert.equal(transition.alreadyActive, false);
  }, { testFaultInjector: failOnce("sealed.before-promotion", transitionFile) });
});
