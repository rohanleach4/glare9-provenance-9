# G9P key registration and event-signing protocol candidate v1

## Scope

This candidate separates four roles: segment producer, topology authority, checkpoint publisher and witness. Each key registration is an externally governed record containing role, algorithm, key ID, public key, controller, valid-from time and optional predecessor/revocation reference. Embedded keys remain self-consistency evidence only.

Rotation is forward-only: register the successor, define its effective time/sequence, retain the predecessor for historical verification, and use new signatures after activation. Revocation records reason, effective time and scope without invalidating evidence created before the trusted compromise boundary. Verifiers require an external registration/revocation set and report signatures created during an uncertain compromise window separately.

The reference service implements the first external-policy slice for segment producers: a versioned positional trust bundle can retain old key IDs for exact historical segment ranges and activate a successor for later ranges. The bundle is authenticated and approved out of band and creates no new `.g9p` profile. Signed registration containers and equivalent rotation support for topology, checkpoint and witness roles remain future protocol work.

Customer-controlled event signing signs `SHA256-domain("customer-event-signature-v1", canonical-event-bytes)` with an externally registered key. A future event-envelope version will carry the registration reference, algorithm, key ID and signature; version 1 event bytes are not revised. Connectors must pass signatures opaquely and must not claim the source was authorized until trust policy validation succeeds.

Installed private keys must use the encrypted integrated key store or the optional self-hosted separated-custody signer. The automatically generated unencrypted PKCS#8 key store is development-only. Qualification must verify Ed25519 identity, authorization and audit boundaries, availability behavior, rotation, backup and disaster recovery for the selected installation profile.
