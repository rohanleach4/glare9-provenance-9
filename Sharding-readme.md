# Glare•9 Provenance: Sharding

## Purpose

Sharding allows the ledger to scale without requiring every reader or writer to process the complete history. A shard is a continuous, ordered logical stream. It is not a single file and is not expected to end.

Each shard produces finite `.g9p` segments:

```text
Shard A
├── Segment 000001.g9p   sealed
├── Segment 000002.g9p   sealed
└── Segment 000003.g9p.part   active and provisional
```

## Helicopter instructions

These are the plain-language, helicopter-level answers established in the **Document Ledger Sharding Guide**. The wording has been aligned with the current architecture, in which a shard is a continuing logical stream and a segment is the finite `.g9p` file that is filled and sealed.

### 1. What is sharding?

Sharding divides a large ledger into smaller, manageable streams called **shards**. Each shard contains a defined group of ledger records—such as records for a particular organisation, governance domain or stable range of subjects—while remaining part of the complete ledger. Each shard is stored as a sequence of finite `.g9p` segments.

### 2. Why do we shard our new ledger system?

We shard the ledger so it can grow without becoming slow or difficult to manage. Sharding allows records to be stored, searched, verified and processed in smaller groups while preserving a unified view of the complete governance history.

### 3. How do we preserve immutability?

Each ledger record is cryptographically hashed and committed in order. Every completed segment is sealed with verifiable commitments, linked to the preceding segment in its shard and incorporated into signed checkpoints. Any later alteration, removal or replacement would break these links and become detectable.

### 4. What happens to the shards?

Each shard continues to receive records through an active segment. When that segment reaches a defined boundary, such as a size or time limit, it is sealed, verified and retained in protected storage as a permanent part of the shard. New records are written to the shard's next segment, while sealed segments remain available for auditing and verification.

## When to shard

Start with one shard when the expected ledger volume, verification time and operational load fit comfortably within one ordered stream. A single shard is easier to operate and avoids unnecessary cross-shard coordination.

Consider multiple shards when measured growth shows that one stream would create unacceptable ingestion contention, sealing latency, recovery time, verification time or storage-management overhead. Sharding may also be appropriate when stable organisational, geographic or regulatory boundaries need separate operational streams.

Do not shard merely because the operational database is sharded, and do not use shard count as a substitute for segment sizing. Segments already keep files finite and independently verifiable. Choose an initial shard count from representative measurements and expected growth, because changing the routing policy after history exists requires an explicit forward-only routing-epoch transition.

## Shard routing

Routing must be deterministic and versioned. Candidate routing keys include:

- Tenant or organisation identifier
- Subject identifier
- Governance domain
- Geographic or regulatory boundary
- A stable hash of a composite identity

The selected routing policy must prevent one subject's ordered history from moving between shards without an explicit transition record.

## How sharding is done in the current iteration

The current routing policy is `subject-sha256-v1`. It hashes the ledger identifier and stable subject identifier with the G9P `shard-route-v1` domain, reads the first unsigned 64 bits of that commitment and applies modulo `shardCount`. The result is formatted as `shard-0000`, `shard-0001` and so on.

This means:

- The same ledger, subject and routing policy always produce the same shard.
- Different ledgers may route the same subject text differently.
- Event arrival time and current system load do not affect routing.
- Changing the shard count changes assignments and is therefore a topology change, not a routine configuration edit.

The ledger ingestion service applies this routing automatically. For a new ledger with no history, configure its initial count through `PROVENANCE_SHARD_COUNT`. An existing epoch-zero-only ledger must match that configured policy. Later changes must use the separately authenticated signed transition coordinator; editing configuration cannot rewrite topology history.

### Shard-planning command

Use the command-line planner to preview assignments before choosing the initial shard count:

```bash
npm run shard -- <ledger-id> <shard-count> <subject> [subject ...]
```

For example:

```bash
npm run shard -- governance-ledger 4 model:alpha model:beta policy:credit
```

The command returns JSON containing the versioned routing policy, each subject's assigned shard and a distribution summary for populated shards. It uses the same reusable routing code as the ledger service, so the planning result matches ingestion when the ledger identifier, subject and policy are identical.

