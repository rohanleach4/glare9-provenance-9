# Glare•9 Provenance

Glare•9 Provenance is a Foundation-stage, independently verifiable governance evidence ledger. It preserves append-only event history in compressed, signed `.g9p` segments without requiring an application to replace its operational database.

Foundation means the core recording, sealing, recovery and offline-verification path is solid, compatibility-controlled and ready for installation qualification, with room to extend connectors, projections and witnessed finality. It is not a blanket claim that an unqualified deployment is ready for regulated or production evidence; see [`docs/G9P-maturity-policy-v1.md`](./docs/G9P-maturity-policy-v1.md).

The current first iteration can:

- Deterministically encode and hash governance events
- Route events to a versioned shard policy
- Compress records into independent Zstandard blocks
- Seal hash-linked `.g9p` segments with Ed25519
- Create and independently verify signed routing-epoch `.g9p` descriptors
- Persist and verify per-ledger signed epoch-zero routing history
- Bind new epoch-scoped version 2 segments to their signed routing descriptor
- Retain accepted events durably before assigning their routing epoch and shard
- Batch accepted-first ingestion across bounded active blocks and segments
- Recover completed provisional blocks and seal segments by byte, record, or age limits
- Publish chained global shard-head checkpoints and independently signed threshold witness receipts
- Apply bounded intake and active-memory back-pressure before accepting excess work
- Publish immutable history through an injectable sealed-storage contract while retaining independent byte verification
- Execute signed forward-only routing transitions across crash-safe barriers
- Verify segments offline and distinguish an embedded key from a trusted key
- Detect block mutation, signature mutation, truncation and incorrect chain links
- Accept authenticated event batches through a separately runnable ledger service
- Deliver schema-neutral MySQL transactional-outbox events through a switchable connector service

## Try the first iteration

Requirements: Node.js 24 or later and npm 11 or later.

```bash
npm install
npm run test:all
npm run demo
```

Create a protected installed profile:

```bash
npm run setup
```

The installer offers self-contained Integrated Custody and optional self-hosted Separated Custody. See [`docs/G9P-installation-v1.md`](./docs/G9P-installation-v1.md).

Verify a segment:

```bash
npm run verify -- path/to/segment.g9p
```

Preview deterministic sharding for a new ledger:

```bash
npm run shard -- governance-ledger 4 model:alpha model:beta policy:credit
```

Verify a signed routing-epoch descriptor:

```bash
npm run verify:epoch -- path/to/epoch-000001.g9p [trusted-key-id]
```

The implementation includes an installable ledger-ingestion service, optional self-hosted separated custody and a MySQL outbox connector. Production reliance requires the live MySQL/TLS, custody, backup and recovery qualification applicable to that installation.

The existing version 1 ingestion endpoint continues to wait for sealed receipts. The stable version 2 accepted-first contract allows active segments to span requests, returns explicit `accepted`, `provisional`, or `sealed` state, and provides authenticated receipt polling without changing the G9P container format. The MySQL connector uses durable `accepted` as the custody-transfer point.

## MySQL connector

Local MySQL development uses the existing server administered through **MySQL Workbench**, not Docker. Review and apply the outbox migration through Workbench, then configure the ledger and connector using their ignored `.env` files.

```bash
npm run start:ledger
npm run start:connector:mysql
```

See [`connectors/mysql/README.md`](./connectors/mysql/README.md) for setup, permissions and testing.

## Documentation

