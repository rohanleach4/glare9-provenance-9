# G9P technical qualification evidence profile v1

## Scope

The technical campaign groups customer-controlled segment signing, Workbench-managed MySQL behavior, restricted MySQL TLS identity, security findings and production-security approval. Repository automation can validate prerequisites and test behavior, but it cannot manufacture an approved key custodian, a production-like database or a human authorization.

## Redacted preflight

`npm run qualification:technical` validates the versioned findings register and, when configured, imports the external Ed25519 PKCS#8 segment key, derives its public key ID and confirms that a `trusted` positional binding exists in the external segment trust bundle. It reports only public key/bundle identifiers and counts.

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

The five related TODO gates remain open until the live exercises pass in the named environment, the findings register and external scanner results contain no unresolved critical/high issue, and the production security owner approves the signer custody, trust bundle, TLS identity and evidence record. Presence of a green preflight alone closes none of those gates.
