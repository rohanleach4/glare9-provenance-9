import { invariant } from "./errors.js";
import { createRoutingPolicy, routeEvent } from "./sharding.js";

function nonEmptyText(value, name) {
  invariant(typeof value === "string" && value.length > 0, "SHARD_PLAN_INPUT", `${name} must be a non-empty string`);
  invariant(value.normalize("NFC") === value, "SHARD_PLAN_INPUT", `${name} must use Unicode NFC`);
  return value;
}

export function planShardAssignments({ ledgerId, shardCount = 1, subjects }) {
  nonEmptyText(ledgerId, "ledgerId");
  invariant(Array.isArray(subjects) && subjects.length > 0, "SHARD_PLAN_INPUT", "subjects must contain at least one subject");

  const policy = createRoutingPolicy(shardCount);
  const assignments = subjects.map((subject, inputIndex) => {
    nonEmptyText(subject, `subjects[${inputIndex}]`);
    const route = routeEvent({ ledgerId, subject }, policy);
    return {
      inputIndex,
      subject,
      shardIndex: route.index,
      shardId: route.shardId,
    };
  });

  const distributionByShard = new Map();
  for (const assignment of assignments) {
    const existing = distributionByShard.get(assignment.shardId) ?? {
      shardIndex: assignment.shardIndex,
      shardId: assignment.shardId,
      subjectCount: 0,
      subjects: [],
    };
    existing.subjectCount += 1;
    existing.subjects.push(assignment.subject);
    distributionByShard.set(assignment.shardId, existing);
  }

  const distribution = [...distributionByShard.values()]
    .sort((left, right) => left.shardIndex - right.shardIndex);

  return {
    ledgerId,
    policy,
    subjectCount: assignments.length,
    populatedShardCount: distribution.length,
    emptyShardCount: policy.shardCount - distribution.length,
    assignments,
    distribution,
  };
}
