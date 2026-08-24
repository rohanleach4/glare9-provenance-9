# Provenance•9 local MySQL qualification — 24 August 2026

## Result

**Local MySQL TLS and least-privilege qualification passed.**

This result qualifies the Provenance•9 MySQL connector against the exact isolated local environment and source snapshot described below. It is not a general database certification and is not production-deployment approval.

## Environment and source snapshot

- MySQL Community Server `8.4.2`, using a disposable data directory and loopback-only TCP listener.
- Server policy: `require_secure_transport=ON`; permitted protocol restricted to TLS 1.3.
- Client: repository `mysql2` dependency through the connector integration tests.
- Trust: disposable local CA trusted explicitly by the test client; a separately generated untrusted CA used for the rejection check.
- Working tree based on Git commit `a6828fd9e2c184d194d7cfb215275c089347ba32`.
- `connectors/mysql/test/mysql.integration.test.js`: SHA-256 `77c95a3ecd03c11438bf0b6df75f69b2ac3a968941211ed28ae15611bc6d68e2`.
- `connectors/mysql/test/mysql-qualification.integration.test.js`: SHA-256 `c1c8ec224bc89edd130a1a6474615c979ccf247ad09b10069d20ccea99252fc8`.
- `connectors/mysql/sql/001_provenance_outbox.sql`: SHA-256 `e3b27d0074c97687ffe5f1333429771d3e22d1abfda94b5919269c1f0ee37ccd`.

The source was an uncommitted qualification working tree. The hashes bind this record to the exercised test and schema content; qualification should be repeated after material connector, schema, driver or environment changes.

## Observed transport and grants

- Negotiated protocol: `TLSv1.3`.
- Negotiated cipher: `TLS_AES_128_GCM_SHA256`.
- Global privileges: `USAGE` only.
- Table privileges: `SELECT, UPDATE` only on the dedicated `provenance_outbox` table.
- The connector account was created with `REQUIRE SSL`.

Database names and account credentials were disposable. No password, key or private certificate is retained in this record.

## Exercises

The real-database integration exercise passed leasing, delivery, durable accepted-receipt storage, permanent-failure handling and dead-letter behavior against MySQL.

The restricted-identity qualification passed all of the following:

1. connection with the trusted CA;
2. TLS 1.3 and a non-empty cipher;
3. exact-table `SELECT`;
4. exact-table no-op `UPDATE`;
5. denial of `INSERT`;
6. denial of `DELETE`;
7. denial of `ALTER TABLE`;
8. denial of `SELECT` on a separate sentinel table;
9. rejection of plaintext TCP using the otherwise valid identity; and
10. rejection when the client trusted an unrelated CA.

The first integration attempt exposed a timezone-dependent schema defect: `available_at` and `created_at` defaulted to session-local `CURRENT_TIMESTAMP`, while connector comparisons use `UTC_TIMESTAMP`. In a Europe/London environment, a new row was not immediately leaseable. Both defaults were changed to explicit `UTC_TIMESTAMP(6)`, and the integration and restricted-identity exercises then passed.

## Limits and transferability

This evidence does not qualify PostgreSQL, MariaDB, SQLite, SQL Server or any other database connector. It also does not automatically qualify another MySQL version, operating system, driver, server host, network path, certificate authority, certificate identity policy, secret store, account-provisioning process, failover system or production deployment.

The local certificate check verifies the explicitly trusted CA, not a production hostname or public/private organisational PKI policy. Availability, failover, sustained load, certificate issuance/rotation/revocation and operator response were outside this exercise.

If a deployment uses this MySQL connector, repeat the applicable integration and restricted-identity exercises in that deployment's non-production environment. If it does not use this connector, record the MySQL-specific gate as not applicable rather than treating this local result as evidence for another database.
