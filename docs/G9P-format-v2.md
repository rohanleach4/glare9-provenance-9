# G9P Experimental Segment Format Version 2

## Status

This document specifies the epoch-aware evolution of the experimental Glare•9 Provenance segment container. Format version 2 binds every segment to a signed routing-epoch descriptor without changing any sealed version 1 bytes.

Format version 2 is **experimental**. Compatibility is not promised until the project publishes a stable format policy. Readers must continue to verify version 1 according to [`G9P-format-v1.md`](./G9P-format-v1.md).

## File identity and profile selection

A version 2 container begins with:

```text
47 39 50 0d 0a 1a 0a 02
 G  9  P  CR LF SUB LF v2
```

Container version 2 is shared with routing-epoch descriptors. The first frame selects the strict profile:

```text
HED2  version 2 segment
RTE1  routing-epoch descriptor
```

A version 2 segment has exactly this frame sequence:

```text
HED2
BLK1 (one or more)
MNF2
SIG1
END! (empty payload)
end of file
```

Unknown, missing, duplicated, out-of-order and trailing frames are rejected. Frame headers and canonical value encoding are unchanged from format version 1.

## Header

The canonical `HED2` payload contains exactly:

```text
kind                    "g9p-segment"
formatVersion           2
ledgerId                stable ledger identifier
shardId                 deterministic shard identifier
segmentNumber           position within this epoch-scoped shard
createdAt               canonical UTC timestamp
previousSegmentHash     null for the first segment; otherwise 32 bytes
routingEpochNumber      non-negative routing epoch number
routingEpochHash        exact 32-byte descriptor commitment
routingPolicy           complete policy used to route every record
compression             complete compression profile
```

The epoch fields are mandatory. A verifier must match them to a trusted descriptor and confirm that the embedded routing policy is identical to that descriptor's policy before treating the segment as part of the ledger topology.

## Blocks, records and Merkle commitments

The `BLK1` payload, canonical event envelope, record framing and Zstandard profile are unchanged from version 1. Logical record and Merkle commitments therefore retain these domains:

- `event-record-v1`
- `record-block-v1`
- `merkle-empty-v1`
- `merkle-leaf-v1`
- `merkle-node-v1`
- `shard-route-v1`

Retaining those domains means the same event has the same logical commitment in either segment format. Format version 2 separately authenticates its evolved physical container.

## Manifest and physical commitments

The `MNF2` payload has the same exact fields as `MNF1`, with `manifestVersion` set to `2`. Version 2 uses:

- `header-payload-v2` for the exact `HED2` payload
- `block-payload-v2` for each exact stored `BLK1` payload
- `segment-signature-v2` for the exact `MNF2` payload
- `segment-file-v2` for every stored byte from magic through `END!`

The signature is:

```text
Ed25519.sign(
  SHA256-domain("segment-signature-v2", exact-manifest-payload)
)
```

The embedded producer key establishes cryptographic self-consistency only. External signer trust remains required.

## Epoch-scoped identity and chaining

A version 2 shard stream is identified by `(ledgerId, routingEpochNumber, shardId)`. Segment numbering restarts at zero for each new epoch-scoped shard.

The first segment has a null `previousSegmentHash`; its authenticated `routingEpochHash` is the stream's genesis anchor. Every later segment stores the exact `segment-file-v2` commitment of its predecessor in the same epoch and shard. A chain must never cross an epoch boundary.

## Local storage profile

The reference ledger stores new version 2 segments under:

```text
segments/<ledger-directory>/epoch-000000000000/shard-0000/segment-000000000000.g9p
```

Twelve-digit epoch, shard and segment names are storage conventions, not cryptographic identity. Readers derive authority from verified file contents and routing descriptors.

The reference service may access those names through the storage-neutral contract in `G9P-sealed-storage-v1.md`. The adapter does not change version 2 bytes or become a cryptographic trust root.

Verified legacy version 1 histories remain in their original epoch-zero paths and continue as version 1 streams after explicit routing-history adoption. A later signed epoch uses the epoch-scoped version 2 layout; formats cannot be mixed within one epoch.

## Transition boundary

This format enables independently verifiable epoch-scoped segments. It does not by itself make live resharding safe. The reference service combines it with durable accepted-event intake, a complete old-epoch barrier, verified shard heads, create-only descriptor publication and restart-safe recovery.
