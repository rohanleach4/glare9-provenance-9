# G9P diagnostic-data policy and review v1

## Policy

Logs, health responses, metrics, traces and public errors must never contain event payloads, bearer credentials, database credentials, private signing material or raw authorization headers. Operational diagnostics use bounded identifiers and stable error codes.

## Implemented controls

- Unexpected ledger HTTP failures return a generic message and log only request ID and stable error code.
- Connector batch and loop failures log counts, retryability and stable error codes, not exception messages or event envelopes.
- Connector dead-letter metadata stores a generic message derived from the bounded error code rather than an arbitrary upstream exception message.
- Service startup and connector startup failures emit service state and error code without raw exception text.
- Health and info endpoints expose state, counts, public signer identifiers and configured limits; they do not expose tokens, keys or event content.
- HTTP responses set `cache-control: no-store`.
- Test fault hooks exist only in direct test construction and cannot be enabled through HTTP or environment configuration.

Event IDs, ledger IDs and subjects may themselves be customer metadata. They are therefore excluded from routine error logs. Operators should treat request IDs, segment hashes and signer key IDs as operational metadata and apply normal log access and retention controls.

## Verification

Automated tests inject exception messages containing payload and credential sentinels and assert that neither logs nor HTTP error responses contain them. Repository scanning rejects tracked private keys, runtime `.env` files, `.g9p` data and common credential forms.

This review covers repository-controlled diagnostics. Infrastructure access logs, reverse proxies, database audit logs, APM agents and hosting-provider telemetry require separate deployment review and must disable request-body and authorization-header capture.
