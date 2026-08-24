# Provenance•9 maturity policy v1

## Current designation: Foundation

Provenance•9 is a **Foundation-stage** open evidence ledger: its core recording, sealing, recovery and offline-verification path is implemented, compatibility-controlled and supported by repeatable assurance. “Foundation” means solid enough to build and qualify installations against while retaining room to extend connectors, operational profiles, projections and witnessed finality.

Foundation does not claim that every deployment is production-qualified. An operator must still exercise its storage, backup, power-loss behavior, identity, TLS, database connector and incident procedures in the environment where evidence will be relied upon.

## Independent maturity axes

- **Software maturity — Foundation:** documented package entry points, installation profiles, bounded service contracts and recovery tooling are maintained under 0.x SemVer.
- **Evidence-format maturity — Candidate:** segment formats 1 and 2, routing epoch 1, checkpoint 1 and witness receipt 1 have frozen valid bytes, conformance vectors and dual-verifier agreement; incompatible meaning requires a new version.
- **Deployment maturity — locally exercised:** automated integrated/separated custody, interruption, exact-byte backup/restore, offline verification and isolated MySQL/TLS least-privilege exercises pass; customer-selected environments and site-specific power-loss behavior remain deployment-owner responsibilities.

## Promotion

A deployment may describe itself as “qualified for production evidence” only after its named operators record the applicable live database/TLS, custody, backup, recovery, monitoring and incident exercises and resolve critical/high findings. The open project will not infer deployment assurance merely from successful installation.

The product owner has published the ten-year maintained-verification lifetime required for Stable profiles. Candidate-to-Stable promotion requires a documented maintainer decision against the published compatibility evidence. Independent security review and external verifier confirmation are strongly recommended before that decision, particularly for regulated or high-assurance claims, but their absence is disclosed rather than represented as project-level approval. Until promotion, Candidate bytes remain frozen and retained by the verifiers, but no regulated assurance or service-level promise is implied.
