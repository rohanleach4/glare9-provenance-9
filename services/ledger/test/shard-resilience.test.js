import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createRoutingPolicy,
  eventHashHex,
  generateSigner,
  routeEvent,
  verifySegment,
} from "@glare9/provenance";

import { LocalLedger } from "../src/local-ledger.js";

const timestamp = "2026-07-30T12:00:00.000Z";
const ledgerId = "shard-resilience-ledger";

function lifecycle(overrides = {}) {
  return {
    blockMaxBytes: 1024,
    blockMaxRecords: 3,
    segmentMaxBytes: 16 * 1024,
    segmentMaxRecords: 9,
    segmentMaxAgeMs: 60_000,
    maxAcceptedEvents: 1_000,
    maxAcceptedBytes: 16 * 1024 * 1024,
    maxActiveBlockBytes: 1024,
    ...overrides,
  };
}

function evidenceEvent({ eventId, subject, payloadBytes = 64 }) {
  return {
    version: 1,
    eventId,
    ledgerId,
    subject,
    type: "test.shard.resilience",
    schemaVersion: 1,
    occurredAt: timestamp,
    recordedAt: timestamp,
    source: { kind: "semantic", identity: "shard-resilience-test" },
    payload: { evidence: "x".repeat(payloadBytes) },
  };
}

function subjectsByShard(shardCount) {
  const policy = createRoutingPolicy(shardCount);
  const subjects = new Map();
  for (let index = 0; subjects.size < shardCount; index += 1) {
    const subject = `resilience:subject-${index}`;
    const { shardId } = routeEvent({ ledgerId, subject }, policy);
    if (!subjects.has(shardId)) subjects.set(shardId, subject);
  }
  return subjects;
}

async function segmentPaths(directory) {
  const root = join(directory, "segments");
  const entries = await readdir(root, { recursive: true });
  return entries
    .filter((entry) => entry.endsWith(".g9p"))
    .map((entry) => join(root, entry))
    .sort();
}

async function verifyAllSegments(directory, signer, expectedEventIds) {
  const paths = await segmentPaths(directory);
  const verified = await Promise.all(paths.map((path) => verifySegment(path, {
    trustedKeyIds: [signer.keyId],
    requireTrustedSigner: true,
  })));
  const actualEventIds = verified.flatMap((segment) => segment.events.map((event) => event.eventId)).sort();
  assert.deepEqual(actualEventIds, [...expectedEventIds].sort());
  return verified;
}

async function temporaryLedger(run, { shardCount = 4, limits = lifecycle(), testFaultInjector } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "g9p-shard-resilience-"));
  const signer = generateSigner();
  const topologyAuthority = generateSigner();
  const ledger = await new LocalLedger({
    dataDirectory: directory,
    signer,
    topologyAuthority,
    shardCount,
    lifecycle: limits,
    testFaultInjector,
  }).initialize();
  try {
    return await run({ directory, signer, topologyAuthority, ledger, limits });
  } finally {
    await ledger.close({ seal: false });
    await rm(directory, { recursive: true, force: true });
  }
}

test("a hot shard stays bounded while cooler shards progress to provisional and sealed states", async () => {
  const observedActiveBytes = [];
  await temporaryLedger(async ({ directory, signer, ledger, limits }) => {
    const subjects = subjectsByShard(4);
    const shardIds = [...subjects.keys()].sort();
    const hotShardId = shardIds[0];
    const hotSubject = subjects.get(hotShardId);
    const coolShardIds = shardIds.slice(1);
    const scheduled = [];

    for (let round = 0; round < 9; round += 1) {
      scheduled.push(evidenceEvent({ eventId: `hot-${round * 2}`, subject: hotSubject }));
      if (round < 3) {
        for (const shardId of coolShardIds) {
          scheduled.push(evidenceEvent({
            eventId: `cool-${shardId}-${round}`,
            subject: subjects.get(shardId),
          }));
        }
      }
      scheduled.push(evidenceEvent({ eventId: `hot-${round * 2 + 1}`, subject: hotSubject }));
    }

    await Promise.all(scheduled.map((item) => ledger.ingestAcceptedBatch([item])));

    assert.ok(ledger.info().activeBlockBytes <= limits.maxActiveBlockBytes);
    for (const shardId of coolShardIds) {
      const item = scheduled.find((candidate) => candidate.eventId === `cool-${shardId}-0`);
      const receipt = await ledger.receipt(item.eventId, eventHashHex(item));
      assert.notEqual(receipt.status, "accepted", `${shardId} did not progress beyond durable acceptance`);
    }

    await ledger.drainAccepted();
    assert.equal(ledger.info().acceptedEvents, 0);
    assert.equal(ledger.info().activeBlockBytes, 0);
    const verified = await verifyAllSegments(directory, signer, scheduled.map((item) => item.eventId));
    const populatedShards = new Set(verified.map((segment) => segment.shardId));
    assert.deepEqual([...populatedShards].sort(), shardIds);
    assert.ok(verified.filter((segment) => segment.shardId === hotShardId).length >= 2);
    assert.ok(observedActiveBytes.length >= scheduled.length);
    assert.ok(observedActiveBytes.every((bytes) => bytes <= limits.maxActiveBlockBytes));
  }, {
    testFaultInjector(stage, context) {
      if (stage === "active.after-append") observedActiveBytes.push(context.aggregateActiveBlockBytes);
    },
  });
});

