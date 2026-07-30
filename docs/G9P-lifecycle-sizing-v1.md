# G9P Lifecycle Sizing Record Version 1

## Status and purpose

This document records the first measured deployment defaults for bounded G9P active blocks and segments. These values are reference-service policy, not G9P container-format constants.

The benchmark is reproducible with:

```bash
npm run benchmark:lifecycle
```

For the complementary accepted-ingestion, restart, replay and connector measurements, see [`G9P-performance-baseline-v1.md`](./G9P-performance-baseline-v1.md) and `npm run benchmark:performance`.

The command creates temporary epoch-aware version 2 segments outside the repository, verifies every segment offline, emits machine-readable JSON to standard output and removes its temporary files. It is intentionally separate from the deterministic default test suite.

## Workload profiles

Two deterministic synthetic profiles prevent a single unusually compressible fixture from deciding policy:

- `governance-json`: structured governance evidence with repeated policy, control and regional context; approximately 3 KiB per event.
- `high-entropy`: opaque base64 material and digest fields representing encrypted content, signatures and content references; approximately 3 KiB per event.

The block sweep compares 256 KiB, 1 MiB and 4 MiB blocks in a 32 MiB logical segment. The segment sweep compares 8 MiB, 32 MiB and 64 MiB logical segments using 1 MiB blocks. A one-record run measures low-volume sealing cost separately from throughput.

Logical byte targets count uncompressed canonical framed-record bytes. Stored sizes reflect exact compressed G9P container bytes.

## Measurement environment

The recorded run was performed on 30 July 2026 with:

```text
Node.js              v24.4.1
Operating system     Darwin x64
Processor            Intel Core i5-7600K at 3.80 GHz
Logical CPUs         4
```

Results are a sizing baseline, not a cross-platform performance guarantee. Hosted and customer deployments must rerun the benchmark on representative hardware and payloads before raising limits.

## Block-size results

All rows use approximately 32 MiB of logical records.

| Profile | Block target | Blocks | Stored/logical | Write MiB/s | Verify MiB/s |
|---|---:|---:|---:|---:|---:|
| Governance JSON | 256 KiB | 129 | 0.0063 | 13.410 | 10.885 |
| Governance JSON | 1 MiB | 33 | 0.0040 | 13.570 | 16.431 |
| Governance JSON | 4 MiB | 8 | 0.0032 | 17.636 | 18.851 |
| High entropy | 256 KiB | 130 | 0.6938 | 12.400 | 17.069 |
| High entropy | 1 MiB | 33 | 0.6902 | 16.421 | 19.814 |
| High entropy | 4 MiB | 9 | 0.6901 | 14.534 | 13.786 |

No candidate produced a consistent throughput win for both profiles. A 1 MiB block reduces a 32 MiB segment to approximately 33 independently retrievable blocks, avoids the 129–130-frame overhead of 256 KiB blocks and retains four-times finer bounded access than 4 MiB blocks. The small additional compression gain at 4 MiB does not justify the coarser access unit as the default.

## Segment-size results

All rows use 1 MiB blocks.

| Profile | Logical target | Write latency | Verify latency | Write MiB/s | Verify MiB/s |
|---|---:|---:|---:|---:|---:|
| Governance JSON | 8 MiB | 608 ms | 407 ms | 13.148 | 19.679 |
| Governance JSON | 32 MiB | 1,619 ms | 1,682 ms | 19.769 | 19.030 |
| Governance JSON | 64 MiB | 3,215 ms | 3,351 ms | 19.907 | 19.096 |
| High entropy | 8 MiB | 639 ms | 367 ms | 12.515 | 21.777 |
| High entropy | 32 MiB | 1,910 ms | 1,550 ms | 16.751 | 20.639 |
| High entropy | 64 MiB | 3,949 ms | 3,624 ms | 16.206 | 17.659 |

The 32 MiB target retains most observed throughput while bounding one segment's sealing and verification work to roughly 1.5–1.9 seconds on the measurement host. The 64 MiB target raises individual failure-recovery and verification work to approximately 3.2–3.9 seconds without a high-entropy throughput benefit. The 8 MiB target remains appropriate for deployments that value lower seal latency over file-count overhead.

## Segment-age result

One-record segments measured:

| Profile | Logical bytes | Write latency | Verify latency |
|---|---:|---:|---:|
| Governance JSON | 3,888 | 281 ms | 9 ms |
| High entropy | 4,561 | 149 ms | 2 ms |

Age is primarily a finality policy rather than a compression constant. A 30-second default bounds low-volume accepted-to-sealed delay more tightly than the former 60-second assumption while remaining more than two orders of magnitude above measured one-record sealing cost. High-volume streams normally seal earlier on byte or record limits.

## Approved reference defaults

```text
PROVENANCE_BLOCK_MAX_BYTES=1048576
PROVENANCE_BLOCK_MAX_RECORDS=1000
PROVENANCE_SEGMENT_MAX_BYTES=33554432
PROVENANCE_SEGMENT_MAX_RECORDS=10000
PROVENANCE_SEGMENT_MAX_AGE_MS=30000
```

The byte limits count uncompressed canonical framed-record bytes. Record limits remain independent safety boundaries for very small events. Operators should lower limits for tighter recovery/finality objectives and raise them only after representative measurement confirms acceptable memory, sealing, verification and random-access behaviour.
