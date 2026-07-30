# Glare•9 Provenance: Connectors

## Purpose

Connectors attach existing services and databases to Glare•9 Provenance without making any database technology a dependency of the ledger core.

The preferred assurance order is:

1. Customer-signed semantic events submitted through the API or SDK
2. Transactional outbox events committed with the business transaction
3. Change-data-capture observations used for reconciliation
4. Webhook or batch observations where deeper integration is unavailable

These methods provide different evidence strengths and must be labelled accurately.

## Connector boundary

A connector translates a source-specific change into the stable Provenance ingestion envelope. It does not write `.g9p` files directly.

```text
Source system
    ↓
Connector
    ↓
Versioned ingestion envelope
    ↓
Validation, identity and canonicalisation
    ↓
Shard writer
    ↓
Sealed .g9p segment
```

This keeps database credentials, retries and source offsets outside the ledger-format implementation.

Connectors are independently deployable services and npm workspace packages. They remain in the Glare•9 Provenance Git repository initially so changes to the connector contract, service and conformance tests can be reviewed atomically. Independent deployment does not require a separate Git repository.

The shared contract lives under `packages/connector-contract`. Database implementations live under `connectors/<database>` and communicate with `services/ledger` over authenticated HTTP. No connector imports or writes the `.g9p` format directly.

Stable accepted-first receipt fields, polling and error semantics are specified in [`docs/G9P-ingestion-receipts-v2.md`](./docs/G9P-ingestion-receipts-v2.md).

Outbox retention, dead-letter review and byte-identical replay are specified in [`docs/G9P-mysql-outbox-operations-v1.md`](./docs/G9P-mysql-outbox-operations-v1.md). Connector upgrade schema-neutrality and its automated evidence are recorded in [`docs/G9P-connector-schema-neutrality-v1.md`](./docs/G9P-connector-schema-neutrality-v1.md).

Ordering, uncertain-acceptance recovery, quarantine and monotonic receipt reconciliation are exercised through the reusable `@glare9/provenance-connector-contract/test-kit`. The MySQL worker adopts that kit and adds deterministic database-outage, ledger-unavailability and back-pressure faults. See [`docs/G9P-connector-assurance-v1.md`](./docs/G9P-connector-assurance-v1.md).

## MySQL connector

### Implementation status

The first connector iteration is implemented in `connectors/mysql` using the maintained `mysql2` promise client. It provides:

- A separately runnable polling service
- An isolated transactional-outbox table
- Short `FOR UPDATE SKIP LOCKED` leases
- Network delivery after the claiming transaction commits
- At-least-once delivery with ledger-side event idempotency
- Exponential retry and configurable dead-lettering
- Persistence of sealed ledger receipts
- TLS-required-by-default configuration
- `/health` and `/ready` endpoints
- Unit and optional real-MySQL integration tests
- Reusable connector-contract and deterministic availability-fault tests

The version 1 ledger contract seals each submitted shard group synchronously and remains available for compatibility. The stable version 2 accepted-first contract allows bounded active segments to span requests and exposes `accepted`, `provisional`, and `sealed` states with authenticated polling. The MySQL worker uses version 2: durable `accepted` transfers custody to the ledger and allows the outbox row to be marked delivered. Later sealed finality remains queryable from the ledger by event ID and expected record hash. This requires no access to customer business tables.

### MySQL Workbench development rule

Local MySQL is administered through **MySQL Workbench and the existing Workbench-configured MySQL server**. Do not use Docker for MySQL in this project.

Use Workbench to:

1. Select or create a non-production test database.
2. Review and run `connectors/mysql/sql/001_provenance_outbox.sql`.
3. Create the application and connector accounts.
4. Apply least-privilege grants.
5. Inspect queue, delivery, retry and dead-letter state.

The connector process does not control Workbench. It uses the corresponding host, port, database and dedicated account through `connectors/mysql/.env`.

The connector never creates the outbox table automatically. This avoids giving it schema-alteration privileges and keeps every database change explicit.

### Schema neutrality

The connector does not inspect, join, lock or update customer business tables. It knows only the generic outbox schema:

```text
Customer-defined business tables
        ↑ no connector access

provenance_outbox
        ↑ application INSERT
        ↓ connector SELECT/UPDATE
```

