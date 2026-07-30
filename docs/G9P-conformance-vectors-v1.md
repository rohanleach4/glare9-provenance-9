# G9P conformance and independent-verifier profile v1

## Purpose

The repository publishes frozen, language-neutral vectors in `conformance/g9p-v1-v2-vectors.json`. The manifest contains five valid signed objects—a version 1 segment, version 2 segment, routing epoch, checkpoint and witness receipt—and nine declarative invalid mutations covering future versions, truncation, trailing bytes, physical block commitment and signatures.

Each valid entry records ordinary SHA-256 for transport checking plus the protocol file hash, logical root, identity and counts expected from verification. Each invalid entry identifies a valid source, a literal mutation, the precise reference-verifier error code and a portable assurance category.

## Independent implementation boundary

`tools/independent-verifier/verify.js` is a second offline verifier implemented without importing production code from `src/`. It independently implements frame parsing, canonical decoding/re-encoding, domain hashing, Ed25519 identity/signature checks, Zstandard decompression, record framing, routing, block commitments, Merkle reconstruction and checkpoint/witness commitments.

It intentionally uses the same Node.js standard cryptographic and Zstandard primitives as the primary implementation. It is implementation-independent, not an externally authored or cross-runtime cryptographic review. The JSON vectors are language-neutral so another implementation can consume them without JavaScript.

## Agreement rule

For valid vectors, both implementations must reproduce every recorded result. For invalid vectors, the primary verifier must emit the exact recorded code and the independent verifier must reject in the recorded portable category or at an earlier structural/resource boundary. Neither verifier may crash, hang, repair or partially accept an invalid object.

`npm run conformance:test` enforces agreement and is included automatically in `npm run test:all` through the root test directory. Regeneration uses ephemeral keys, writes no private material and must be an intentional reviewed change because every signature and file hash will change.

## Current limits

The vector set is deliberately compact and does not claim exhaustive parser coverage. Bounded fuzzing and property tests cover broader mutations. Future additions should include multi-block chains, non-genesis routing epochs, boundary integers/text, every defined exact-field failure and vectors produced by a genuinely cross-language writer.
