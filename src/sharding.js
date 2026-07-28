import { domainHash } from "./crypto.js";
import { invariant } from "./errors.js";

export const ROUTING_POLICY_ID = "subject-sha256-v1";

export function createRoutingPolicy(shardCount = 1) {
  invariant(Number.isSafeInteger(shardCount) && shardCount >= 1 && shardCount <= 65_536, "SHARD_COUNT", "shardCount must be between 1 and 65,536");
  return Object.freeze({
    id: ROUTING_POLICY_ID,
    version: 1,
    shardCount,
  });
}

export function routeEvent(event, policy) {
  invariant(policy?.id === ROUTING_POLICY_ID && policy.version === 1, "ROUTING_POLICY", "Unsupported routing policy");
  invariant(Number.isSafeInteger(policy.shardCount) && policy.shardCount >= 1, "SHARD_COUNT", "Routing policy has an invalid shard count");
  invariant(typeof event?.ledgerId === "string" && typeof event?.subject === "string", "SHARD_EVENT", "Event requires ledgerId and subject for routing");

  const digest = domainHash(
    "shard-route-v1",
    Buffer.from(event.ledgerId, "utf8"),
    Buffer.from(event.subject, "utf8"),
  );
  const position = digest.readBigUInt64BE(0) % BigInt(policy.shardCount);
  const index = Number(position);

  return {
    index,
    shardId: `shard-${index.toString().padStart(4, "0")}`,
    policy,
  };
}
