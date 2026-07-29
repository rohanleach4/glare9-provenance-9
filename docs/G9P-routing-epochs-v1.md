# G9P Routing Epoch Protocol Version 1

## Status

This document specifies the approved logical routing-epoch protocol and the first executable signed epoch-descriptor container. The reference ledger now implements the single-authority transition lifecycle, while the protocol remains experimental and does not represent production authorization approval.

Routing protocol version 1 is experimental. Compatibility is not promised until the project publishes a stable format policy.

## Purpose

A routing policy determines which ordered shard stream receives a subject's events. Changing that policy without a recorded transition can move a subject silently, split its history and create two locally plausible topologies.

Routing epochs make an intentional topology change explicit, signed and forward-only. They preserve all old segments, close the old streams at known heads and create a verifiable bridge to the new streams.

## File identity and frames

An epoch descriptor is a distinct G9P container using the `.g9p` extension and container-version byte 2:

```text
47 39 50 0d 0a 1a 0a 02
 G  9  P  CR LF SUB LF v2
```

The frame sequence is exact:

```text
RTE1  canonical routing epoch descriptor
SIG1  canonical topology-authority signature
END!  empty payload
end of file
```

Unknown, missing, duplicated, out-of-order and trailing frames are rejected. Frame headers use the same four-byte uppercase type and unsigned 32-bit big-endian payload length as segment container version 1.

## Goals

- Prevent unrecorded changes to shard routing.
- Preserve a subject's verifiable history across a topology change.
- Keep every sealed segment immutable.
- Allow readers to reconstruct the complete topology without trusting mutable service configuration.
- Bind transitions to exact old shard heads and a specific new routing policy.
- Support future checkpoint witnessing and threshold authorization.
- Keep routing semantics deterministic and language-neutral.

## Non-goals

- Rewriting or physically moving historical records.
- Promising global transaction atomicity across data shards.
- Rebalancing subjects dynamically in response to current load.
- Defining the final checkpoint or witness container.
- Defining production-grade operator identity, threshold approval or customer authorization.

## Terms

- **Routing epoch:** a numbered period during which one immutable routing policy applies to new events for a ledger.
- **Epoch descriptor:** the canonical, signed statement that establishes an epoch and links it to the preceding topology.
- **Topology authority:** a key or future threshold policy authorized to approve routing changes.
- **Transition barrier:** the point at which the old epoch stops accepting new events and all of its shard heads are sealed.
- **Epoch-scoped shard:** a stream identified by `(ledgerId, epochNumber, shardId)`.
- **Genesis anchor:** the commitment from a new epoch-scoped shard to its epoch descriptor.

## Core model

Epoch zero is the genesis routing configuration. Every later epoch commits to:

1. The exact descriptor of the preceding epoch.
2. The final sealed head of every shard in that preceding epoch.
3. The complete new deterministic routing policy.
4. The topology authority and signature policy that approved the change.

Historical streams remain unchanged. New events are routed only under the active epoch. A shard identifier such as `shard-0000` is therefore not globally unique by itself; its full identity includes the ledger and routing epoch.

```text
Epoch 0 shard heads
        ↓
Canonical signed epoch-1 descriptor
        ↓
Epoch 1 genesis anchors
        ↓
Epoch 1 shard segments
```

## Epoch descriptor

The version 1 canonical `RTE1` descriptor contains exactly:

```text
kind                    "g9p-routing-epoch"
protocolVersion         1
ledgerId                stable ledger identifier
epochNumber             non-negative integer
createdAt               canonical UTC timestamp
previousEpochHash       null for epoch 0; otherwise 32-byte commitment
previousShardHeads      ordered complete list; empty for epoch 0
routingPolicy           complete new routing policy
topologyAuthority       signing algorithm, key identifier and public key
authorizationPolicy     versioned signature/threshold policy
reason                  bounded operator-supplied transition reason
```

Each entry in `previousShardHeads` contains:

```text
epochNumber             preceding epoch number
shardId                 preceding epoch shard identifier
segmentNumber           final segment number, or null for an empty shard
segmentHash             exact final segment hash, or null for an empty shard
```

The list contains one entry for every shard defined by the preceding epoch and is sorted by shard index. Missing, duplicated or extra heads are invalid. A non-empty shard head commits to the exact sealed `.g9p` bytes, including its signature.

The descriptor commitment is:

```text
SHA256-domain("routing-epoch-v1", canonical-descriptor-payload)
```

The topology-authority signature is defined over:

```text
SHA256-domain("routing-epoch-signature-v1", canonical-descriptor-payload)
```

The canonical `SIG1` payload contains exactly `algorithm`, `keyId` and the 64-byte Ed25519 `signature`. The exact file commitment is `SHA256-domain("routing-epoch-file-v1", every stored byte through END!)`.

An embedded topology-authority key proves only self-consistency. Readers must apply an external trust policy, just as they do for segment producer keys.

## Segment relationship to an epoch

Every segment created under this protocol must authenticate:

- `routingEpochNumber`
- `routingEpochHash`
- The complete routing policy used to validate each event's shard

The first segment of an epoch-scoped shard has segment number zero and no preceding segment in that stream. Its `routingEpochHash` is its genesis anchor. Later segments link normally to the exact hash of the preceding segment in the same epoch-scoped shard.

Experimental segment format version 2 implements this relationship using mandatory epoch fields and distinct `HED2` and `MNF2` frames. See [`G9P-format-v2.md`](./G9P-format-v2.md). Version 1 segments remain verifiable as epoch-zero history under an adopted migration rule and are never rewritten.

