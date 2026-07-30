# Glare•9 Provenance: Testing

## Current status

The first iteration uses Node.js 24's built-in `node:test` runner and strict assertion library. This keeps the format core free from third-party test dependencies while the protocol is young. The MySQL workspace uses `mysql2` as its runtime database driver.

Future property-testing and fuzzing tools remain to be selected.

## Required test layers

### Unit tests

Cover deterministic encoding, hashes, Merkle construction, indexes, shard routing, segment state transitions, event validation and connector state machines.

### Format conformance tests

Committed test vectors should allow an implementation in any language to prove that it produces and verifies the same canonical bytes, hashes, roots and signatures.

Vectors should include:

- Minimal valid segment
- Multiple independently compressed blocks
- Empty and boundary-length fields
- Every supported schema and algorithm identifier
- Key rotation
- Previous-segment linkage
- Witness receipts
- Known-invalid segments with one precise fault each

### Property-based tests

Generate structured records and verify invariants such as:

- Encode/decode round trips preserve the logical record.
- Identical canonical input produces identical canonical bytes.
- Any committed-byte mutation changes the applicable commitment.
- Record order changes the Merkle root.
- Sealed segments reject append operations.
- Duplicate idempotency keys cannot create duplicate ledger events.

### Fuzz tests

Treat readers, decompressors, decoders, indexes and proof parsers as hostile-input boundaries. Fuzzing must check for crashes, excessive allocation, decompression bombs, invalid lengths, truncated data and ambiguous encodings.

### Cryptographic negative tests

- Incorrect record hash
- Incorrect block hash
- Incorrect Merkle path
- Invalid producer signature
- Unknown, expired or revoked key
- Previous-segment mismatch
- Checkpoint missing a required shard
- Insufficient witness threshold
- Checkpoint and witness signature mutation, publisher/witness trust and duplicate-witness threshold handling
- Forward segment-key rotation across restart, positional historical trust, rollback rejection and full offline chain verification
- Mixed-checkpoint witness rejection and duplicate/unordered threshold membership rejection
- Redacted technical-qualification preflight, external signer/trust matching and open high-severity finding detection
- Exclusive ledger-service writer locking and clean reacquisition
- Explicit checkpoint predecessor assertion and chain-verification status
- Fail-fast MySQL table-name configuration and redacted invalid-intake recovery warnings
- Valid logical records in a physically altered container

### Connector contract tests

Every connector implementation must pass a common suite covering:

- At-least-once delivery
- Idempotent retries
- Restart and offset recovery
- Source transaction ordering
- Schema changes
- Quarantine behaviour
- Back-pressure
- Credential failure
- Reconciliation in both directions

### Integration tests

Exercise the ingestion service, segment writer, storage, reader, verifier and at least one connector together. Database-backed tests must use isolated disposable instances and never depend on developer production data.

### Recovery and fault-injection tests

Interrupt the system during:

- Record append
- Block compression
- Segment finalisation
- File synchronisation and atomic promotion
- Checkpoint publication
- Witness collection
- Connector acknowledgement
- Database failover

After recovery, the system must either resume safely or preserve an inspectable failure state. It must never silently produce two accepted histories for one shard epoch.

### Compatibility tests

- Older readers reject unsupported versions clearly.
- Newer readers retain support for declared historical versions.
- Schema upgrades do not change historical bytes.
- Independently implemented verifiers agree on the same fixtures.

### Performance tests

Measure without weakening correctness:

- Ingestion throughput and latency
- Seal latency
- Compression ratio and CPU cost
- Random record lookup
- Full verification and replay speed
- Projection rebuild time
- Shard scaling behaviour
- Connector lag and recovery time

Performance fixtures must distinguish compressible business data from high-entropy hashes, signatures and encrypted payloads.

## Running tests

Run the current unit, format, routing, integration and tamper tests:

```bash
npm run test:all
```

