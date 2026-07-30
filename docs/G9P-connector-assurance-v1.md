# G9P connector assurance contract v1

Status: reusable implementation test contract and deterministic fault record. This is not a G9P container-format specification.

## Scope

Database connectors remain interchangeable services outside the ledger core. The shared package exports a reusable Node test kit at `@glare9/provenance-connector-contract/test-kit`. A connector supplies a harness implementing durable enqueue, one delivery attempt, restart, lease expiry, fault injection, state inspection and receipt reconciliation. The kit then runs the same ordering, recovery, quarantine and reconciliation scenarios for that connector.

The MySQL implementation runs the kit against the real `MySqlConnectorWorker` and a deterministic in-memory model of the dedicated outbox table. This isolates connector state-machine behavior without requiring or emulating customer business tables.

## Required harness surface

The current test kit expects:

```text
enqueue(events)                     persist source events in source order
deliverOnce()                       execute one connector delivery attempt
submittedEventIds()                 report exact ledger submission order
state(eventId)                      report ready, leased, delivered or quarantined
injectDeliveryCommitFailure()       fail after ledger acceptance, before source commit
restoreStorage()                    restore the source adapter
restart()                           replace the worker while retaining source state
expireLeases()                      advance retained leases to reclaimable state
injectLedgerFailure(error)          inject a retryable or permanent ledger result
reconcile(eventId, receipt)         compare stored custody receipt with ledger state
close()                             optional cleanup
```

Future PostgreSQL, SQL Server or other durable-source adapters can implement this surface and register the same suite. Adapter-specific integration tests remain necessary for SQL locking, transaction and failover behavior.

## Shared scenarios

### Ordering

Three source events are claimed and submitted in increasing source order. Each receipt is persisted against the matching event. The connector may batch delivery, but it must not permute the claimed source sequence.

### Restart and lease recovery

The ledger accepts an event and returns a stable receipt, then source receipt persistence becomes unavailable. Recording failure also cannot complete, leaving the original lease intact. A new worker cannot reclaim the row before lease expiry. Once the lease expires, the worker submits the identical envelope again, receives the idempotent receipt and marks exactly one source row delivered.

This is the critical uncertain-acceptance path: at-least-once transport is made safe by stable event identity and ledger-side idempotency.

### Quarantine

A permanent ledger rejection such as `EVENT_ID_CONFLICT` is recorded as non-retryable and moves the row to quarantine/dead-letter state. A subsequent delivery attempt does not resubmit it. Transient capacity or availability failures must never use this path.

### Reconciliation

The shared `reconcileLifecycleReceipt` function validates both lifecycle receipts and requires equal event identity, ledger identity and canonical record hash. Receipt state may remain equal or advance from `accepted` to `provisional` or `sealed`; regression and content disagreement fail with non-retryable `RECEIPT_RECONCILIATION_CONFLICT`.

## MySQL deterministic fault matrix

The MySQL worker suite injects:

| Fault | Required result |
|---|---|
| Ledger `LEDGER_BACKPRESSURE` | Release for retry with bounded backoff; do not dead-letter |
| Ledger `LEDGER_UNAVAILABLE` | Release for retry with bounded backoff; do not dead-letter |
| Database claim outage | Worker loop records a bounded code, waits, then resumes delivery |
| Database loss after ledger acceptance | Leave the lease recoverable; restart waits for expiry and resubmits identically |
| Permanent ledger conflict | Quarantine once and stop automatic retry |
| Invalid outbox identity | Quarantine before ledger submission |

The tests also retain the existing proof that arbitrary payload and credential sentinels do not reach connector diagnostics.

## MySQL boundary

The deterministic model represents only the dedicated `provenance_outbox` contract. It makes no assumption about customer application schemas and does not use Docker-based MySQL. The optional integration suite remains the authority for actual `mysql2`, InnoDB transaction and `FOR UPDATE SKIP LOCKED` behavior on a dedicated non-production database administered through MySQL Workbench.

An injected database exception demonstrates worker recovery logic; it is not production-like qualification of a particular MySQL cluster, proxy, failover product, TLS endpoint or DNS arrangement. Those remain deployment exercises.

## Permanent-format impact

None. This milestone adds a service-level receipt reconciliation helper, reusable tests and MySQL worker assurance. It changes no canonical event bytes, routing rule, segment field, signature input or `.g9p` version.
