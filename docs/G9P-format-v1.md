# G9P Experimental Format Version 1

## Status

This document specifies the first executable Glare•9 Provenance container. It exists to make the prototype independently inspectable and testable.

Format version 1 is **experimental**. Compatibility is not promised until the project publishes a stable format policy. Any permanent byte-level change must update this document, the verifier and the conformance fixtures together.

## Goals

The first format demonstrates:

- Deterministic event bytes
- Domain-separated cryptographic commitments
- Deterministic shard routing
- Independently compressed record blocks
- Logical record and physical block commitments
- Hash-linked segments
- Ed25519 segment signatures
- Strict offline parsing and verification
- Detection of mutation, truncation and chain-link mismatch

## File identity

A version 1 file begins with eight bytes:

```text
47 39 50 0d 0a 1a 0a 01
 G  9  P  CR LF SUB LF v1
```

The final byte identifies container version 1. A `.g9p` extension alone does not identify or validate a file.

## Frame encoding

After the magic bytes, the file contains ordered frames:

```text
4 bytes   uppercase ASCII frame type
4 bytes   unsigned big-endian payload length
N bytes   frame payload
```

The required order is:

```text
HEAD
BLK1 (one or more)
MNF1
SIG1
END! (empty payload)
end of file
```

Unknown, missing, duplicated out-of-order or trailing frames are rejected in version 1.

## Canonical value encoding

Structured frame payloads and ledger records use the G9P deterministic value encoding.

| Tag | Type | Representation |
|---:|---|---|
| `00` | null | tag only |
| `01` | false | tag only |
| `02` | true | tag only |
| `10` | safe integer | ZigZag integer as minimal unsigned LEB128 |
| `11` | non-integral finite number | IEEE-754 binary64, big-endian |
| `20` | string | byte length as minimal unsigned LEB128, then UTF-8 |
| `30` | bytes | byte length as minimal unsigned LEB128, then bytes |
| `40` | array | item count as minimal unsigned LEB128, then values |
| `50` | map | entry count, then string keys and values |

Map keys are sorted by their raw UTF-8 bytes and must be unique. Invalid UTF-8, non-minimal integers, unsafe integers, non-finite numbers, trailing bytes and non-canonical map order are rejected.

Event validation additionally requires Unicode NFC text. It rejects unknown version 1 envelope fields rather than assigning them accidental semantics.

## Domain-separated SHA-256

Commitments use SHA-256 with length-delimited domain separation:

```text
SHA256(
  uint64be(length("G9P\\0" + domain)) ||
  utf8("G9P\\0" + domain) ||
  uint64be(length(part-1)) || part-1 ||
  ...
)
```

Version 1 uses these domains:

- `event-record-v1`
- `record-block-v1`
- `header-payload-v1`
- `block-payload-v1`
- `merkle-empty-v1`
- `merkle-leaf-v1`
- `merkle-node-v1`
- `public-key-id-v1`
- `segment-signature-v1`
- `segment-file-v1`
- `shard-route-v1`

## Event envelope

Version 1 records contain a strict event object with:

- `version`
- `eventId`
- `ledgerId`
- `subject`
- `type`
- `schemaVersion`
- `occurredAt`
- `recordedAt`
- `source`
- At least one of `payload` or `payloadHash`

Optional fields are:

- `previousStateHash`
- `resultingStateHash`
- `correlationId`
- `causationId`
- `policyReference`
- `metadata`

Version 1 source kinds are `semantic`, `outbox`, `cdc`, `webhook` and `batch`.

## Record blocks

Within an uncompressed block, every record is framed as:

```text
4 bytes   unsigned big-endian canonical-record length
N bytes   canonical event bytes
```

The complete framed-record stream is hashed using `record-block-v1`, then compressed with the `g9p-zstd-v1` profile:

- Zstandard compression level 3
- Content size enabled
- Zstandard frame checksum enabled
- Dictionary identifier disabled
- Worker count zero

Each `BLK1` canonical payload contains:

- `blockIndex`
- `firstRecordIndex`
- `recordCount`
- `uncompressedLength`
- `compression`
- `recordsHash`
- `data`

Blocks are compressed independently. The declared output size is checked before decompression and an implementation must impose resource limits.

## Header

The `HEAD` canonical payload contains:

- Container kind and format version
- Ledger and shard identifiers
- Segment number and creation time
- Previous exact segment hash, or null for a genesis segment
- Versioned routing policy
- Compression profile

The manifest commits to the exact header payload using `header-payload-v1`.

## Merkle root

Each canonical event is first hashed with `event-record-v1`. Merkle leaves hash those record hashes with `merkle-leaf-v1`. Parent nodes use `merkle-node-v1`.

When a level contains an unpaired final node, that node is promoted unchanged to the next level. A one-record tree therefore has its leaf commitment as its root. The empty-root definition exists but version 1 segments require at least one record.

## Manifest

The `MNF1` canonical payload contains:

- Manifest kind and version
- Exact header-payload commitment
- Total record and block counts
- Record Merkle root
- Ordered block commitments
- Ed25519 signer algorithm, key identifier and SPKI DER public key

Each block commitment includes its position, record range and a `block-payload-v1` hash of the exact stored `BLK1` payload.

## Signature and trust

The signature is:

```text
Ed25519.sign(
  SHA256-domain("segment-signature-v1", exact-manifest-payload)
)
```

The `SIG1` canonical payload contains the algorithm, key identifier and 64-byte signature.

The embedded public key proves cryptographic self-consistency. It does **not** establish that the signer is trusted. A verifier must compare the key identifier against an external trust policy before reporting a trusted signer.

## Segment identity and chaining

The exact segment hash is:

```text
SHA256-domain("segment-file-v1", every stored byte from magic through END!)
```

The next segment stores this 32-byte value as `previousSegmentHash`. This commits the chain to the exact compressed representation and signature, while the Merkle root separately commits to the logical event history.

## Provisional and sealed files

Writers create an exclusive `.g9p.part` file, synchronise its complete contents and promote it without overwriting an existing `.g9p` file. Only the final `.g9p` name represents a sealed segment.

The prototype uses an atomic hard-link promotion on the local filesystem. A future storage abstraction must preserve the same create-only finalisation property on other storage systems.

## Known version 1 prototype boundaries

- The writer currently batches events in memory before writing the segment.
- The local writer is not yet a long-running ingestion service.
- Routing supports a fixed hash policy and a configured shard count, but not routing-epoch transitions.
- There is no checkpoint or witness container yet.
- Events do not yet carry independent actor signatures.
- Key registration, rotation and revocation are not implemented.
- Formal cross-language conformance vectors are still required.
- Zstandard compressor output does not have to be byte-identical across implementations; the stored compressed bytes are committed by their individual segment.
