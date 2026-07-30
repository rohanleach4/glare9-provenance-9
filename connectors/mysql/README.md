# Glare•9 Provenance MySQL Connector

This workspace is a separately runnable transactional-outbox connector. It has no access to customer business tables and never writes `.g9p` files directly.

## Development database

Use the existing local MySQL server administered through **MySQL Workbench**. Do not use Docker for MySQL in this project.

In Workbench:

1. Select a non-production test database.
2. Open and review `sql/001_provenance_outbox.sql`.
3. Apply the migration explicitly.
4. Create a dedicated connector user.
5. Grant that user only `SELECT` and `UPDATE` on `provenance_outbox`.
6. Grant the application account `INSERT` on the outbox.

The connector will not create or alter the table itself.

## Configure

Copy `.env.example` to the ignored `.env` file and use the connection details for the same server configured in Workbench:

```bash
cp connectors/mysql/.env.example connectors/mysql/.env
```

For a local server without TLS, set `MYSQL_SSL_MODE=disabled` explicitly. TLS is required by default.

Do not commit database passwords or the Provenance bearer token.

## Run

Start the ledger service first, then the connector in another terminal:

```bash
npm run start:ledger
npm run start:connector:mysql
```

Health endpoints default to:

```text
http://127.0.0.1:8790/health
http://127.0.0.1:8790/ready
```

## Application write

The application writes the business change and event envelope in the same transaction:

```sql
START TRANSACTION;

UPDATE any_business_table
SET any_column = ?
WHERE any_key = ?;

INSERT INTO provenance_outbox (event_id, envelope)
VALUES (?, ?);

COMMIT;
```

The `event_id` column and `envelope.eventId` must be identical. The envelope must satisfy G9P event version 1.

## Delivery behaviour

- Rows are leased using `FOR UPDATE SKIP LOCKED`.
- Locks are released before calling the ledger service.
- Delivery is at least once.
- Ledger event IDs make retries idempotent.
- Stable version 2 lifecycle receipts are stored in the outbox row.
- Durable `accepted` transfers custody to the ledger and marks the outbox row delivered.
- Later `provisional` or `sealed` state can be polled from the ledger using the event ID and expected record hash.
- Permanent failures and exhausted retries are dead-lettered.
- Delivered and dead-lettered rows are retained until an explicit customer retention process removes them.

Follow [`docs/G9P-mysql-outbox-operations-v1.md`](../../docs/G9P-mysql-outbox-operations-v1.md) for retention, dead-letter review, replay and reconciliation. The schema-neutral upgrade boundary is evidenced in [`docs/G9P-connector-schema-neutrality-v1.md`](../../docs/G9P-connector-schema-neutrality-v1.md).

## Tests

Run unit and worker tests:

```bash
npm test --workspace=@glare9/provenance-connector-mysql
```

The real-database integration test is opt-in. Set `MYSQL_INTEGRATION_URL` to a dedicated non-production database on the Workbench-managed server, then run:

```bash
npm run test:integration --workspace=@glare9/provenance-connector-mysql
```

The test creates and drops only a uniquely named `provenance_outbox_test_<process-id>` table. Never point it at production.