## Transition lifecycle

### 1. Plan

An operator proposes the new shard count and policy version. The sharding planner shows subject movement using representative identifiers. Planning does not change ledger state.

### 2. Prepare a barrier

The service durably stops assigning new events to the old epoch. Events arriving during the transition are retained in an accepted queue but are not assigned to either topology yet. The reference service implements this with topology-neutral durable intake and a serialized old-epoch drain barrier.

### 3. Seal and verify old heads

Every active old-epoch segment is closed, synchronised, promoted and verified. The transition process builds the complete ordered `previousShardHeads` list, including explicit empty-shard entries.

### 4. Authorize and publish

The topology authority signs the canonical epoch descriptor. The descriptor is persisted with create-only semantics and independently verified before it becomes active. Before publication, the operation may be abandoned safely. After publication, the change is forward-only.

### 5. Activate new streams

The service creates epoch-scoped shard state from the new descriptor. Retained events are routed exactly once under the new policy. Each new shard's first segment commits to the epoch descriptor.

### 6. Checkpoint and witness

When checkpoints exist, the last old-epoch checkpoint and first new-epoch checkpoint must commit to the transition descriptor. Witnesses attest to the descriptor hash and activation sequence without requiring customer payloads.

## Failure rules

- A transition cannot activate until every old shard has an explicit verified head or empty-shard statement.
- No event may be sealed under both the old and new epochs.
- Failure before descriptor publication leaves the old epoch authoritative and permits a retry.
- Failure after descriptor publication cannot restore the old epoch. Recovery must resume the published epoch.
- An incorrect published policy is corrected by a later signed epoch, never by editing the descriptor.
- Two different validly signed descriptors claiming the same ledger and epoch number are a detectable governance fork and must stop automatic processing.
- A reader must reject gaps, duplicate epoch numbers, broken previous-epoch links and untrusted topology authorities.

## Reader verification

A topology-aware reader verifies in this order:

1. Establish the trusted genesis epoch or an externally trusted later checkpoint.
2. Verify the epoch descriptor signature and authority policy.
3. Verify the previous-epoch descriptor commitment.
4. Verify the complete previous-shard-head set against sealed segment hashes.
5. Verify each new segment's epoch number, descriptor commitment and routing policy.
6. Recompute every event's shard assignment using the policy for its recorded epoch.
7. Follow correlation and causation identifiers across epochs without inferring a total order across shards.

A standalone segment can still prove its bytes, producer signature, logical records and routing under its embedded policy. Proving its place in the complete topology additionally requires the applicable trusted epoch descriptor and preceding topology evidence.

## Storage and container direction

The implemented representation includes the signed, payload-free G9P routing-epoch container, epoch-aware segment format version 2, durable intake and restart-safe transition activation. The local ledger service persists and verifies epoch descriptors and every recorded old-shard head before routing retained events under the active epoch. Create-only adoption descriptors for verified legacy version 1 history require an explicit one-time migration option; missing signed history fails closed by default.

Reference local layout:

```text
ledger-root/
├── routing/<ledger-directory>/
│   ├── epoch-000000000000.g9p
│   └── epoch-000000000001.g9p
└── segments/<ledger-directory>/
    ├── epoch-000000000000/shard-0000/...
    └── epoch-000000000001/shard-0000/...
```

Directory layout is not authoritative. Descriptor and segment commitments establish validity.

## Authorization direction

The first implementation may require one configured topology-authority Ed25519 key, separate from routine segment producer keys. The protocol must leave room for threshold authorization, customer approval and key rotation. Changing the authorization policy is itself a governed transition and must be committed by the prior trusted policy.

## Implementation sequence after approval

1. **Complete:** settle exact epoch-container frames and implement create-only writing.
2. **Complete:** add strict offline verification with explicit topology-authority trust.
3. Add stable canonical valid and invalid cross-language conformance vectors.
4. **Complete:** persist and verify signed epoch-zero routing history while retaining version 1 segment support.
5. **Complete:** implement segment format version 2, epoch-scoped storage and version 1 compatibility.
6. Extend the sharding CLI with transition planning and movement reports.
7. **Complete:** add durable accepted-event intake and the crash-safe transition coordinator and barrier.
8. **Partial:** restart, retry and missing-head tests are implemented; add broader fork and injected mid-transition fault tests.
9. Integrate descriptors with checkpoints and witnesses.

## Approved design decisions

- Adopt a new segment container version for epoch fields instead of revising version 1 in place.
- Represent epoch descriptors as a distinct signed G9P container.
- Scope shard identity by routing epoch and reset segment numbering for each new epoch-scoped shard.
- Require a complete transition barrier rather than allowing old and new policies to accept concurrently.
- Begin with a separate single topology-authority key while preserving a future threshold-policy field.
- Treat current version 1 history as epoch zero under an explicit migration descriptor.

## Current API and verification command

The public core exports `writeRoutingEpoch` and `verifyRoutingEpoch`. Writers require the preceding routing policy for every non-genesis epoch so they cannot sign an incomplete previous-head set. Verifiers can require an expected previous epoch hash, previous routing policy and externally trusted topology-authority key.

Verify an epoch descriptor from the command line using its embedded but otherwise untrusted key:

```bash
npm run verify:epoch -- path/to/epoch-000001.g9p
```

Require a particular trusted topology-authority key identifier:

```bash
npm run verify:epoch -- path/to/epoch-000001.g9p expected-key-id
```
