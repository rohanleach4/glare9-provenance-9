# Provenance•9 readiness bulletin — 22 August 2026

## Completed or narrowed

- Integrated and self-hosted Separated Custody again passed installation, injected interruption, restart, exact-byte backup/restore and offline verification.
- Both installed custody profiles passed disposable mutual TLS 1.3, client-certificate enforcement, liveness, readiness, authenticated metrics, sealed ingestion and checkpoint publication.
- The installed local MySQL server was exercised on 24 August through the real connector integration suite and a restricted identity using CA-trusted TLS 1.3 and exact-table `SELECT`/`UPDATE`; the dated evidence records its portability limits.
- The product owner approved the ten-year maintained-verification support lifetime on 23 August 2026.
- A reproducible community security-review and external-verifier guide is ready for use when the repository is public.
- The threat model now reflects implemented custody, mutual TLS, privacy, witness and release controls rather than their earlier planned state.

## Still open

- Repeat the MySQL connector qualification in a customer's selected environment when that connector will be relied upon; otherwise record it as not applicable.
- Exercise the intended host, certificate authority, service manager, backup destination, monitoring retention and incident decisions with the named operator.
- Obtain community or professional security/cryptographic review and an independently authored verifier confirmation when reviewers become available.
- A deployment owner should rely on a named installation only after reviewing its applicable database, identity, recovery and operator evidence and recording the assurance level claimed.

No external review, site-specific operator exercise or production assurance has been inferred from repository automation. Independent security review remains strongly recommended for regulated or high-assurance use, but is not represented as project-level approval.
