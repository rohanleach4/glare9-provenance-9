# Technical qualification evidence

This directory contains public schemas and non-secret project findings only. Never store database URLs, credentials, certificates, private keys, customer identifiers or generated deployment reports in the repository.

`security-findings.json` is the versioned project register. An empty list means no currently recorded finding; it is not independent-review approval. Add every discovered issue with severity and lifecycle status, and retain resolved entries.

Run the redacted preflight from the repository root:

```bash
npm run qualification:technical
```

To create an external create-only report, pass an ignored path outside the repository:

```bash
npm run qualification:technical -- /absolute/private/path/technical-preflight.json
```

The report never contains configured paths or connection URLs. `readyForLiveExercises` means prerequisites are present and no known critical/high item is open; it does not mean the live tests passed or that an owner approved production use.
