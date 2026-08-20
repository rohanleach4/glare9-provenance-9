# G9P signer trust bootstrap, rotation and revocation procedure v1

## Trust model

An embedded Ed25519 public key proves only that a `.g9p` object's signature is self-consistent. Trust comes from an external, operator-approved trust bundle mapping key identifiers to purpose, owner, validity and status. Segment-signing keys and routing-topology authority keys are separate roles and must never be treated as interchangeable.

## Bootstrap

1. Generate or import the public key through the approved key-management process.
2. Calculate the G9P key identifier from the exact DER public-key bytes.
3. Compare the identifier through two authenticated channels controlled by different operators.
4. Record role, ledger scope, custodian, algorithm, activation boundary and approval evidence in the trust bundle.
5. Configure the verifier from that reviewed bundle, not from the key embedded in the first observed object.
6. Verify a known signed object and record its file hash before accepting live evidence.

The development service's locally generated key files do not satisfy this production bootstrap procedure.

## Forward rotation

A rotation must be forward-only and must not resign historical objects.

1. Register and approve the successor public key before its activation boundary.
2. Record a signed rotation statement identifying the old key, new key, role, ledger scope and exact activation epoch/segment or checkpoint.
3. Retain the old public key and status for historical verification.
4. Activate the new private key only after the registration statement is durable and independently available.
5. Require new objects at or after the boundary to use the successor; reject use before the boundary.
6. Exercise restart, rollback and verifier behavior on both sides of the boundary.

The reference service now accepts an externally governed version 1 segment trust bundle. Its exact ordered bindings assign a key ID and `trusted` or `revoked` status to one ledger, routing epoch, shard and inclusive segment-number range. On startup, every embedded segment key must be registered for its authenticated position; before sealing, the active private key must be trusted for the next position. This permits forward segment-key rotation and rejects rollback use without changing historical `.g9p` bytes.

The bundle is external JSON deployment policy, not a sealed G9P object or an internally self-authorizing root of trust. Operators must authenticate and approve it out of band. The service does not yet implement signed registration statements or rotation of topology-authority, checkpoint-publisher or witness roles, so production rotation still depends on the approved external governance and key-custody process.

## Revocation and compromise

Revocation records the affected key, role, scope, reason, discovery time, effective boundary and approving authority. It does not make historical signatures cryptographically invalid.

- Objects demonstrably created before a compromise boundary may remain historically trusted under policy.
- Objects at or after the boundary are reported as revoked or indeterminate, never silently trusted.
- Unknown creation ordering requires conservative indeterminate status until an independently witnessed checkpoint establishes a boundary.
- Compromise triggers ingestion isolation, preservation of logs and sealed bytes, trust-bundle publication and an incident review.
- Deleting the old public key is prohibited because it destroys historical verification capability.

## Historical verification

Archive the versioned trust bundle and revocation statements independently from ledger storage. A historical verification report records object hash, signature validity, key identifier, key role, trust-bundle version, status at the object's authenticated position and checkpoint/witness context when available.

Verification distinguishes cryptographic signature validity from the external positional decision. The segment trust evaluator reports `trusted`, `revoked`, `untrusted` or `indeterminate`; range expiry is represented by the absence of an applicable binding or a successor binding at that position. The ledger accepts only `trusted`. Broader time-based compromise-window reasoning still requires independently governed incident evidence.

## External bundle schema

The exact root fields are `kind: "g9p-segment-trust-bundle"`, `version: 1`, `bundleId` and `bindings`. Each strictly ordered, non-overlapping binding contains exactly `ledgerId`, `epochNumber`, `shardId`, `firstSegmentNumber`, nullable inclusive `lastSegmentNumber`, lowercase `keyId` and `status`. An open-ended range must be the final binding for that shard stream.

This schema is a Foundation-series service input and may be versioned independently. It is deliberately excluded from sealed format compatibility claims.
