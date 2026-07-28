import assert from "node:assert/strict";
import test from "node:test";

import { createRoutingPolicy, routeEvent } from "../src/index.js";

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
