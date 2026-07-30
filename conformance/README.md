# G9P conformance vectors

`g9p-v1-v2-vectors.json` is a language-neutral JSON manifest containing base64-encoded sealed objects, exact expected commitments and declarative invalid mutations. It contains public keys and signatures but no private key material.

Consumers must:

1. base64-decode a valid vector exactly;
2. confirm its ordinary SHA-256 value before verification;
3. verify every expected semantic and cryptographic result;
4. apply invalid mutations literally and reject them;
5. distinguish the precise reference error code from the portable failure category.

Portable categories are `FORMAT`, `CANONICAL`, `RESOURCE_LIMIT`, `SEMANTIC`, `COMMITMENT`, `COMPRESSION`, `IDENTITY` and `SIGNATURE`. Implementations may use different local error names, but must reject at the recorded assurance layer or earlier. A parser crash, hang or unbounded allocation is never a conforming rejection.

The generator creates fresh ephemeral Ed25519 keys in memory and commits only sealed public artifacts. Regeneration changes signed bytes and therefore requires deliberate review:

```bash
npm run conformance:generate
```

Run both repository verifiers over the frozen vectors with:

```bash
npm run conformance:test
```