This runs the core, shared connector contract, ledger service and MySQL worker suites. Ledger HTTP tests open an ephemeral localhost port.

Checkpoint conformance covers valid `CHK1` and `WIT1` containers plus precise signature mutations in both the primary and independently implemented verifier. Ledger service coverage exercises separately authenticated checkpoint publication after forced sealing, and core tests exercise two independently generated witness keys satisfying a threshold while duplicate receipts count only once.

Frozen valid and precisely invalid G9P objects are checked by both the production verifier and the separately implemented verifier:

```bash
npm run conformance:test
```

The language-neutral manifest is documented in `docs/G9P-conformance-vectors-v1.md`. Regeneration changes signed fixture bytes and must be deliberate and reviewed.

Run the same suite with Node's built-in coverage report:

```bash
npm run test:coverage
```

This command enforces core floors of 95% lines, 85% branches and 90% functions. The current measured baseline and scope are recorded in `docs/G9P-quality-hardening-v1.md`.

Run the separate lifecycle sizing benchmark:

```bash
npm run benchmark:lifecycle
```

It measures block and segment sweeps for compressible and high-entropy evidence, verifies every generated segment and emits JSON results. It is intentionally excluded from `test:all` because performance results are hardware-dependent.

Run the combined service and connector performance harness:

```bash
npm run benchmark:performance
```

It measures accepted ingestion, service and direct sealing, offline verification, verified restart, idempotent replay, compression profiles and an in-process connector-lag lower bound. The recorded environment, results and exclusions are in `docs/G9P-performance-baseline-v1.md`. It remains outside deterministic CI because hardware and filesystem synchronization materially affect results.

Run deterministic shard-distribution planning and repository security checks:

```bash
npm run benchmark:shards
npm run scan:repository
npm run audit:dependencies
npm run fuzz
```

The dependency audit queries the npm vulnerability service and therefore requires network access. GitHub Actions runs the full suite on every pull request and runs repository scanning, dependency audit and CodeQL on pull requests, `main` and a weekly schedule.

The current suite covers:

- Deterministic canonical map ordering and round trips
- Rejection of non-canonical encodings
- Strict event-envelope validation
- Deterministic event hashing and shard routing
- Multi-block compressed segment writing
- Provisional-to-sealed file promotion
- Offline verification with explicit signer trust
- Exact previous-segment linkage
- Version 1 compatibility and epoch-aware version 2 segment linkage
- Stored-block mutation detection
- Signature mutation detection
- Truncation detection
- Prevention of sealed-path overwrite
- Sealed-storage contract validation, create-only publication, bounded reads, provisional cleanup and non-filesystem restart reconstruction
- Storage-neutral segment and routing-epoch verification from independently retrieved bytes
- Signed routing-epoch creation, chaining, trust and hostile-input rejection
- Ledger routing-history creation, descriptor-bound segments, legacy migration, restart, mismatch and tamper handling
- Durable accepted-event retention, idempotency, provisional promotion, corruption rejection and restart sealing
- Cross-request bounded block/segment batching, explicit block-boundary preservation and age sealing
- Durable compressed provisional-block recovery and retryable intake back-pressure
- Hot-shard bounded-memory behavior, cooler-shard progress, concurrent admission ceilings and four-shard restart recovery
- Serialized concurrent submissions on both sides of a signed routing-transition barrier
- Strict accepted/provisional/sealed receipt schemas and authenticated monotonic polling
- Accepted-first connector custody transfer and lost-acknowledgement replay
- Signed transition barriers, credential separation, retry idempotency, missing-head rejection and epoch activation recovery
- Injected intake-append, both compression boundaries, and every sealed-file open, write, file-sync, create-only promotion, directory-sync and cleanup boundary
- Restart invariants before and after signed routing-epoch publication
- Authenticated ingestion and idempotent receipt replay
- Event-index reconstruction from verified segments
- Connector response validation
- Reusable connector ordering, uncertain-acceptance recovery, quarantine and monotonic receipt reconciliation
- MySQL configuration and safe table-name handling
- Worker delivery, retry, invalid-envelope dead-letter, lease-expiry restart, database-outage, back-pressure and ledger-unavailability behaviour
- Exact-byte backup/archive/restore with verified-history receipt reconstruction
- Hostile input rejection at canonical, frame, record, object and decompression ceilings
- Diagnostic redaction for unexpected ledger and connector failures
- Explicit future event, segment and routing-version rejection
- Opaque customer-schema connector delivery
- Seeded canonical, routing, idempotency and segment property invariants
- Bounded canonical, frame, record, decompression and imported-evidence fuzzing

