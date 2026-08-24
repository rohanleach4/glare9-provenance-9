# G9P supported deployment and capacity profile v1

## Supported reference topology

The Foundation implementation supports one authoritative ledger-service process using the bundled local-filesystem sealed-storage adapter, plus zero or more separately deployed connectors and the optional self-hosted custody signer. A MySQL connector uses only its dedicated transactional outbox on a Workbench-administered MySQL server. Readers and offline verifiers open copied sealed `.g9p` objects read-only.

The reference `start:ledger` process enforces this topology with a create-only writer lock in its data directory. It never automatically steals an existing lock. Embedded users of `LocalLedger` must supply equivalent exclusive ownership because the library façade does not assume control of the host process lifecycle.

```text
application transaction → provenance_outbox → MySQL connector → one ledger service
                                                              ↓
                                             local sealed storage + local recovery state
                                                              ↓
                                                  offline verifier / backup
```

The ledger and MySQL are independent. Loss of MySQL after a durable accepted receipt does not remove ledger custody. Ledger failure does not authorize the connector to edit or discard an undelivered outbox envelope.

## Unsupported topologies

The reference profile does not currently support active-active ledger writers, shared mutable recovery directories, automatic leader election, transparent multi-region failover, an unqualified remote sealed-storage adapter, or production witness operation. Multiple connector instances may use `SKIP LOCKED`, but production-like database failover and contention still require deployment qualification.

Hosted, customer-hosted and split-custody models remain architectural targets; they are not supported deployment claims until their storage, keys, identity and recovery exercises are approved.

## Capacity envelope

Hard validation ceilings include 65,536 shards, 64 MiB block/segment logical-byte configuration, 100,000 records per segment, 10 million accepted events and 1 GiB aggregate active-block memory. These are parser/configuration safety ceilings, not recommended operating points.

Reference starting policy remains 1 MiB/1,000 records per block, 32 MiB/10,000 records per segment, 30-second maximum age, 100,000 accepted events, 1 GiB accepted bytes and 16 MiB aggregate active-block memory. Operate below 70% of accepted-event, accepted-byte and active-memory capacity; investigate at 70% and stop upstream admission or add capacity before 90%.

The measured workstation baseline achieved about 22 crash-safe accepted events/s and 21 service-sealed events/s for the small synthetic workload. Do not extrapolate this to production. Run `npm run benchmark:performance`, the lifecycle benchmark and connector/database exercises on target hardware with representative evidence.

## Availability objectives

The Foundation single-node profile has no uptime SLA and permits planned downtime. Its priorities are:

1. never acknowledge `accepted` before durable intake completes;
2. fail closed on unverified history, corrupt recovery state or routing ambiguity;
3. apply retryable back-pressure rather than discard accepted work;
4. preserve zero logical-event loss after an acknowledged accepted receipt when the qualified storage durability assumptions hold;
5. rebuild sealed receipts and shard heads entirely from verified history.

Recovery-time and availability targets are deployment policy. Before claiming measured recovery or availability assurance, the deployment owner should measure restart, restore and backlog-clearance time at peak retained volume and record the resulting objectives. The current baseline is evidence only, not an RTO promise.

## Scaling rules

- Increase shard count only through a signed forward-only routing transition.
- Lower block/segment limits for tighter recovery and finality bounds; raise them only after measurement.
- Scale connector instances only after lease contention and database capacity testing.
- Do not weaken file/directory synchronization to meet a throughput target.
- Treat sustained backlog as a capacity or dependency incident, not permission to bypass custody semantics.

No setting in this profile changes permanent `.g9p` verification rules.
