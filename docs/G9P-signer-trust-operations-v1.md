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

The current reference service trusts one configured local signer and one topology authority. It does not yet implement the registration statement or multi-key historical trust registry, so production rotation is not currently enabled.

## Revocation and compromise

Revocation records the affected key, role, scope, reason, discovery time, effective boundary and approving authority. It does not make historical signatures cryptographically invalid.

- Objects demonstrably created before a compromise boundary may remain historically trusted under policy.
- Objects at or after the boundary are reported as revoked or indeterminate, never silently trusted.
- Unknown creation ordering requires conservative indeterminate status until an independently witnessed checkpoint establishes a boundary.
- Compromise triggers ingestion isolation, preservation of logs and sealed bytes, trust-bundle publication and an incident review.
- Deleting the old public key is prohibited because it destroys historical verification capability.

## Historical verification

Archive the versioned trust bundle and revocation statements independently from ledger storage. A historical verification report records object hash, signature validity, key identifier, key role, trust-bundle version, status at the object's authenticated position and checkpoint/witness context when available.

Verification must distinguish `valid signature`, `trusted for position`, `revoked`, `expired`, `untrusted embedded key` and `indeterminate`. Current tools implement valid-signature and explicit trusted/untrusted identity; temporal rotation and revocation statuses require the future key protocol and registry.
