# G9P MySQL deployment qualification v1

Two opt-in exercises remain environment evidence rather than deterministic CI. `MYSQL_INTEGRATION_URL` uses a dedicated non-production administrative test identity to create/drop a uniquely named table and exercise leasing, delivery, retry and dead-letter behavior. `MYSQL_QUALIFICATION_URL` uses a restricted connector identity to verify TLS, exact-table grants, permitted operations and denied operations.

Deployment qualification uses the selected non-production MySQL environment administered through MySQL Workbench. A reference qualification may instead use an isolated instance of the locally installed MySQL server. Docker is prohibited. Credentials remain external and must never appear in logs, commits or evidence. Record server/version, TLS protocol and cipher, CA policy, anonymized grant result, source snapshot, pass/fail and deployment-owner review.

The restricted exercise requires CA-verified TLS 1.3 and proves that plaintext and an untrusted CA are rejected. It requires exactly `SELECT` and `UPDATE` on the named outbox table, performs safe allowed operations, and proves `INSERT`, `DELETE`, `ALTER` and cross-table `SELECT` are denied. The environment variables and command are documented in the connector README.

A local pass is evidence for the reference connector, `mysql2` driver and exact MySQL environment exercised. It says nothing about a different database product and does not automatically transfer to a different MySQL version, operating system, host, network, certificate authority, identity system or production configuration. Every relied-upon deployment must repeat the applicable exercise, or record the MySQL connector as not applicable.

Without the opt-in environment variables both tests skip honestly. The dated local evidence record documents the completed reference exercise; deployment-specific evidence remains separate.

Run `npm run qualification:technical` first. Its redacted readiness output confirms only whether both URL variables and the external signer/trust inputs are present; it never emits their values and does not replace either live database exercise. See `docs/G9P-technical-qualification-v1.md`.
