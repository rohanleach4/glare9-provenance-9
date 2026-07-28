# Glare•9 Provenance — Sharding

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

## Shard routing

Routing must be deterministic and versioned. Candidate routing keys include:

- Tenant or organisation identifier
- Subject identifier
- Governance domain
- Geographic or regulatory boundary
- A stable hash of a composite identity

The selected routing policy must prevent one subject's ordered history from moving between shards without an explicit transition record.

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

## Initial sizing assumptions

The following are measurement starting points, not protocol constants:

- Uncompressed block target: 1–4 MiB
- Final segment target: 16–64 MiB
- Segment age limit: configurable by assurance and throughput needs
- Independent compression per block for random access and bounded recovery

All limits belong in deployment policy or a signed ledger configuration record, not hard-coded into the permanent format.

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
