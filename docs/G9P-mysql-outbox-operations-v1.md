# MySQL outbox retention, dead-letter and replay procedure v1

## Scope

This procedure applies only to the dedicated `provenance_outbox` table administered through MySQL Workbench. The connector must not read, alter or require customer business tables. All production-like exercises require a dedicated non-production database first.

## Retention

- Undelivered rows are never retention candidates.
- Delivered rows may be removed only after the ledger's authenticated receipt lookup confirms the same `eventId` and `recordHash` and the customer retention window has expired.
- Dead-lettered rows remain until reviewed and explicitly resolved.
- Delete in bounded primary-key batches ordered by `sequence_id`; avoid long transactions and record the cutoff, count and operator approval.
- Retention removes complete outbox rows. It never changes an envelope so it can be redelivered under the same event ID.
- Sealed `.g9p` retention is governed separately and is not affected by outbox cleanup.

Before deletion, record counts for eligible, delivered, dead-lettered and leased rows. After deletion, repeat those counts and confirm connector readiness and lag.

## Dead-letter review

1. Stop automated replay for the selected rows.
2. Review `event_id`, bounded error code, attempt count and timestamps. Treat the envelope as customer content and restrict access accordingly.
3. Validate the envelope against the shared connector contract without consulting business-table schemas.
4. Classify the cause as invalid immutable envelope, authorization/configuration failure, transient ledger/storage failure, connector defect or ledger contract incompatibility.
5. Never edit an envelope in place. A corrected business fact requires a new event ID produced by the application.
6. Record the disposition: retained for investigation, superseded by a new event, or approved for byte-identical replay.

## Byte-identical replay

Replay is allowed only when the existing envelope is valid and the failure was transient or operational.

In a reviewed Workbench transaction, clear `dead_lettered_at`, lease owner/token/expiry and last-error fields, set a reviewed `available_at`, and optionally reset `attempt_count` according to policy. Do not change `event_id`, `envelope`, `created_at` or an existing receipt. Commit, then monitor the connector.

If the ledger already accepted the event, idempotent submission returns the existing lifecycle receipt and the connector marks the row delivered without creating another ledger record. A conflicting event hash is an incident and must not be forced through replay.

## Reconciliation

Regularly sample delivered rows and compare their stored receipt with authenticated ledger lookup. Alert on stale leases, growing ready backlog, dead-letter growth, repeated authorization failures or receipt conflicts. The operator should be able to account for every row as ready, leased, delivered or dead-lettered.

Database failover, least-privilege grants and TLS behavior remain deployment-specific exercises and are not established by this procedure.
