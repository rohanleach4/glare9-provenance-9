# G9P shard resilience evidence v1

Status: implementation assurance record. This document does not define permanent G9P bytes or promise parallel mutation inside one service process.

## Purpose

The deterministic suite in `services/ledger/test/shard-resilience.test.js` exercises the interaction between shard routing, bounded active state, restart recovery and signed routing transitions. It answers four failure-oriented questions:

1. Can one dominant subject exceed the active-block memory budget or prevent cooler shards from progressing?
2. Does concurrent durable admission stop exactly at the configured intake ceiling without losing accepted events?
3. Can completed provisional blocks for several shards be recovered exactly once after restart?
4. Does a routing transition place every call queued before its barrier in the old epoch and every later call in the new epoch?

The scenarios use synthetic schema-neutral events and temporary local storage. They do not access MySQL or assume a customer application schema.

## Deterministic scenarios

### Hot shard and cooler-shard progress

The test routes 18 records for one stable subject to a hot shard and three records to each of the other three shards. Calls are submitted concurrently in a deterministic interleaving. The lifecycle uses three-record blocks, nine-record segments and a 1,024-byte aggregate active-block budget.

The assertions prove that:

- aggregate uncompressed active-block memory never remains above the configured bound;
- cooler shards progress beyond durable acceptance while hot-shard traffic continues;
- the hot shard seals multiple finite segments rather than growing one unbounded segment;
- all four shards ultimately seal and every event appears exactly once in independently verified segments.

The service makes room by completing and durably persisting another shard's largest active block. This is bounded memory management, not dynamic rerouting: the hot subject remains on its deterministic shard.

### Concurrent intake back-pressure

Six callers race for an intake capacity of three events. Exactly three calls receive durable acceptance and three receive retryable `LEDGER_BACKPRESSURE`. The accepted count and retained state stop at the configured limit. After those events seal and release intake capacity, every rejected event can be retried and sealed.

Back-pressure therefore does not discard accepted work, create a second identity or require callers to change event content.

### Multi-shard provisional recovery

Each of four shards completes one three-record compressed block without sealing its active segment. The process is closed without finalisation and a new `LocalLedger` instance starts from the same durable intake and provisional directories.

Startup strictly reconciles every block, seals all four shard segments, removes consumed intake and provisional state, and rebuilds twelve sealed receipts. Replaying all twelve events returns the existing receipts and creates no additional segment.

### Concurrent transition barrier

Calls for both old shards are queued, followed by a two-to-four-shard transition and then calls for every new shard. Although independent callers may invoke the API concurrently, ledger mutation is serialized by the reference service.

The transition drains and seals all earlier accepted events, records both old-shard heads, publishes the signed next epoch and only then assigns later events. Verified receipts and segment headers prove that all pre-barrier events remain in epoch 0 and all post-barrier events enter epoch 1.

## Concurrency guarantee

The current JavaScript reference service provides deterministic serialized mutation within one `LocalLedger` instance. Multiple HTTP callers and shard streams may be active concurrently from the callers' perspective, but segment mutation is not performed in parallel. This preserves ordering and simplifies crash recovery; it is not a throughput claim.

Parallel shard writers would be a service-local implementation change only if they preserve intake sequence handling, per-shard order, the aggregate resource limits and the transition barrier. Any such change requires repeating this suite plus fault injection and performance qualification.

## Offline verification

Every segment produced by these scenarios is reopened with the ordinary offline verifier using explicit signer trust. The tests compare the complete verified event-ID set with the submitted set. The service's in-memory indexes are not accepted as evidence of correctness.

## Assurance limits

This deterministic suite does not establish production throughput, operating-system scheduling fairness, distributed-writer coordination, remote object-store recovery, abrupt power-loss behavior or availability objectives. Those require representative performance testing and deployment-specific qualification.

No encoded field, signature input, routing rule or `.g9p` container version changed for this milestone.
