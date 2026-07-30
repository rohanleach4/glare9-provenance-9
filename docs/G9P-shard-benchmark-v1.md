# G9P shard-distribution benchmark v1

## Reproduce

From the repository root on Node.js 24:

```bash
npm run benchmark:shards
```

The benchmark calls the public `planShardAssignments` implementation used by the planning CLI. It routes 20,000 deterministic subject occurrences across 1, 2, 4, 8 and 16 shards and emits JSON containing occupancy, hottest-to-mean ratio, coefficient of variation and planning throughput.

Profiles are:

- `uniform-entities`: 20,000 unique generic entity subjects.
- `governance-mix`: 20,000 unique model, policy and control subjects in a 60/30/10 mix.
- `hot-subject-80-percent`: one subject represents 80% of occurrences and 4,000 subjects form the long tail.

## Reference measurement

Measured 30 July 2026 using Node.js 24.4.1 on Darwin x64, Intel i5-7600K, four logical CPUs.

| Profile | Shards | Min | Max | Hottest / mean | Coefficient of variation |
| --- | ---: | ---: | ---: | ---: | ---: |
| Uniform entities | 2 | 9,996 | 10,004 | 1.0004 | 0.0004 |
| Uniform entities | 4 | 4,974 | 5,030 | 1.0060 | 0.0050 |
| Uniform entities | 8 | 2,441 | 2,565 | 1.0260 | 0.0169 |
| Uniform entities | 16 | 1,196 | 1,307 | 1.0456 | 0.0259 |
| Governance mix | 2 | 9,989 | 10,011 | 1.0011 | 0.0011 |
| Governance mix | 4 | 4,953 | 5,036 | 1.0072 | 0.0064 |
| Governance mix | 8 | 2,432 | 2,560 | 1.0240 | 0.0182 |
| Governance mix | 16 | 1,174 | 1,310 | 1.0480 | 0.0242 |
| 80% hot subject | 2 | 2,010 | 17,990 | 1.7990 | 0.7990 |
| 80% hot subject | 4 | 986 | 16,998 | 3.3996 | 1.3854 |
| 80% hot subject | 8 | 486 | 16,497 | 6.5988 | 2.1162 |
| 80% hot subject | 16 | 236 | 16,243 | 12.9944 | 3.0970 |

Unique representative subjects distribute evenly at every tested shard count. Adding shards does not divide one hot subject because deterministic subject routing intentionally preserves locality. A deployment facing a dominant subject must change its semantic subject granularity through an approved event design or isolate it in a separate ledger; increasing shard count alone is not a remedy.

The benchmark is a deterministic planning measurement, not an ingestion throughput or concurrency test. Hot-shard service behavior and multi-shard concurrency remain separate TODO work.