All business meaning is carried in the versioned event envelope stored in the outbox `envelope` JSON column. The customer may use any table names, keys and domain schema outside that boundary.

### Transactional outbox mode

The application commits its state mutation and a ledger-intent record in the same MySQL transaction:

```sql
START TRANSACTION;

UPDATE governed_record
SET current_value = ?
WHERE id = ?;

INSERT INTO provenance_outbox (
  event_id,
  envelope
) VALUES (?, ?);

COMMIT;
```

The connector then:

1. Starts a short MySQL transaction.
2. Selects available rows using `FOR UPDATE SKIP LOCKED`.
3. Assigns one expiring lease to the selected batch.
4. Commits and releases all row locks.
5. Sends the envelopes to the Provenance ingestion service outside the transaction.
6. Receives one validated accepted-first lifecycle receipt per event.
7. Persists those receipts in a second short transaction; an `accepted` receipt is sufficient to transfer custody to the ledger.
8. Retries transient failures with exponential delay.
9. Dead-letters permanent failures or rows exceeding the attempt limit.

If the connector crashes after the ledger accepts an event but before the receipt is stored, the lease expires and the event is submitted again. The ledger returns the current lifecycle receipt when the same `eventId` and content are repeated. Conflicting reuse of an event ID is rejected and dead-lettered.

The first implementation targets modern MySQL/InnoDB deployments supporting `SKIP LOCKED`. The network request is never made while MySQL locks are held.

### Permissions

The application account requires `INSERT` on `provenance_outbox`. The connector account requires only `SELECT` and `UPDATE` on that table.

The connector must not receive general access to business tables or permission to create triggers, alter schemas or administer the server. Suggested grants are included as comments in the migration and must be adapted and run explicitly through Workbench.

### Configuration and startup

Copy the examples without committing the resulting secret files:

```text
services/ledger/.env.example     → services/ledger/.env
connectors/mysql/.env.example    → connectors/mysql/.env
```

Start the two services independently from the repository root:

```bash
npm run start:ledger
npm run start:connector:mysql
```

The connector exposes health endpoints on its configured health port:

```text
GET /health   process and delivery counters
GET /ready    verifies MySQL connectivity
```

No event payloads or credentials are written to connector logs.

### Change-data-capture mode

A CDC connector may observe MySQL replication changes and translate them into observed events. CDC is valuable for legacy adoption and independent reconciliation, but it usually captures row mutation rather than business meaning.

CDC records should preserve:

- Source database identity
- Transaction identity and ordering position
- Table and primary-key identity
- Before/after values or their hashes, according to policy
- Capture time and source commit time
- Connector identity and software version
- Source schema version

An observed CDC event must not be represented as equivalent to an actor-signed governance decision.

### Reconciliation mode

Where both semantic events and CDC are available, the connector can verify that:

- A ledger event has a corresponding database mutation.
- A protected database mutation has a corresponding ledger event.
- Previous-state and resulting-state hashes agree.
- No expected transaction is missing from either side.

## Failure requirements

Connectors must be designed for:

- At-least-once delivery with ledger-side idempotency
- Network interruption
- Database failover
- Duplicate source records
- Connector restart and offset recovery
- Schema changes
- Poison events and quarantine
- Back-pressure
- Key rotation
- Clock disagreement
- Ledger service unavailability

No connector may report success merely because an event entered a local queue. Status must distinguish queued, accepted, sealed and witnessed.

The current MySQL connector persists the version 2 receipt returned at custody transfer, normally `accepted` or `provisional`. Sealed state can be polled from the ledger without retaining the MySQL lease. Witnessed receipts and optional background finality mirroring remain later work.

## Security requirements

- Use least-privilege source credentials.
- Separate read, outbox-update and administration capabilities.
- Prefer customer-side signing before transport.
- Never log sensitive payloads or credentials.
- Support payload hashes and customer-controlled content references.
- Authenticate the Provenance service and validate its receipts.
- Record connector version and configuration identity in submitted evidence.

## Future database connectors

The connector contract should support future implementations for:

- PostgreSQL
- Microsoft SQL Server
- Oracle Database
- SQLite and embedded applications
- Document databases
- Object stores
- Event brokers
- SaaS webhooks and batch evidence imports

Database-specific behaviour belongs in adapters. Idempotency, evidence classification, receipts and delivery-state semantics should remain common.
