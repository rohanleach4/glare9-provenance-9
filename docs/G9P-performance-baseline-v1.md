# G9P end-to-end performance baseline v1

## Status and purpose

This record covers the first combined performance harness for accepted-first ingestion, service sealing, direct segment sealing, offline verification, verified restart, idempotent replay, Zstandard compression and connector lag.

Run it with:

```bash
npm run benchmark:performance
```

The command writes all temporary intake, routing, segment and connector state outside the repository, verifies its results, emits JSON and removes the temporary files. Results are deployment evidence, not protocol constants or service-level objectives.

## Workload

The default bounded profile uses:

```text
250 schema-neutral governance events
50 events per ingestion or connector batch
4 epoch-zero shards
50 records per active block
100 records per active segment
4 MiB compression inputs repeated 5 times
```

Override the bounded workload when measuring representative hardware:

```bash
G9P_PERFORMANCE_EVENTS=5000 \
G9P_PERFORMANCE_BATCH_SIZE=100 \
G9P_PERFORMANCE_COMPRESSION_BYTES=16777216 \
G9P_PERFORMANCE_COMPRESSION_ROUNDS=10 \
npm run benchmark:performance
```

The benchmark rejects event, batch, byte and round settings outside explicit safety ranges.

## Measurement environment

The recorded run was performed on 30 July 2026:

```text
Node.js              v24.4.1
Operating system     Darwin x64
Processor            Intel Core i5-7600K at 3.80 GHz
Logical CPUs         4
Memory                40 GiB
```

This was a single run on a development workstation. Values will vary with filesystem sync behavior, storage media, CPU frequency, competing load and event content.

## Recorded results

### Compression

| Profile | Stored/input | Compress MiB/s | Decompress MiB/s |
|---|---:|---:|---:|
| Repetitive governance text | 0.00011 | 1,384.649 | 351.606 |
| Deterministic high entropy | 1.00003 | 320.426 | 603.206 |

The deliberately repetitive profile is a compression best case. The high-entropy profile is the meaningful conservative bound for encrypted content, signatures and opaque references.

### Direct G9P segment path

The 250 events represented 278,306 logical framed bytes and produced one 4,273-byte, three-block segment.

| Operation | Latency | Events/s | Logical MiB/s |
|---|---:|---:|---:|
| Seal, compress and sign | 109.800 ms | 2,276.859 | 2.417 |
| Offline verify and decode | 35.875 ms | 6,968.709 | 7.398 |

This small segment is latency-dominated; it is not comparable to the larger lifecycle-sizing sweep.

### Reference ledger service lifecycle

| Operation | Latency | Events/s |
|---|---:|---:|
| Crash-safe accepted intake | 11,384.734 ms | 21.959 |
| Route, seal four shards and retire intake | 12,024.377 ms | 20.791 |
| Restart and rebuild from verified history | 67.117 ms | 3,724.841 |
| Reverse-order idempotent replay | 33.616 ms | 7,436.916 |

The large gap between direct segment sealing and service ingestion is expected from the current durability profile: each accepted event receives its own create, file synchronization, promotion and directory synchronization sequence, and each sealed event retires its intake state durably. These measurements identify service-local filesystem synchronization as the next performance investigation; they do not justify weakening accepted-custody guarantees.

Any batching optimization must preserve independently durable accepted identity, bounded recovery, routing-transition barriers and exactly-once restart behavior. It would not require a `.g9p` format change.

### Connector lower bound

The in-process MySQL worker state machine delivered five batches through a memory repository and in-process accepted-receipt client:

```text
Elapsed             18.838 ms
Throughput          13,270.883 events/s
Lag p50             12.000 ms
Lag p95             18.939 ms
Lag maximum         18.939 ms
```

This isolates envelope validation, batching, receipt construction and worker state transitions. It excludes MySQL transactions, `SKIP LOCKED`, HTTP/TLS, network delay, ledger durability and the configured polling interval. It is a lower bound, not an operational connector-lag claim. Production-like connector lag must be measured against the dedicated Workbench-managed non-production database and deployed ledger endpoint.

## Interpretation and use

- Use the direct segment results to detect large cryptographic, compression or verifier regressions.
- Use accepted ingestion and service sealing to assess filesystem durability costs.
- Use verified restart and replay to size recovery windows.
- Use the high-entropy compression profile for conservative storage and CPU planning.
- Use the connector phase to detect worker overhead regressions only; measure actual connector lag in the target deployment.

No fixed pass/fail performance threshold is committed yet. A threshold requires repeated measurements on the supported deployment topology, variance analysis and an approved capacity or availability objective. Correctness assertions still fail the benchmark immediately if events, receipts, blocks, restart state or compressed bytes disagree.

## Format impact

None. The harness consumes the existing public core, ledger service and MySQL worker. It changes no canonical bytes, routing behavior, segment commitments, signatures or `.g9p` versions.
