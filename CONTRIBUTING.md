# Contributing

Glare•9 Provenance welcomes design discussion and review while its licence and contributor-governance model remain candidates awaiting formal approval. Do not submit code under an assumed licence grant.

Contributions must preserve schema neutrality, offline verification, deterministic encoding, immutable sealed bytes, bounded hostile-input parsing and MySQL independence. Permanent format changes require a new applicable version, specification updates, language-neutral conformance vectors and agreement across both repository verifiers.

Before proposing a change:

1. open an issue describing the assurance claim and compatibility impact;
2. separate permanent protocol decisions from service-local behavior;
3. avoid customer data, credentials, keys, runtime `.g9p` files and `Global-readme.md`;
4. run `npm run test:all`, `npm run test:coverage` and `npm run scan:repository`;
5. document threat, recovery and operator implications.

No contributor licence agreement or developer certificate of origin is currently approved. Until governance approval, maintainers may review proposals without merging externally contributed code.
