# Glare•9 Provenance Foundation readiness review — August 2026

## Decision

Glare•9 Provenance meets the project definition of **Foundation** maturity: the self-contained ledger core, installed key custody, crash recovery, exact-byte backup and independent offline verification are implemented and repeatably exercised. The product is solid enough for further installation qualification and development, but this review does not approve an arbitrary installation for production or regulated evidence.

## Completed foundation evidence

- The terminal installer creates either encrypted Integrated Custody or optional self-hosted Separated Custody, pins three public signing identities in an installation manifest and requires no third-party runtime service.
- Both custody profiles pass an automated non-production exercise covering installation, accepted-event persistence, injected sealing interruption, restart, exact-byte backup and restore, receipt reconstruction and offline verification.
- Both custody profiles pass a disposable mutual-TLS 1.3 operations exercise covering client identity enforcement, readiness, authenticated metrics, sealed ingestion and checkpoint publication.
- The supported JavaScript entry points and compatibility boundary are explicit, while internal modules remain outside the public API commitment.
- Apache License 2.0, DCO inbound contributions, trademark guidance, contributor governance, security reporting and support boundaries are published.
- Core and custody coverage gates, aggregate tests, bounded fuzzing, repository scanning and production-dependency auditing are automated.
- Candidate evidence formats have frozen vectors and agreement between the production verifier and a separately implemented verifier.

## Open deployment and assurance gates

- Exercise the MySQL connector against the designated non-production Workbench-managed database.
- Verify MySQL least-privilege grants and TLS in a production-like environment.
- Obtain operator approval and site-specific exercises for deployment, monitoring and incident runbooks.
- Exercise and approve the selected custody profile, backups and transport identities on the intended host environment.
- Obtain independent review of the threat model and cryptographic design when resources permit.
- Obtain an external implementation or review of the conformance vectors when a suitable contributor is available.
- Record explicit product-owner approval before claiming production-use assurance.

These gates are deliberately visible in `TODO.md`. Lack of funds for legal or external review does not prevent an Apache 2.0 source release, but no unavailable review will be implied or fabricated.

The product owner approved the ten-year maintained-verification commitment in `G9P-format-support-lifetime-v1.md` on 23 August 2026. `G9P-independent-review-guide-v1.md` provides a public, reproducible route for community security review and external verifier confirmation without making either review a paid or legal-release prerequisite.
