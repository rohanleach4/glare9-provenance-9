# Provenance•9 MySQL Connector

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

Do not commit database passwords or the Provenance•9 bearer token.

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
http://127.0.0.1:8790/metrics
```

Health and readiness responses are deliberately minimal. Metrics are disabled unless `CONNECTOR_METRICS_TOKEN` is configured and then require that bearer token. They include worker counters plus schema-neutral outbox state and oldest-ready age. See [`docs/G9P-observability-v1.md`](../../docs/G9P-observability-v1.md).

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

The worker runs the shared ordering, recovery, quarantine and receipt-reconciliation test contract, plus MySQL-specific deterministic faults for restart, lease expiry, database outage, ledger back-pressure and ledger unavailability. See [`docs/G9P-connector-assurance-v1.md`](../../docs/G9P-connector-assurance-v1.md). Injected database failures establish worker behavior but do not replace a production-like failover exercise.

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

Least-privilege/TLS qualification uses the actual connector identity, which must have only `SELECT` and `UPDATE` on the dedicated outbox. Set the following for that non-production account:

- `MYSQL_QUALIFICATION_URL` — connector connection URL;
- `MYSQL_QUALIFICATION_CA_PATH` — trusted CA PEM path;
- `MYSQL_QUALIFICATION_UNTRUSTED_CA_PATH` — a different disposable CA used to prove rejection;
- `MYSQL_QUALIFICATION_DATABASE` — exact database containing the outbox;
- `MYSQL_QUALIFICATION_TABLE` — exact outbox table, normally `provenance_outbox`;
- `MYSQL_QUALIFICATION_OTHER_TABLE` — a table the connector must not be able to read.

Then run:

```bash
npm run test:qualification --workspace=@glare9/provenance-connector-mysql
```

The check requires CA-verified TLS 1.3 and exact-table grants. It proves `SELECT` and no-op `UPDATE` succeed; `INSERT`, `DELETE`, `ALTER` and cross-table `SELECT` fail; plaintext is rejected; and a connection through an untrusted CA is rejected. It makes no persistent database change.

Set `MYSQL_INTEGRATION_CA_PATH` alongside `MYSQL_INTEGRATION_URL` when the administrative integration exercise must verify a private or local CA.

A local pass qualifies this connector, driver and MySQL configuration only. It does not qualify another database product, MySQL version, host, network, certificate authority, account-provisioning system or production environment.