### Real MySQL integration

MySQL is administered through MySQL Workbench and the existing local server. Do not use Docker for MySQL testing.

Set `MYSQL_INTEGRATION_URL` to a dedicated non-production database on that server, then run:

```bash
npm run test:integration --workspace=@glare9/provenance-connector-mysql
```

The opt-in test creates and drops only a uniquely named temporary outbox table. The test is skipped when `MYSQL_INTEGRATION_URL` is not supplied. Never supply production credentials or a production database.

### Fault injection

The ledger service exposes narrowly named `testFaultInjector` hooks only through direct construction in the test process. Production configuration and HTTP requests cannot enable them. The suite interrupts durable intake, both sides of compression, every sealed-file boundary, response acknowledgement and routing-epoch publication.

The sealing matrix inspects the interrupted filesystem state before restart, including whether the final and provisional names exist. Where hard-link promotion has occurred, it confirms that both names contain identical bytes and identify the same inode. Every case then restarts from that state and checks that the event is retained or sealed exactly once, durable intake is reconciled and no segment provisional file remains. Active-state injection covers file synchronisation, promotion and directory synchronisation for completed compressed provisional blocks. Transition tests cover both sides of the publication boundary: before publication the old epoch remains authoritative; after publication restart must activate the signed new epoch.

See `docs/G9P-sealing-crash-safety-v1.md` for the full boundary matrix, recovery invariants and assurance limits. Deterministic injection does not replace deployment-specific abrupt-process, filesystem, power-loss or hardware fault testing.

The sealed-storage suite exercises the bundled local adapter and an injected non-filesystem implementation. It proves that final history is discovered by opaque key, verified from exact bytes, rebuilt after service restart and replayed idempotently without granting the adapter cryptographic authority. See `docs/G9P-sealed-storage-v1.md` for the adapter guarantees and deployment limits.

The shard-resilience suite uses deterministic synthetic load rather than wall-clock throughput thresholds. It independently verifies every resulting segment and distinguishes concurrent callers from parallel ledger mutation. See `docs/G9P-shard-resilience-v1.md` for the scenarios, guarantees and exclusions.

The connector test kit is reusable by database adapters and is executed by the MySQL worker suite. Its in-memory outbox model proves state-machine behavior under deterministic faults; the skipped-by-default Workbench integration remains necessary for actual InnoDB behavior. See `docs/G9P-connector-assurance-v1.md`.

The property and fuzz suites use recorded seeds, bounded inputs and controlled error assertions. The scheduled security workflow reruns hostile-input fuzzing, while CI rejects reductions below the reviewed core coverage floors. See `docs/G9P-quality-hardening-v1.md`.

The repository should eventually provide additional stable commands for:

```text
unit tests
integration tests
format conformance
property tests
fuzz tests
connector contract tests
performance tests
all required CI checks
```

The default developer test command is fast and deterministic. Slow database, fuzz and performance suites should remain separately invocable and run on an appropriate CI schedule.

## Test data rules

- Never use production or personal data.
- Generate deterministic synthetic fixtures where possible.
- Label all example signing keys as test-only.
- Do not replace golden vectors without an explicit format review.
- Keep malformed fixtures and their expected failure codes documented.
- Store temporary `.g9p` and `.g9p.part` files only under ignored runtime directories.