test("concurrent durable admission stops exactly at capacity and rejected events succeed after drain", async () => {
  await temporaryLedger(async ({ ledger }) => {
    const subject = subjectsByShard(1).get("shard-0000");
    const events = Array.from({ length: 6 }, (_, index) => evidenceEvent({
      eventId: `capacity-${index}`,
      subject,
    }));
    const results = await Promise.allSettled(events.map((item) => ledger.acceptBatch([item])));
    const accepted = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");

    assert.equal(accepted.length, 3);
    assert.equal(rejected.length, 3);
    assert.ok(rejected.every((result) => result.reason.code === "LEDGER_BACKPRESSURE"));
    assert.equal(ledger.info().acceptedEvents, 3);

    await ledger.drainAccepted();
    assert.equal(ledger.info().acceptedEvents, 0);
    const retryEvents = events.filter((_, index) => results[index].status === "rejected");
    const retries = await Promise.all(retryEvents.map((item) => ledger.ingestAcceptedBatch([item])));
    assert.equal(retries.length, 3);
    await ledger.drainAccepted();
    assert.equal(ledger.info().knownEvents, events.length);
  }, {
    shardCount: 1,
    limits: lifecycle({ maxAcceptedEvents: 3 }),
  });
});

test("restart recovers completed provisional blocks on every shard exactly once", async () => {
  await temporaryLedger(async ({ directory, signer, topologyAuthority, ledger, limits }) => {
    const subjects = subjectsByShard(4);
    const events = [...subjects.entries()].flatMap(([shardId, subject]) => [0, 1, 2].map((index) => evidenceEvent({
      eventId: `recovery-${shardId}-${index}`,
      subject,
    })));
    await Promise.all(events.map((item) => ledger.ingestAcceptedBatch([item])));
    assert.equal((await readdir(join(directory, "provisional"))).length, 4);
    await ledger.close({ seal: false });

    const rebuilt = await new LocalLedger({
      dataDirectory: directory,
      signer,
      topologyAuthority,
      shardCount: 4,
      lifecycle: limits,
    }).initialize();
    try {
      assert.equal(rebuilt.info().knownEvents, events.length);
      assert.equal(rebuilt.info().acceptedEvents, 0);
      assert.equal(rebuilt.info().provisionalEvents, 0);
      assert.deepEqual(await readdir(join(directory, "provisional")), []);
      assert.deepEqual(await readdir(join(directory, "intake")), []);
      await verifyAllSegments(directory, signer, events.map((item) => item.eventId));

      const replayed = await Promise.all(events.map((item) => rebuilt.ingestBatch([item])));
      assert.ok(replayed.every(([receipt]) => receipt.status === "sealed"));
      assert.equal((await segmentPaths(directory)).length, 4);
    } finally {
      await rebuilt.close({ seal: false });
    }
  });
});

test("serialized concurrent calls preserve the routing-transition barrier across active shards", async () => {
  await temporaryLedger(async ({ directory, signer, ledger }) => {
    const oldSubjects = subjectsByShard(2);
    const before = [...oldSubjects.entries()].flatMap(([shardId, subject]) => [0, 1].map((index) => evidenceEvent({
      eventId: `before-${shardId}-${index}`,
      subject,
    })));
    const newSubjects = subjectsByShard(4);
    const after = [...newSubjects.entries()].map(([shardId, subject]) => evidenceEvent({
      eventId: `after-${shardId}`,
      subject,
    }));

    const beforePromises = before.map((item) => ledger.acceptBatch([item]));
    const transitionPromise = ledger.transitionRouting({
      ledgerId,
      shardCount: 4,
      reason: "Exercise the concurrent old-epoch barrier",
      expectedCurrentEpoch: 0,
    });
    const afterPromises = after.map((item) => ledger.ingestAcceptedBatch([item]));
    const [, transition] = await Promise.all([
      Promise.all(beforePromises),
      transitionPromise,
      Promise.all(afterPromises),
    ]);
    await ledger.drainAccepted();

    assert.equal(transition.epochNumber, 1);
    assert.equal(transition.previousShardHeads.length, 2);
    assert.ok(transition.previousShardHeads.every((head) => head.segmentNumber === 0 && head.segmentHash !== null));
    for (const item of before) {
      const [replayed] = await ledger.ingestBatch([item]);
      assert.equal(replayed.routingEpochNumber, 0);
    }
    for (const item of after) {
      const [replayed] = await ledger.ingestBatch([item]);
      assert.equal(replayed.routingEpochNumber, 1);
    }
    const verified = await verifyAllSegments(directory, signer, [...before, ...after].map((item) => item.eventId));
    assert.deepEqual(new Set(verified.map((segment) => segment.routingEpochNumber)), new Set([0, 1]));
  }, { shardCount: 2 });
});
