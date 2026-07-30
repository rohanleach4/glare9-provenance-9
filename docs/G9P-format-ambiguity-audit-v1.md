# G9P independent-verification ambiguity audit v1

## Result

No unresolved byte-level or authenticated-meaning ambiguity was identified in the implemented experimental segment v1, segment v2, routing epoch v1, checkpoint v1 or witness receipt v1 profiles on 2026-07-30. This is a repository engineering finding, not a substitute for the separately required external implementer and independent cryptographic review.

## Method

The audit compared each normative profile with both repository verifiers and its frozen vectors. It checked magic/version dispatch, exact frame order, canonical map fields, integer and resource ranges, domain-separated logical and exact-file commitments, embedded identity consistency, signature inputs, chain positions, routing bindings and trust/finality semantics. Unknown versions, frames and fields fail closed.

| Profile | Authenticated identity and position | Commitment domains | Independent agreement |
|---|---|---|---|
| segment v1 | ledger, shard, segment number, previous file hash | header/block/signature/file v1 plus record Merkle tree | frozen valid/invalid vectors and bounded mutation tests |
| segment v2 | v1 fields plus routing epoch number and exact epoch hash | distinct header/block/signature/file v2 domains | frozen valid/invalid vectors and routing-bound service recovery |
| routing epoch v1 | ledger, epoch, predecessor, complete old heads and policy | `routing-epoch-v1`, signature and exact-file domains | frozen vector, transition barriers and restart reconstruction |
| checkpoint v1 | ledger, sequence, predecessor, routing epoch and ordered complete current heads | `checkpoint-v1`, signature and exact-file domains | primary/independent vectors, startup reconstruction and corruption rejection |
| witness receipt v1 | exact logical and file checkpoint commitments plus witness identity | receipt, signature and exact-file domains | primary/independent vectors, mixed-checkpoint rejection and distinct-key threshold tests |

## Resolved interpretation boundaries

- Embedded public keys establish signature self-consistency; trust is always external.
- Exact file hashes and logical descriptor hashes are different named commitments and are never interchangeable.
- Empty shard heads are explicit paired nulls; partial heads are invalid.
- Duplicate witness keys count once, receipts for another exact checkpoint count zero, and unordered or duplicate policy membership is invalid.
- Version 1 witness receipts attest checkpoint-container and configured publisher-trust verification only. They do not claim independent possession or traversal of all segment history.
- The segment trust bundle is external deployment policy. It changes neither sealed `.g9p` bytes nor the compatibility promise.

## Change control

Any newly discovered case in which two conforming verifiers could accept identical bytes with different authenticated meaning reopens the go-live gate. Resolution requires a new profile/version or a non-reinterpreting erratum, frozen vectors and agreement testing before release.
