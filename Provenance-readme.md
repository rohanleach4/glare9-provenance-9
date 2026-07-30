# Glare•9 Provenance

Glare•9 Provenance is an independent, open evidence ledger intended to add portable, cryptographically verifiable history to existing governed systems without replacing their operational databases.

The portable ledger-segment extension is **`.g9p`**.

## Product principles

- The ledger proves what was recorded; it does not prove that every recorded assertion is objectively true.
- MySQL and other operational databases may remain mutable.
- Ledger history is append-only: corrections supersede earlier assertions rather than rewriting them.
- Integrity must be independently verifiable without a Glare•9 subscription or hosted endpoint.
- The public format must not depend on MySQL, JavaScript or one storage vendor.
- Sensitive and large content may remain in customer-controlled storage with hashes and durable references in the ledger.
- Sharding, compression and verification are first-class format concerns.
- Finality levels must be explicit: provisional, sealed and witnessed are not interchangeable.

## Intended use cases

- AI model registration, assessment, approval and deployment history
- Risk acceptance and control evidence
- Policy publication and supersession
- Human review and accountability records
- Incident and remediation history
- Document and dataset provenance
- Verifiable audit trails for existing services
- Database-state reconciliation
- Point-in-time reconstruction and disaster recovery

## High-level architecture

```text
Applications and databases
        ↓
API, SDKs and connectors
        ↓
Ingestion validation and identity
        ↓
Deterministic shard routing
        ↓
Canonical event records
        ↓
Compressed, hash-linked .g9p segments
        ↓
Checkpoint and witness services
        ↓
Readers, verifiers and projections
```

## Event model

A stable ingestion envelope is expected to include:

- Ledger and stream identity
- Subject identity
- Event type and schema version
- Event and idempotency identifiers
- Occurrence and recording times
- Actor, authority and key identity where applicable
- Payload, encrypted payload or content reference
- Payload hash
- Previous-state and resulting-state hashes where applicable
- Correlation and causation identifiers
- Policy or approval references
- Source classification and signatures

The permanent representation will use a deterministic binary encoding. JSON may be supported at API and diagnostic boundaries but will not define the authoritative bytes.

## `.g9p` segment model

A sealed segment is expected to contain:

```text
Header
├── magic bytes and format version
├── ledger, shard and segment identities
└── previous-segment commitment

Schema and dictionary material
Independently compressed record blocks
Compact indexes
Record Merkle commitments
Manifest and physical block commitments
Producer and witness signatures
Footer
```

The file extension does not establish validity. Readers must validate magic bytes, structure, commitments, signatures and chain linkage.

The executable experimental format is specified in `docs/G9P-format-v1.md`.

## Compression

- Encode compactly before applying general-purpose compression.
- Use independently compressed blocks rather than one perpetual stream.
- Hash canonical record bytes for logical-content commitments.
- Hash stored compressed blocks for exact physical-file commitments.
- Compress before encryption.
- Avoid copying large documents into the ledger when a governed content hash and reference are sufficient.
- Do not recompress or rewrite a sealed segment silently.

The initial compression candidate is Zstandard, subject to deterministic-format, ecosystem and licensing review.

## Reader model

The project should provide:

- A MySQL reader for current operational state
- A `.g9p` reader for history and point-in-time reconstruction
- A hybrid reader combining current state with ledger evidence
- A verified reader that checks database state against ledger commitments
- An offline verifier independent of hosted Glare•9 services

Disposable indexes and projections may be rebuilt from the ledger. They are not part of sealed history.

## Corrections

Historical records are never edited to represent a correction. A later event identifies the superseded assertion and records the corrected state or decision.

```text
Event 10: assertion recorded
Event 27: Event 10 superseded with reason
Event 28: corrected assertion recorded
```

## Assurance levels

The product should distinguish:

- **Observed**: captured through CDC or a webhook
- **Recorded**: submitted by an authenticated source
- **Signed**: attested by a customer-controlled key
- **Transaction-linked**: correlated with an operational transaction
- **Sealed**: included in a finalised `.g9p` segment
- **Witnessed**: included in an externally attested checkpoint
- **Federated**: accepted under a threshold witness policy

## Starting the service

The current iteration provides a segment writer, offline verifier, authenticated ledger-ingestion service and independently runnable MySQL outbox connector.

Requirements:

- Node.js 24 or later
- npm 11 or later

The ledger core has no third-party runtime dependencies. The MySQL connector uses `mysql2`, isolated in its own workspace.

Run the demonstration:

