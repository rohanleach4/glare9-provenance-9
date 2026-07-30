# G9P projection and index rebuild procedure v1

## Principle

Every derived index or projection is disposable. Authoritative state is the verified routing-descriptor and segment history, not an operational database, cache, search index or connector table. Rebuilds must not consult MySQL business tables to reinterpret historical evidence.

## Reference ledger index rebuild

On startup the ledger performs the following sequence:

1. List final routing-epoch keys and reject unexpected key shapes.
2. Verify descriptor signatures, trust roots, epoch sequence, previous-epoch links and complete prior-shard heads.
3. List final segment keys and reject unexpected key shapes.
4. Verify each segment's bounds, framing, compression profile, commitments, signature trust, routing epoch, segment number and previous-segment link.
5. Decode canonical events only after physical and cryptographic validation succeeds.
6. Rebuild the event-ID index, record hashes, shard heads, segment positions and stable sealed receipts.
7. Reconcile durable intake by removing byte-identical events already represented in verified history and retaining only genuinely unsealed events.
8. Fail closed on gaps, forks, conflicting event IDs, untrusted signers, corrupt bytes or topology mismatches.

## Derived projection rebuild

A projection implementation must consume verified events in deterministic `(routing epoch, shard, segment, record)` order and record its input cursor as the exact segment hash plus record position. Cross-shard consumers must not infer a total order that the ledger does not provide. Correlation and causation identifiers supply application-level relationships.

To rebuild:

1. Create a new empty projection generation.
2. Pin the trusted signer, topology-authority and supported-format policy.
3. Verify and replay sealed history from genesis; never copy derived rows from the previous generation.
4. Apply only projection code and schema versions recorded for the new generation.
5. Compare counts, terminal shard heads and deterministic projection checksums.
6. Atomically switch readers to the new generation after review.
7. Retain the previous generation until rollback and reconciliation windows expire.

Unknown event types may be retained as opaque verified events but must not be silently treated as a known semantic type. Unsupported container versions fail before event replay.

## Evidence and limitations

Service restart, sealed-storage injection, backup/restore and event-index tests prove that stable receipts and shard heads rebuild without mutable source data. Customer-specific projections remain outside the schema-neutral ledger and require their own deterministic handlers, reconciliation checks and version policy.
