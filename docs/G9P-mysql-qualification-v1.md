# G9P MySQL deployment qualification v1

Two opt-in exercises remain environment evidence rather than deterministic CI. `MYSQL_INTEGRATION_URL` uses a dedicated non-production administrative test identity to create/drop a uniquely named table and exercise leasing, delivery, retry and dead-letter behavior. `MYSQL_QUALIFICATION_URL` uses the real restricted connector identity read-only to confirm TLS and inspect `SHOW GRANTS`.

Both databases must be administered through MySQL Workbench. Docker is prohibited. Credentials remain external and must never appear in logs, commits or evidence. Record server/version, TLS cipher/CA policy, anonymized grant result, test commit, pass/fail and operator approval.

The current environment has neither URL configured, so both tests skip honestly. The TODO entries remain open until the project owner supplies the dedicated non-production connections and the exercises pass.

Run `npm run qualification:technical` first. Its redacted readiness output confirms only whether both URL variables and the external signer/trust inputs are present; it never emits their values and does not replace either live database exercise. See `docs/G9P-technical-qualification-v1.md`.
