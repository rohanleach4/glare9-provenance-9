# Glare•9 Provenance — Go-Live Checklist

Glare•9 Provenance is experimental and must not be used for production evidence until the applicable items below are complete, reviewed and evidenced. This checklist covers both the open product and the foundations needed by a hosted or supported offering.

## Protocol and product decisions

- [ ] Approve and publish the G9P format-version stability and compatibility policy.
- [ ] Complete an independent threat model covering writers, readers, connectors, storage, keys and hostile `.g9p` input.
- [ ] Publish cross-language conformance vectors for valid and precisely invalid segments.
- [ ] Produce an independent verifier implementation and confirm agreement on the conformance vectors.
- [x] Approve the routing-epoch, forward-only resharding and topology-transition protocol in `docs/G9P-routing-epochs-v1.md`.
- [ ] Specify checkpoint, witness-receipt and threshold-attestation formats.
- [ ] Specify key registration, rotation, revocation and customer-controlled event signing.
- [ ] Decide the source-language and public package compatibility policy before the API surface grows.
- [ ] Formally approve an open-source licence and contributor-governance model.

## Ledger durability and storage

- [x] Replace in-memory segment batching with a bounded active-block and active-segment lifecycle.
- [x] Set measured block-size, segment-size and segment-age deployment defaults with the reproducible lifecycle benchmark and sizing record.
- [ ] Demonstrate crash safety at every sealing step, including file and directory synchronisation and create-only promotion.
- [x] Define recovery behavior for abandoned `.g9p.part` files and interrupted writes.
- [ ] Add a storage abstraction that preserves create-only sealing and independent verification.
- [ ] Test backup, restore, retention and disaster recovery without rewriting sealed bytes.
- [x] Stabilise public accepted, provisional and sealed receipt stages with authenticated polling and accepted-first MySQL connector adoption; push notifications remain optional future work.
- [ ] Implement checkpoint publication and independently administered witness operation.
- [ ] Define projection and index rebuild procedures entirely from verified ledger history.

## Keys, identity and security

- [ ] Replace development signing-key files with an approved KMS, HSM or customer-controlled key integration.
- [ ] Document signer trust bootstrap, rotation, revocation and historical verification procedures.
- [ ] Add transport TLS and production-grade service identity and authorization controls.
- [ ] Add bearer-token or credential rotation without ingestion downtime.
- [ ] Review parser, length, allocation and decompression limits against denial-of-service threats.
- [ ] Confirm that logs, metrics, traces and error responses cannot expose event payloads, credentials or signing material.
- [ ] Complete dependency, secret, static-analysis and vulnerability scanning.
- [ ] Commission an independent security and cryptographic design review before production use.

## Sharding and scale

- [ ] Benchmark representative subject distributions with the shard-planning tool.
- [x] Define operational criteria for choosing an initial shard count.
- [x] Prevent an in-place shard-count change when a ledger has history but no recorded routing-epoch transition.
- [x] Implement create-only signed routing-epoch descriptor writing and offline verification.
- [x] Integrate signed epoch-zero routing-policy history with ledger storage and startup.
- [x] Add epoch-aware segment version 2 headers and epoch-scoped local storage while retaining version 1 verification.
- [x] Implement crash-safe, topology-neutral durable accepted-event intake and restart recovery.
- [x] Implement the signed routing-transition coordinator and complete old-epoch barrier.
- [x] Implement restart-safe transition recovery and exactly-once new-epoch activation.
- [ ] Test hot-shard behavior, back-pressure, shard recovery and multi-shard concurrency.
- [x] Define cross-shard correlation guarantees without implying unsupported global atomicity.

## Connectors and MySQL

- [ ] Run the opt-in MySQL integration suite against a dedicated non-production database administered through MySQL Workbench.
- [ ] Test connector restart, lease expiry, database failover, back-pressure and ledger unavailability under fault injection.
- [ ] Add reusable connector contract tests for ordering, recovery, quarantine and reconciliation.
- [ ] Verify least-privilege grants and TLS configuration in a production-like environment.
- [ ] Define outbox retention, dead-letter review and replay operating procedures.
- [ ] Prove that connector upgrades remain schema-neutral and never require access to customer business tables.

## Verification and quality

- [ ] Standardise development and CI on supported Node.js and npm versions.
- [x] Make the aggregate test runner demonstrably fail on every child-suite failure.
- [ ] Add automated CI checks for unit, service, connector, format and compatibility tests.
- [ ] Set reviewed coverage expectations for security- and protocol-critical code.
- [ ] Add property-based tests for codecs, routing, idempotency and segment invariants.
- [ ] Fuzz canonical decoding, frame parsing, decompression and imported evidence.
- [x] Add fault-injection tests for append, compression, sync, promotion, acknowledgement and restart.
- [ ] Add performance tests for ingestion, sealing, verification, replay, compression and connector lag.
- [ ] Test supported upgrades and explicit rejection of unsupported historical and future versions.

## Operations and release

- [ ] Define supported deployment topologies, capacity limits and availability objectives.
- [ ] Add health, readiness, metrics and alerting suitable for unattended operation.
- [ ] Write runbooks for key compromise, corrupt storage, missing segments, failed witnesses and connector backlog.
- [ ] Define privacy, retention, deletion-reference and customer-content handling policies.
- [ ] Produce administrator, operator, verifier and incident-response documentation.
- [ ] Establish versioning, changelog, release-signing, SBOM and reproducible-build procedures.
- [ ] Complete a production-readiness review and record approval of every deferred item.
- [ ] Run a non-production pilot and recovery exercise before accepting production evidence.

## Go-live gate

- [ ] No open critical or high-severity security findings.
- [ ] No unresolved format ambiguity affecting independent verification.
- [ ] Recovery, key rotation and full offline verification have been exercised successfully.
- [ ] Production operators have approved the deployment, monitoring and incident runbooks.
- [ ] The product owner has explicitly approved production use and its stated assurance level.
