# Connector schema-neutrality evidence v1

## Contract boundary

The MySQL connector depends only on the dedicated outbox columns defined in `connectors/mysql/sql/001_provenance_outbox.sql`. It neither discovers nor queries customer business tables. The application is solely responsible for constructing a versioned G9P envelope in the same transaction as its business change.

The connector treats `envelope` as one opaque JSON value except for checking that its top-level `eventId` equals the indexed outbox `event_id`. The shared connector client validates the ledger's versioned receipt. Customer event types, schema versions, subjects, payload field names and nested payload structure are not connector configuration.

## Upgrade rule

A connector release is schema-neutral only when:

- it requires no migration to a customer business table;
- it does not select, join, introspect or infer business-table columns;
- arbitrary valid envelope payloads pass through without transformation;
- outbox migrations, if ever required, affect only the dedicated connector table and are explicitly reviewed in Workbench;
- older valid envelopes remain deliverable through the declared connector contract;
- event IDs and canonical content remain unchanged across retry or upgrade.

## Automated evidence

The worker test `worker delivers application-schema payloads opaquely through the shared envelope` submits a future customer event type, high customer schema version and nested fields unknown to the connector, then asserts exact structural equality at the ledger-client boundary.

Repository review confirms that runtime SQL is parameterized against the configured outbox table only. The connector account requires `SELECT` and `UPDATE` only on that table; the application account requires `INSERT`. Production-like grant verification remains a separate deployment task.