- [`Provenance-readme.md`](./Provenance-readme.md) — product, trust model and usage
- [`Sharding-readme.md`](./Sharding-readme.md) — sharding, segments and checkpoints
- [`Connector-readme.md`](./Connector-readme.md) — MySQL and future connectors
- [`Test-readme.md`](./Test-readme.md) — test and assurance strategy
- [`docs/G9P-format-v1.md`](./docs/G9P-format-v1.md) — Candidate byte-level format
- [`docs/G9P-format-v2.md`](./docs/G9P-format-v2.md) — epoch-aware Candidate segment format
- [`docs/G9P-routing-epochs-v1.md`](./docs/G9P-routing-epochs-v1.md) — signed routing epochs and forward-only resharding protocol
- [`docs/G9P-ingestion-receipts-v2.md`](./docs/G9P-ingestion-receipts-v2.md) — stable accepted-first ingestion and receipt-polling contract
- [`docs/G9P-lifecycle-sizing-v1.md`](./docs/G9P-lifecycle-sizing-v1.md) — measured block, segment and age defaults
- [`docs/G9P-sealing-crash-safety-v1.md`](./docs/G9P-sealing-crash-safety-v1.md) — sealing-boundary state and recovery demonstration
- [`docs/G9P-sealed-storage-v1.md`](./docs/G9P-sealed-storage-v1.md) — immutable sealed-object storage contract and local adapter
- [`docs/G9P-backup-recovery-v1.md`](./docs/G9P-backup-recovery-v1.md) — exact-byte backup, retention and disaster recovery
- [`docs/G9P-projection-rebuild-v1.md`](./docs/G9P-projection-rebuild-v1.md) — verified-history index and projection rebuild procedure
- [`docs/G9P-resource-limit-review-v1.md`](./docs/G9P-resource-limit-review-v1.md) — hostile-input resource-limit review
- [`docs/G9P-diagnostic-data-policy-v1.md`](./docs/G9P-diagnostic-data-policy-v1.md) — diagnostic redaction policy and evidence
- [`docs/G9P-shard-benchmark-v1.md`](./docs/G9P-shard-benchmark-v1.md) — representative shard-distribution measurements
- [`docs/G9P-shard-resilience-v1.md`](./docs/G9P-shard-resilience-v1.md) — hot-shard, back-pressure, recovery and concurrency evidence
- [`docs/G9P-mysql-outbox-operations-v1.md`](./docs/G9P-mysql-outbox-operations-v1.md) — MySQL outbox retention, dead-letter and replay operations
- [`docs/G9P-connector-schema-neutrality-v1.md`](./docs/G9P-connector-schema-neutrality-v1.md) — connector schema-neutrality evidence
- [`docs/G9P-connector-assurance-v1.md`](./docs/G9P-connector-assurance-v1.md) — reusable connector contract and deterministic fault matrix
- [`docs/G9P-compatibility-test-matrix-v1.md`](./docs/G9P-compatibility-test-matrix-v1.md) — supported and rejected version behavior
- [`docs/G9P-signer-trust-operations-v1.md`](./docs/G9P-signer-trust-operations-v1.md) — signer trust, rotation and revocation procedure
- [`docs/G9P-format-ambiguity-audit-v1.md`](./docs/G9P-format-ambiguity-audit-v1.md) — dual-verifier authenticated-meaning audit
- [`docs/G9P-technical-qualification-v1.md`](./docs/G9P-technical-qualification-v1.md) — redacted signer, MySQL/TLS and security qualification evidence
- [`docs/G9P-independent-review-response-2026-07.md`](./docs/G9P-independent-review-response-2026-07.md) — disposition of external agent review findings
- [`docs/G9P-independent-review-guide-v1.md`](./docs/G9P-independent-review-guide-v1.md) — reproducible community security and external-verifier review route
- [`docs/G9P-development-ci-v1.md`](./docs/G9P-development-ci-v1.md) — supported runtime and automated CI/security checks
- [`docs/G9P-quality-hardening-v1.md`](./docs/G9P-quality-hardening-v1.md) — enforced coverage, property testing and bounded fuzzing
- [`docs/G9P-performance-baseline-v1.md`](./docs/G9P-performance-baseline-v1.md) — end-to-end performance harness and measured baseline
- [`docs/G9P-threat-model-v1.md`](./docs/G9P-threat-model-v1.md) — implementation trust boundaries, controls and residual risks
- [`docs/G9P-format-compatibility-policy-v1.md`](./docs/G9P-format-compatibility-policy-v1.md) — candidate format stability and retained-verification policy
- [`docs/G9P-format-support-lifetime-proposal-v1.md`](./docs/G9P-format-support-lifetime-proposal-v1.md) — proposed ten-year maintained-verification commitment
- [`docs/G9P-conformance-vectors-v1.md`](./docs/G9P-conformance-vectors-v1.md) — language-neutral vectors and separate verifier agreement
- [`docs/G9P-source-package-policy-v1.md`](./docs/G9P-source-package-policy-v1.md) — maintained language, workspace and package compatibility policy
- [`docs/G9P-supported-api-v1.md`](./docs/G9P-supported-api-v1.md) — supported JavaScript entry points and SemVer boundary
- [`docs/G9P-maturity-policy-v1.md`](./docs/G9P-maturity-policy-v1.md) — Foundation software, Candidate formats and deployment qualification
- [`docs/G9P-privacy-content-policy-v1.md`](./docs/G9P-privacy-content-policy-v1.md) — privacy, retention, deletion-reference and content handling
- [`docs/G9P-release-procedure-v1.md`](./docs/G9P-release-procedure-v1.md) — versioning, SBOM, signing and reproducible source releases
- [`docs/G9P-licence-governance-v1.md`](./docs/G9P-licence-governance-v1.md) — Apache 2.0 licensing, DCO contributions and project governance
- [`docs/G9P-key-identity-protocol-v1.md`](./docs/G9P-key-identity-protocol-v1.md) — key lifecycle and customer-controlled signing candidate
- [`docs/G9P-signing-custody-contract-v1.md`](./docs/G9P-signing-custody-contract-v1.md) — self-contained integrated and optional self-hosted separated signing custody
- [`docs/G9P-transport-identity-v1.md`](./docs/G9P-transport-identity-v1.md) — TLS, mutual TLS and credential rotation profile
- [`docs/G9P-checkpoint-witness-v1.md`](./docs/G9P-checkpoint-witness-v1.md) — implemented Candidate checkpoint, witness and threshold policy
- [`services/witness/README.md`](./services/witness/README.md) — separately operated reference witness
- [`docs/G9P-mysql-qualification-v1.md`](./docs/G9P-mysql-qualification-v1.md) — Workbench-managed integration and TLS/grant qualification
- [`docs/G9P-deployment-operations-v1.md`](./docs/G9P-deployment-operations-v1.md) — supported topology, capacity and availability profile
- [`docs/G9P-observability-v1.md`](./docs/G9P-observability-v1.md) — health, readiness, metrics and alerting
- [`docs/G9P-incident-runbooks-v1.md`](./docs/G9P-incident-runbooks-v1.md) — evidence-preserving incident procedures
- [`docs/G9P-operations-manual-v1.md`](./docs/G9P-operations-manual-v1.md) — administrator, operator, verifier and responder manual
- [`docs/G9P-installation-v1.md`](./docs/G9P-installation-v1.md) — create-only terminal installation and custody profiles
- [`docs/G9P-non-production-pilot-v1.md`](./docs/G9P-non-production-pilot-v1.md) — automated installation, interruption, backup and restore evidence
- [`docs/G9P-non-production-operations-qualification-v1.md`](./docs/G9P-non-production-operations-qualification-v1.md) — mutual-TLS, readiness, metrics, ingestion and checkpoint exercise
- [`docs/G9P-foundation-readiness-review-2026-08.md`](./docs/G9P-foundation-readiness-review-2026-08.md) — completed foundation evidence and remaining deployment gates
- [`docs/G9P-readiness-bulletin-2026-08-22.md`](./docs/G9P-readiness-bulletin-2026-08-22.md) — latest completed work and remaining one-sentence gates
- [`TODO.md`](./TODO.md) — production go-live checklist

The open core, specifications and conformance materials are licensed under Apache License 2.0. Glare•9 names and logos remain subject to `TRADEMARKS.md`.
