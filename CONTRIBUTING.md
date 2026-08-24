# Contributing

Provenance•9 welcomes design discussion, review, documentation and code contributions under Apache License 2.0. Contributions use the Developer Certificate of Origin 1.1 in `DCO.txt`; no contributor licence agreement is required.

Contributions must preserve schema neutrality, offline verification, deterministic encoding, immutable sealed bytes, bounded hostile-input parsing and MySQL independence. Permanent format changes require a new applicable version, specification updates, language-neutral conformance vectors and agreement across both repository verifiers.

Before proposing a change:

1. open an issue describing the assurance claim and compatibility impact;
2. separate permanent protocol decisions from service-local behavior;
3. avoid customer data, credentials, keys, runtime `.g9p` files and `Global-readme.md`;
4. run `npm run test:all`, `npm run test:coverage` and `npm run scan:repository`;
5. document threat, recovery and operator implications.

Every commit must carry a sign-off certifying the DCO:

```text
Signed-off-by: Your Name <your-email@example.com>
```

Use `git commit -s` to add it. Do not submit code you do not have the right to license. Contributions are public and may be retained in repository history. The governance and brand boundaries are described in `GOVERNANCE.md` and `TRADEMARKS.md`.
