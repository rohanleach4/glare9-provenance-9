# G9P incident runbooks v1

## Common rules

Preserve evidence before repair. Record incident time, software/configuration identity, affected storage keys and exact error codes. Never edit a sealed `.g9p`, routing descriptor, durable intake envelope or outbox envelope in place. Never expose keys, tokens or payloads in tickets or logs. Use a dedicated non-production environment to rehearse every procedure.

## Key compromise

1. Remove the compromised signer or credential from new traffic without deleting historical keys.
2. Preserve the last trusted segment/routing heads and copy affected sealed bytes exactly.
3. Determine compromise window from external key/audit evidence; embedded keys alone do not establish trust.
4. Rotate forward under the approved trust procedure and record revocation effective time externally.
5. Reverify pre-window, window and post-rotation history separately.
6. The external positional segment trust bundle supports forward producer rotation and revoked-position rejection, but it is not an in-ledger registration authority or approved KMS/HSM. Escalate until the external bundle, custody system and compromise boundary are independently approved.

## Corrupt storage

1. Set the ledger not-ready and stop new ingestion while preserving intake/outbox custody.
2. Copy the suspect object and metadata read-only; do not overwrite it.
3. Run offline verification from the last trusted genesis/epoch and classify byte corruption, signature failure, broken chain or storage omission.
4. Compare exact bytes with verified backup/retention copies.
5. Restore only an exact independently verified object into an empty recovery location, then rebuild indexes and receipts.
6. If no trusted copy exists, preserve the gap as an incident. Never synthesize a replacement segment.

## Stale writer lock

1. Treat `LEDGER_WRITER_LOCKED` as evidence that another writer may still own the data directory; do not delete the lock as a first response.
2. Stop connector delivery or allow retryable failure while checking the service manager and host process table through an authenticated operator channel.
3. Preserve the lock file and incident time externally. It contains process metadata and a random ownership token, not a private signing key.
4. Only after confirming no ledger process can still write, remove the exact `.ledger-writer.lock` file from the configured ledger data directory.
5. Restart one service, require verified-history reconstruction and reconcile retained intake/outbox custody before reopening traffic.

## Missing segment

1. Stop advancement of the affected shard and identify expected previous/next hashes from verified neighbors and routing heads.
2. Search sealed storage, exact-byte backups and retention archives by opaque storage key.
3. Verify any candidate independently before restoration.
4. Rebuild in a fresh location and reconcile event/receipt counts.
5. If unresolved, report an explicit incomplete history. Do not renumber or reconnect later segments.

## Failed witness

If checkpoint publication or an independently operated witness fails, loss of coverage must not be represented as witnessed finality. Preserve the last valid checkpoint and witness receipt, stop issuing new witnessed claims, identify whether publisher trust, witness trust or threshold membership failed, and escalate to the protocol owner. Do not substitute an operator timestamp or local signature.

## Connector backlog

1. Check connector readiness, ready/leased/dead-letter metrics, oldest-ready age and recent bounded error codes.
2. Confirm ledger readiness and intake capacity before increasing connector concurrency.
3. Distinguish database outage, expired credentials, ledger back-pressure, transport failure and poison events.
4. Allow leases to expire naturally after uncertain acceptance; retry identical event IDs and bytes.
5. Review dead letters individually using the outbox procedure. Never edit envelopes or bulk-clear errors.
6. Scale workers only after confirming MySQL capacity and `SKIP LOCKED` behavior; monitor lag until it returns to the reviewed objective.

## Recovery closure

Close an incident only after offline verification, receipt/outbox reconciliation, backlog clearance, monitoring recovery and a written record of any assurance gap. A service returning healthy is necessary but not sufficient.
