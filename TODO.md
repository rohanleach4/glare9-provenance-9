# Glare•9 Provenance — Go-Live Checklist

Glare•9 Provenance is experimental and must not be used for production evidence until the applicable items below are complete, reviewed and evidenced. This checklist covers both the open product and the foundations needed by a hosted or supported offering.

## Protocol and product decisions

- [x] Publish the candidate G9P format-version stability and compatibility policy, with final product-owner approval retained as an explicit go-live gate.
- [x] Publish an implementation threat model covering writers, readers, connectors, storage, keys and hostile `.g9p` input, with independent approval retained as an explicit go-live gate.
- [x] Publish language-neutral conformance vectors for valid and precisely invalid version 1/version 2 segments and routing epochs.
- [x] Produce a separately implemented offline verifier with no production-code imports and confirm agreement on every frozen conformance vector.
- [x] Approve the routing-epoch, forward-only resharding and topology-transition protocol in `docs/G9P-routing-epochs-v1.md`.
- [ ] Specify checkpoint, witness-receipt and threshold-attestation formats.
- [ ] Specify key registration, rotation, revocation and customer-controlled event signing.
- [ ] Decide the source-language and public package compatibility policy before the API surface grows.
- [ ] Formally approve an open-source licence and contributor-governance model.

## Ledger durability and storage

- [x] Replace in-memory segment batching with a bounded active-block and active-segment lifecycle.
- [x] Set measured block-size, segment-size and segment-age deployment defaults with the reproducible lifecycle benchmark and sizing record.
- [x] Demonstrate crash safety at every local-filesystem sealing boundary with deterministic state inspection and exactly-once restart recovery, including file and directory synchronisation and create-only promotion; deployment-specific power-loss qualification remains operational work.
- [x] Define recovery behavior for abandoned `.g9p.part` files and interrupted writes.
- [x] Add the sealed-storage contract and local filesystem adapter with create-only publication, bounded reads, opaque-key history reconstruction and storage-neutral byte verification.
- [x] Test exact-byte backup, retention archive and disaster restore with independent verification and receipt reconstruction from fresh storage.
- [x] Stabilise public accepted, provisional and sealed receipt stages with authenticated polling and accepted-first MySQL connector adoption; push notifications remain optional future work.
- [ ] Implement checkpoint publication and independently administered witness operation.
- [x] Define projection and index rebuild procedures entirely from verified ledger history, with fail-closed ordering and reconciliation rules.

## Keys, identity and security

- [ ] Replace development signing-key files with an approved KMS, HSM or customer-controlled key integration.
- [x] Document signer trust bootstrap, forward rotation, revocation and historical verification procedures, including current implementation limits.
- [ ] Add transport TLS and production-grade service identity and authorization controls.
- [ ] Add bearer-token or credential rotation without ingestion downtime.
- [x] Review and test parser, length, allocation and decompression ceilings against denial-of-service threats.
- [x] Remove arbitrary exception text from service and connector diagnostics and test that payload and credential sentinels do not reach logs or HTTP failures.
- [x] Add repeatable repository secret/path and syntax scanning, a zero-finding production dependency audit and scheduled CodeQL/vulnerability CI.

## Sharding and scale

- [x] Benchmark uniform, governance-mix and deliberately hot-subject distributions across 1–16 shards with the public shard-planning tool.
- [x] Define operational criteria for choosing an initial shard count.
- [x] Prevent an in-place shard-count change when a ledger has history but no recorded routing-epoch transition.
- [x] Implement create-only signed routing-epoch descriptor writing and offline verification.
- [x] Integrate signed epoch-zero routing-policy history with ledger storage and startup.
- [x] Add epoch-aware segment version 2 headers and epoch-scoped local storage while retaining version 1 verification.
- [x] Implement crash-safe, topology-neutral durable accepted-event intake and restart recovery.
- [x] Implement the signed routing-transition coordinator and complete old-epoch barrier.
- [x] Implement restart-safe transition recovery and exactly-once new-epoch activation.
- [x] Test hot-shard behavior, bounded back-pressure, multi-shard provisional recovery and serialized concurrent routing-transition barriers with independent segment verification.
- [x] Define cross-shard correlation guarantees without implying unsupported global atomicity.

## Connectors and MySQL

- [ ] Run the opt-in MySQL integration suite against a dedicated non-production database administered through MySQL Workbench.
- [x] Test connector restart, lease expiry, injected database outage recovery, ledger back-pressure and ledger unavailability; production-like database failover qualification remains deployment-specific.
- [x] Add a reusable connector contract test kit for ordering, uncertain-acceptance recovery, permanent-failure quarantine and monotonic receipt reconciliation, adopted by the MySQL worker.
- [ ] Verify least-privilege grants and TLS configuration in a production-like environment.
- [x] Define outbox retention, dead-letter review, byte-identical replay and ledger-reconciliation operating procedures.
- [x] Prove the connector passes customer-defined payload schemas opaquely and depends only on the dedicated outbox contract.

## Verification and quality

- [x] Standardise development and CI on Node.js 24 and npm 11 with enforced engine ranges, `.nvmrc` and lockfile installation.
- [x] Make the aggregate test runner demonstrably fail on every child-suite failure.
- [x] Add GitHub Actions checks for the aggregate unit, service, connector, format and compatibility suites without Docker-based MySQL.
- [x] Enforce reviewed security- and protocol-core coverage floors of 95% lines, 85% branches and 90% functions in CI, with higher measured results recorded.
- [x] Add seeded property-based tests for canonical codecs, routing, restart-stable idempotency and randomized segment invariants.
- [x] Add bounded reproducible fuzzing for canonical decoding, frame and record parsing, decompression and mutated segment/routing evidence.
- [x] Add fault-injection tests for append, compression, sync, promotion, acknowledgement and restart.
- [x] Add a bounded machine-readable performance harness and baseline for accepted ingestion, service and direct sealing, offline verification, verified restart, idempotent replay, compression profiles and in-process connector lag.
- [x] Test retained version 1, epoch-aware version 2 and explicit rejection of unsupported future event and container versions.

## Operations and release

- [x] Define the supported experimental single-writer topology, explicit unsupported topologies, measured capacity guidance and integrity-first availability objectives without claiming an SLA.
- [x] Add minimal liveness, dependency-aware readiness, authenticated aggregate Prometheus metrics and initial alert rules for ledger and connector operation.
- [x] Write evidence-preserving runbooks for key compromise, corrupt storage, missing segments, unimplemented-witness gaps and connector backlog.
- [ ] Define privacy, retention, deletion-reference and customer-content handling policies.
- [x] Produce a consolidated administrator, operator, verifier and incident-response manual linked to the detailed procedures.
- [ ] Establish versioning, changelog, release-signing, SBOM and reproducible-build procedures.
- [ ] Complete a production-readiness review and record approval of every deferred item.
- [ ] Run a non-production pilot and recovery exercise before accepting production evidence.

## Go-live gate

- [ ] No open critical or high-severity security findings.
- [ ] No unresolved format ambiguity affecting independent verification.
- [ ] Recovery, key rotation and full offline verification have been exercised successfully.
- [ ] Production operators have approved the deployment, monitoring and incident runbooks.
- [ ] The product owner has approved the published format stability and compatibility policy and its support lifetime.
- [ ] An independent security reviewer has approved the threat model and cryptographic design, with every critical or high finding resolved.
- [ ] An external implementer or reviewer has confirmed the conformance vectors and independently implemented verifier results.
- [ ] The product owner has explicitly approved production use and its stated assurance level.
