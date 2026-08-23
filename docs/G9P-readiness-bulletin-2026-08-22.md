# Glare•9 Provenance readiness bulletin — 22 August 2026

## Completed or narrowed

- Integrated and self-hosted Separated Custody again passed installation, injected interruption, restart, exact-byte backup/restore and offline verification.
- Both installed custody profiles passed disposable mutual TLS 1.3, client-certificate enforcement, liveness, readiness, authenticated metrics, sealed ingestion and checkpoint publication.
- The installed local MySQL client and Workbench application were located; follow-up on 23 August confirmed the server accepts TCP and local-socket connections, while neither live qualification connection is configured.
- The product owner approved the ten-year maintained-verification support lifetime on 23 August 2026.
- A reproducible community security-review and external-verifier guide is ready for use when the repository is public.
- The threat model now reflects implemented custody, mutual TLS, privacy, witness and release controls rather than their earlier planned state.

## Still open

- Start or designate the non-production MySQL server and supply the two ignored qualification connection URLs before running the live connector and restricted TLS/grant exercises.
- Exercise the intended host, certificate authority, service manager, backup destination, monitoring retention and incident decisions with the named operator.
- Obtain community or professional security/cryptographic review and an independently authored verifier confirmation when reviewers become available.
- Approve production use only for a named installation after its applicable database, identity, recovery and operator evidence is complete.

No external review, operator approval or production assurance has been inferred from repository automation.