The planner is read-only. It does not create segments, move records, edit service configuration or reshard existing history. Its reusable `planShardAssignments` API is intended to support a later administrative interface.

## Segment lifecycle

1. Accept and validate an event.
2. Assign its shard and monotonically increasing shard position.
3. Canonically encode and hash the event.
4. Append it to the active block.
5. Compress and close blocks independently.
6. Close the segment when its size or age threshold is reached.
7. Construct the record Merkle root and physical block commitments.
8. Sign and synchronise the completed segment.
9. Atomically promote `.g9p.part` to `.g9p`.
10. Publish the new shard head for checkpoint witnessing.

The reference service now implements this lifecycle with one bounded active block per active epoch-scoped shard and a global active-block memory budget. Completed blocks are compressed, retained in service-local provisional state and reconciled with durable intake on restart. Segment byte, record-count and age limits are deployment policy; reaching any segment limit forces sealing. A routing transition force-seals all old-epoch active state before recording the complete previous-head set.

Final segment and routing-epoch publication is accessed through the sealed-storage contract. The bundled local adapter retains the create-only `.g9p.part` sequence above; another adapter must provide equivalent atomic create-only publication and exact-byte reads. Verification accepts independently retrieved bytes and does not treat the storage backend as a trust root. See [`docs/G9P-sealed-storage-v1.md`](./docs/G9P-sealed-storage-v1.md).

## Initial sizing assumptions

The following are measured reference defaults, not protocol constants:

- Uncompressed block target: 1–4 MiB
- Final segment target: 16–64 MiB
- Segment age limit: configurable by assurance and throughput needs
- Independent compression per block for random access and bounded recovery

All limits belong in deployment policy or a signed ledger configuration record, not hard-coded into the permanent format.

The current defaults are 1 MiB of uncompressed canonical framed records or 1,000 records per block, 32 MiB of the same logical bytes or 10,000 records per segment, and a 30-second segment age. Stored compressed sizes vary. The selection and reproducible benchmark are recorded in [`docs/G9P-lifecycle-sizing-v1.md`](./docs/G9P-lifecycle-sizing-v1.md). Deployments should rerun the benchmark with representative evidence before raising limits.

Representative subject-distribution measurements and the reproducible `npm run benchmark:shards` command are recorded in [`docs/G9P-shard-benchmark-v1.md`](./docs/G9P-shard-benchmark-v1.md). They demonstrate that increasing shard count distributes unique subjects but cannot split one dominant subject.

## Global checkpoints

A global checkpoint should commit to:

- The previous global checkpoint
- The current head of every participating shard
- The shard-map and routing-policy versions
- The checkpoint epoch
- Membership and signature-policy versions
- Required witness attestations

Timestamps alone must not be used to establish a total order across shards.

## Cross-shard activity

Cross-shard operations must use explicit correlation and causation identifiers. The design must choose between:

- Asynchronous linked events with compensation
- Recorded prepare/commit coordination
- A dedicated coordination stream issuing a shared transaction certificate

Strict global atomicity will not be promised unless the chosen protocol can demonstrate it under failure.

## Resharding

Resharding is a forward-only topology change:

```text
Old shard head
    ↓
Signed split/merge transition
    ↓
New shard genesis commitments
```

Historical segments remain in their original shards. Readers use the recorded topology history to follow a subject across epochs.

The routing-epoch protocol closes every old epoch shard at a verified head, publishes a canonical signed epoch descriptor, and starts new epoch-scoped shard streams anchored to that descriptor. Events are never moved or rewritten. The reference service implements this barrier using topology-neutral durable intake, a separately authenticated coordinator and restart-safe descriptor activation. New ledgers write epoch-aware version 2 segments; adopted version 1 epoch-zero histories remain unchanged and later epochs use version 2.

See [`docs/G9P-routing-epochs-v1.md`](./docs/G9P-routing-epochs-v1.md) for the transition lifecycle and [`docs/G9P-format-v2.md`](./docs/G9P-format-v2.md) for the epoch-aware segment profile.
