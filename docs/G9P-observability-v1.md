# G9P observability and alerting profile v1

## Endpoint semantics

Both services expose minimal unauthenticated liveness and readiness responses without event, credential, path or database details.

```text
GET /health   200 when the HTTP process is alive
GET /ready    200 when the service can accept its operational role; otherwise 503
GET /metrics  Prometheus text; authenticated
```

Ledger readiness fails after a recorded background sealing error. Connector readiness performs a MySQL ping. Ledger metrics use the ingestion bearer credential. Connector metrics are disabled unless a separate `CONNECTOR_METRICS_TOKEN` of at least 16 characters is configured.

Liveness must not restart a process merely because a dependency is unavailable. Readiness removes it from new traffic while retained state remains available for diagnosis and recovery.

## Ledger metrics

The ledger exports readiness, verified known events, accepted event/byte backlog, provisional events, active segments, aggregate active-block bytes, routing-ledger count and configured intake/memory capacities. Values are aggregate and contain no ledger IDs, event IDs, subjects or payload labels.

## Connector metrics

The connector exports readiness, worker-running state, in-flight events, process delivery/failure counters and last success/error timestamps. A schema-neutral aggregate query over `provenance_outbox` adds ready, leased, delivered and dead-lettered counts plus oldest-ready age. It reads no business table.

## Initial alert rules

| Condition | Severity | Initial response |
|---|---|---|
| readiness is 0 for two consecutive probes | critical | stop routing new work; inspect dependency/background error |
| accepted events or bytes exceed 70% capacity for 5 minutes | warning | inspect sealing throughput and storage latency |
| accepted events or bytes exceed 90% | critical | reduce upstream rate; preserve retained intake |
| active-block bytes exceed 80% for 5 minutes | warning | inspect hot shards and block completion |
| oldest ready outbox age exceeds 2× normal polling/processing objective | warning | inspect ledger reachability and worker errors |
| oldest ready age continues rising for 10 minutes | critical | invoke connector backlog runbook |
| dead-letter count increases | warning | quarantine review; never bulk replay blindly |
| failed batch counter increases repeatedly | warning | classify database, transport, back-pressure or permanent rejection |
| no successful connector delivery while ready backlog is non-zero | critical | check worker state, credentials and ledger readiness |

Tune time thresholds from target deployment measurements. Counters reset on process restart; monitoring storage must retain rates and history externally.

## Security and retention

Bind probe/metrics listeners to a private interface, protect metrics tokens as credentials, rotate them through the deployment secret mechanism and restrict scraper access. Do not add customer-controlled values as metric labels. Monitoring history is operational metadata and requires its own access and retention policy.

Metrics describe service state; they do not prove ledger validity. Incident handling must still use authenticated receipts and offline verification.
