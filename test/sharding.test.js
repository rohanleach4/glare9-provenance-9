import assert from "node:assert/strict";
import test from "node:test";

import { createRoutingPolicy, planShardAssignments, routeEvent } from "../src/index.js";

test("routing is deterministic for a stable ledger and subject", () => {
  const event = { ledgerId: "ledger-a", subject: "model:example" };
  const policy = createRoutingPolicy(16);
  assert.deepEqual(routeEvent(event, policy), routeEvent(event, policy));
});

test("single-shard policy routes every subject to shard-0000", () => {
  const policy = createRoutingPolicy(1);
  assert.equal(routeEvent({ ledgerId: "a", subject: "one" }, policy).shardId, "shard-0000");
  assert.equal(routeEvent({ ledgerId: "b", subject: "two" }, policy).shardId, "shard-0000");
});

test("shard planner reports stable assignments and populated-shard distribution", () => {
  const input = {
    ledgerId: "ledger-a",
    shardCount: 4,
    subjects: ["model:one", "model:two", "model:three"],
  };
  const first = planShardAssignments(input);
  const second = planShardAssignments(input);

  assert.deepEqual(first, second);
  assert.equal(first.subjectCount, 3);
  assert.equal(first.populatedShardCount + first.emptyShardCount, 4);
  assert.equal(first.distribution.reduce((total, shard) => total + shard.subjectCount, 0), 3);
  assert.deepEqual(
    first.assignments.map(({ subject, shardId }) => ({ subject, shardId })),
    input.subjects.map((subject) => ({
      subject,
      shardId: routeEvent({ ledgerId: input.ledgerId, subject }, createRoutingPolicy(4)).shardId,
    })),
  );
});

test("shard planner rejects missing and non-canonical subjects", () => {
  assert.throws(
    () => planShardAssignments({ ledgerId: "ledger-a", shardCount: 2, subjects: [] }),
    { code: "SHARD_PLAN_INPUT" },
  );
  assert.throws(
    () => planShardAssignments({ ledgerId: "ledger-a", shardCount: 2, subjects: ["e\u0301"] }),
    { code: "SHARD_PLAN_INPUT" },
  );
});
