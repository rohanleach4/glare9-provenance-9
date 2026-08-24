# G9P independent review guide v1

## Purpose

Provenance•9 welcomes unpaid community review as well as separately arranged professional review. No reviewer is asked to endorse the Glare•9 business, provide legal advice or accept operational responsibility; the objective is reproducible technical scrutiny of a named source commit.

## Security and cryptographic review

Reviewers should examine:

- the threat boundaries and narrow evidence claim in `G9P-threat-model-v1.md`;
- canonical encoding, domain separation, hashes, Merkle construction, Ed25519 commitments and chain/topology rules;
- hostile-input length/decompression bounds and failure behavior;
- installed key custody, trust bootstrap, rotation, revocation and fail-closed separated custody;
- crash recovery, immutable publication, backup/restore and diagnostic redaction;
- whether residual risks and unsupported claims are stated accurately.

Run at minimum:

```bash
npm ci
npm run test:all
npm run test:coverage
npm run fuzz
npm run scan:repository
npm run audit:dependencies
npm run qualification:pilot
npm run qualification:operations
```

Record the reviewed commit, reviewer identity or stable pseudonym, relevant experience, conflicts of interest, commands/environment, findings by severity and whether every critical/high finding is resolved. A review with findings is useful; approval is recorded only after its critical/high findings are closed or explicitly rejected with public technical evidence.

## External verifier confirmation

An external implementer should consume `conformance/g9p-v1-v2-vectors.json` without importing production code from `src/`. Record language/runtime, source location, commit/release identifier and results for every valid and invalid vector. Confirmation must distinguish structural parsing, cryptographic self-consistency, supplied-key trust and chain completeness.

The repository's second JavaScript verifier is independent of production imports but is not external or cross-runtime. Reusing its source does not close this gate.

## Reporting

Use a public issue or pull request for non-sensitive results. Follow `SECURITY.md` privately for exploitable vulnerabilities and do not attach private keys, credentials, customer evidence or production paths. Maintainers will link accepted reports from the readiness record rather than rewriting reviewer conclusions.