```bash
npm run demo
```

This creates an ignored runtime directory, writes a sealed `.g9p` segment and verifies it using the generated trusted key identity.

Verify an existing segment using its embedded, cryptographically self-consistent but otherwise untrusted key:

```bash
npm run verify -- path/to/segment.g9p
```

Require a specific trusted signing-key identifier:

```bash
npm run verify -- path/to/segment.g9p expected-key-id
```

The implemented local service topology is:

```text
Authenticated Provenance ingestion service
Segment writer and local storage
Reader/verifier
Independent MySQL connector service
MySQL Workbench-managed local server
```

Create ignored `.env` files from the examples, then run the services in separate terminals:

```bash
npm run start:ledger
npm run start:connector:mysql
```

MySQL must use the existing local server administered through MySQL Workbench. Docker is not used for MySQL in this project.

## First-iteration implementation

The current JavaScript implementation includes:

- A deterministic binary value codec
- Strict version 1 event validation
- Domain-separated SHA-256 commitments
- Ed25519 segment signatures
- Deterministic subject-based shard routing
- Native Zstandard block compression
- An append-only framed `.g9p` container
- Merkle commitments to logical event history
- Commitments to exact stored block bytes
- Exact-file segment hashes and previous-segment links
- Signed routing-epoch descriptors with explicit topology-authority trust
- Per-ledger signed epoch-zero routing history loaded and verified at service startup
- Epoch-aware version 2 segments bound to the applicable signed routing descriptor
- Crash-safe topology-neutral accepted-event intake with automatic restart recovery
- Bounded epoch-scoped active blocks and active segments spanning accepted-first requests
- Durable completed-block recovery with byte, record-count and age-based sealing
- Intake and active-block back-pressure with explicit retryable rejection
- Signed forward-only routing transitions with verified old-shard barriers and restart-safe activation
- Create-only `.g9p.part` finalisation
- An offline hostile-input verifier
- A CLI demonstration and verification command
- An authenticated, versioned batch-ingestion API
- Ledger-side event idempotency rebuilt from verified segments
- A shared database-independent connector client contract
- A separately deployable MySQL transactional-outbox worker
- Leased delivery, retry, dead-lettering and sealed-receipt persistence

The current implementation deliberately does not yet include production key management, receipt notifications, checkpoint services, witness nodes, CDC reconciliation or database projections. HTTP contract version 2 provides stable accepted-first lifecycle receipts and authenticated polling, while version 1 remains synchronously sealed for compatibility. Routing transitions use a separate local administration credential and topology-authority key, neither of which is a production authorization system. The local service stores generated development keys under its ignored data directory; this is not a production key manager.

## Connecting a service

The preferred connection methods are:

1. Submit customer-signed semantic events through the API or SDK.
2. Use a transactional outbox connector where the event must accompany a database mutation.
3. Add change-data capture for legacy integration and reconciliation.
4. Use webhooks or signed batch manifests where direct integration is unavailable.

The version 1 ingestion endpoint seals synchronously and returns a sealed receipt. Version 2 durably accepts without forcing a seal and returns `accepted`, `provisional`, or `sealed`. Clients poll the authenticated receipt endpoint using both event ID and expected record hash. Durable acceptance transfers custody to the ledger; witnessed receipts and push notifications remain future work.

## Hosting models

- **Glare•9 hosted:** managed ingestion, storage, verification and witnessing
- **Customer hosted:** customer-controlled infrastructure, storage and keys
- **Split custody:** customer stores ledger content while Glare•9 or another party witnesses checkpoints
- **Federated:** multiple independently administered witnesses attest under a threshold policy

The core format and verifier must function in every model.

## Open-source direction

The intended open surface includes the format specification, core ledger engine, reader, verifier, checkpoint protocol, reference witness, test vectors and basic connectors. Commercial value may be offered through managed hosting, witness operation, enterprise integrations, governance packs, certified releases and support.

The licence remains to be formally selected. Apache 2.0 is the current adoption-first preference, subject to legal review.

## Documentation map

- `Sharding-readme.md`: shard routing, segments, checkpoints and topology changes
- `Connector-readme.md`: MySQL and future source integrations
- `Test-readme.md`: verification and testing strategy
- `docs/G9P-ingestion-receipts-v2.md`: stable accepted-first ingestion and receipt polling
- `docs/G9P-lifecycle-sizing-v1.md`: reproducible lifecycle benchmark and measured deployment defaults
- `Global-readme.md`: ignored local build instructions
