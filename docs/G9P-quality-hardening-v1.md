# G9P quality hardening profile v1

Status: deterministic implementation assurance profile. It changes no G9P container bytes.

## Coverage expectations

The security- and protocol-critical core under `src/` must maintain at least:

| Measure | Required minimum | Current measured result |
|---|---:|---:|
| Lines | 95% | 97.70% |
| Branches | 85% | 92.20% |
| Functions | 90% | 95.56% |

`npm run test:coverage` uses Node.js 24 native coverage and exits non-zero below either gate. The protocol core enforces 95% lines, 85% branches and 90% functions. Installation and custody code separately enforces 85% lines, 70% branches and 75% functions so operational security code cannot be diluted by protocol coverage. CI runs both after the aggregate suite. These are floors, not permission to leave a particular cryptographic, parsing or custody branch untested; new critical behavior still requires explicit success, rejection and recovery cases.

Generated CLI, connector and service orchestration code is not folded into the core percentage merely to change the denominator. Their behavior remains covered by their own unit, integration, contract and fault suites.

## Deterministic property testing

The property suites use a small committed pseudorandom generator with explicit seeds and no runtime dependency. A failure reports its iteration or uses stable generated identities, allowing exact reproduction.

Current properties establish:

- 750 nested canonical values decode and re-encode to exactly the same bytes;
- 2,000 routing cases are deterministic, remain within the configured shard range and produce the canonical shard identity;
- randomized record counts, block targets and block-record limits preserve event order, block bounds, segment hashes and repeatable offline verification;
- 30 generated events retain one identity and record hash across concurrent repeated batches, sealing, restart and reverse-order replay.

Property testing complements fixed conformance vectors. Generated cases do not redefine the format and must not replace reviewable known-answer fixtures.

## Bounded fuzzing

`npm run fuzz` exercises canonical decoding, frame parsing, record framing, Zstandard decompression, segment import and routing-epoch import. Defaults are:

```text
G9P_FUZZ_SEED=4028768294
G9P_FUZZ_ITERATIONS=500
```

The iteration count is bounded from 1 to 100,000. Override both values to reproduce or extend a run:

```bash
G9P_FUZZ_SEED=12345 G9P_FUZZ_ITERATIONS=10000 npm run fuzz
```

Every arbitrary input is capped at 256 bytes, canonical collection depth and size are reduced, frame and imported-object limits are explicit, and decompression output is capped at 512 bytes. A hostile input may be accepted only if it is valid; otherwise it must fail with the controlled `G9pError` boundary rather than an unrelated exception.

Each run also creates one valid signed segment and routing descriptor, verifies both, and applies 96 deterministic single-bit mutations to each. No mutated evidence may verify.

The bounded fuzz suite runs in the aggregate tests and scheduled security workflow. It is not a substitute for long-running coverage-guided native fuzzing, memory instrumentation or an independent hostile-input review.

## CI policy

Pull requests and `main` execute the complete suite and enforce core coverage. The security workflow executes repository scanning, dependency audit, bounded fuzzing and CodeQL. Seed and iteration diagnostics are printed with fuzz results so a CI failure can be replayed locally.

## Format impact

None. The PRNG, properties, fuzz runners and coverage thresholds are test and CI infrastructure. Canonical encoding, hashes, routing, signatures and `.g9p` versions are unchanged.
