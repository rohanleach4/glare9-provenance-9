# G9P technical qualification evidence profile v1

## Scope

The technical campaign groups installation-selected custody, Workbench-managed MySQL behavior, restricted MySQL TLS identity, security findings and operator approval. Repository automation can validate prerequisites and test behavior, but it cannot manufacture a production-like database, site-specific recovery result or human authorization.

## Redacted preflight

`npm run qualification:technical` validates the versioned findings register. With `--ledger-env`, it loads the selected installed custody profile, verifies all three public identities against the installation manifest and reports only the custody mode, installation identifier and public key IDs. Development compatibility may still qualify an external segment key against a positional trust bundle.

```bash
npm run qualification:technical -- --ledger-env /srv/glare9-provenance/ledger.env
```

The report records booleans for `MYSQL_INTEGRATION_URL` and `MYSQL_QUALIFICATION_URL`; it never reads their values into output. It records Git commit/cleanliness, open finding counts, prerequisite readiness and `approvalsRecorded: false`. Generated reports belong in an ignored evidence store outside the repository.

## Live exercises

After the preflight is ready, run both existing connector commands against dedicated non-production databases administered through MySQL Workbench:

```bash
npm run test:integration --workspace=@glare9/provenance-connector-mysql
npm run test:qualification --workspace=@glare9/provenance-connector-mysql
```

The first identity may create and drop only its unique test table. The second is read-only apart from the connector's required `SELECT`/`UPDATE` grants and must negotiate TLS. Docker-based MySQL is prohibited.

Then run `npm run audit:dependencies`, `npm run scan:repository`, `npm run fuzz`, `npm run test:coverage` and the complete suite. Archive outputs, commit, server version, anonymized TLS/grant result, signer/trust-bundle IDs and operator time externally.

## Closure rule

The live deployment gates remain open until the exercises pass in the named environment, the findings register and current scans contain no unresolved critical/high issue, and the responsible operators approve custody, any trust bundle, TLS identity and the evidence record. Presence of a green preflight alone closes none of those gates.
