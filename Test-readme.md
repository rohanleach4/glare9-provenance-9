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

Run the same suite with Node's built-in coverage report:

```bash
npm run test:coverage
```

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
- Signed routing-epoch creation, chaining, trust and hostile-input rejection
- Ledger routing-history creation, descriptor-bound segments, legacy migration, restart, mismatch and tamper handling
- Authenticated ingestion and idempotent receipt replay
- Event-index reconstruction from verified segments
- Connector response validation
- MySQL configuration and safe table-name handling
- Worker delivery, retry and invalid-envelope dead-letter behaviour

### Real MySQL integration

MySQL is administered through MySQL Workbench and the existing local server. Do not use Docker for MySQL testing.

Set `MYSQL_INTEGRATION_URL` to a dedicated non-production database on that server, then run:

```bash
npm run test:integration --workspace=@glare9/provenance-connector-mysql
```

The opt-in test creates and drops only a uniquely named temporary outbox table. The test is skipped when `MYSQL_INTEGRATION_URL` is not supplied. Never supply production credentials or a production database.

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
