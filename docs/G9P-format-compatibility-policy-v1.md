# G9P format stability and compatibility policy v1

## Status

This is the published candidate compatibility policy for the experimental G9P format. It records the rules implemented by the repository today. Product-owner approval of a stable assurance claim remains an explicit go-live gate; publication does not silently promote format versions 1 or 2 to production-stable status.

## Version identities

The following numbers are independent compatibility axes:

- container version: the eighth magic byte and first-frame profile;
- segment format version: authenticated by `HEAD`/`HED2` and `MNF1`/`MNF2`;
- routing protocol version: authenticated inside `RTE1`;
- event envelope version: authenticated in each canonical event;
- routing, compression, authorization, checkpoint and witness policy identifiers.

A reader must validate every applicable axis. It must not infer support for an unknown inner version from a recognized container byte.

## Current support matrix

| Object | Accepted profile | Compatibility obligation |
|---|---|---|
| legacy segment | container 1, `HEAD`/`MNF1`, segment format 1 | retained verification support; sealed bytes never rewritten |
| epoch-aware segment | container 2, `HED2`/`MNF2`, segment format 2 | retained verification support once approved stable |
| routing epoch | container 2, `RTE1`, routing protocol 1 | retained verification support once approved stable |
| checkpoint | container 2, `CHK1`, checkpoint protocol 1 | experimental; retained verification support once approved stable |
| witness receipt | container 2, `WIT1`, witness protocol 1 | experimental; retained verification support once approved stable |
| event | envelope version 1 | unknown future versions rejected before sealing |

Container version 2 is a profile namespace, not a single object grammar. The first frame selects `HED2`, `RTE1`, `CHK1` or `WIT1`; any other profile fails closed.

## Compatibility rules

1. Sealed objects are immutable. A specification correction never authorizes rewriting a `.g9p` object.
2. A byte-level, frame-order, canonical-encoding, hash-domain, signature-input, routing or required-field change creates a new applicable version/profile.
3. New optional semantics cannot be smuggled into an existing exact-field map. Extensibility requires a versioned field or new profile defined in advance.
4. Readers reject unsupported future versions and unknown frames; they do not best-effort parse evidence.
5. Writers emit only one documented profile and never depend on unspecified decoder tolerance.
6. Zstandard output may differ between conforming writers. Verification commits to the exact stored compressed bytes and the independently committed uncompressed records.
7. Storage paths, service receipts, HTTP APIs, metrics and connector leases are not permanent `.g9p` format fields unless a format specification explicitly incorporates them.
8. An implementation may add stricter resource ceilings as deployment policy, but must report that a structurally valid object exceeded local policy rather than calling its bytes cryptographically invalid.

## Stability states

- **Experimental:** implementations may evolve, but every permanent change requires a new version and new vectors. No production compatibility promise.
- **Candidate:** bytes and verification rules are frozen for review; discovered ambiguity is resolved by a new version or published erratum that does not reinterpret valid sealed bytes.
- **Stable:** the product owner has approved the policy and assurance level; valid objects remain verifiable for the published support lifetime.
- **Retired for writing:** writers stop emitting the version, while readers retain verification support for the stated lifetime.

Versions 1 and 2 remain experimental pending the final approval gate. This repository nevertheless treats their existing valid sealed bytes as frozen verification history: changes must use a new version rather than silently reinterpret them.

## Conformance and change procedure

Every format proposal must identify changed bytes and trust semantics, update the normative specification, add valid and precisely invalid language-neutral vectors, pass both repository verifiers, preserve all retained vectors, document migration/rollback behavior, and receive protocol review before release.

An ambiguity affecting independent verification is release-blocking. If two conforming implementations can accept the same bytes with different authenticated meaning, the affected version cannot pass the go-live gate.

## Package and language boundary

The compatibility promise applies to stored G9P evidence, not to undocumented JavaScript internals. Public package and source-language compatibility will be governed separately before the API surface is declared stable. A verifier in another language should require only this policy, the format specifications, cryptographic primitives and the conformance manifest.
