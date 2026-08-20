# Glare•9 Provenance Ledger Service

This workspace exposes the authenticated ingestion boundary for database connectors. It durably retains versioned events before routing and manages bounded active blocks and segments. Contract version 1 seals synchronously; stable contract version 2 accepts first, allows segments to span requests and supports authenticated receipt polling.

## Configure

Copy `.env.example` to the ignored `.env` file and set a long random bearer token:

```bash
cp services/ledger/.env.example services/ledger/.env
```

The local service generates separate development Ed25519 segment-signing and topology-authority keys under its ignored data directory. That key store is not suitable for production. An external Ed25519 PKCS#8 segment key can instead be selected with `PROVENANCE_SEGMENT_SIGNING_KEY_PATH`.

Forward segment-key rotation uses `PROVENANCE_SEGMENT_TRUST_BUNDLE_PATH`, pointing to an external approved JSON bundle described in [`docs/G9P-signer-trust-operations-v1.md`](../../docs/G9P-signer-trust-operations-v1.md). Bindings assign old and successor key IDs to exact ledger/epoch/shard/segment ranges. Startup revalidates historical positions, and sealing rejects a current key outside its approved range. Bundle authentication and approval remain external operational responsibilities.

The core writers also accept an asynchronous callback-only Ed25519 signer without access to a private-key object. This is the provider-neutral boundary for KMS, HSM and customer-controlled adapters; see [`docs/G9P-signing-provider-contract-v1.md`](../../docs/G9P-signing-provider-contract-v1.md). The runnable service still loads local or external PKCS#8 files until a deployment-specific adapter is selected and qualified.

For credential rotation, configure the new token first and retained old token second in `PROVENANCE_API_TOKENS`; administration uses the separate `PROVENANCE_ADMIN_TOKENS` set. Certificate/key paths enable TLS 1.3, while a client CA plus `PROVENANCE_TLS_REQUIRE_CLIENT_CERTIFICATE=true` enables mutual TLS. Private keys and credentials remain external ignored secrets. See [`docs/G9P-transport-identity-v1.md`](../../docs/G9P-transport-identity-v1.md).

## Run

From the repository root:

```bash
npm run start:ledger
```

`start:ledger` acquires `.ledger-writer.lock` create-only in `PROVENANCE_DATA_DIR` before opening ledger recovery state. A second service using the same directory fails immediately. The lock is removed only after clean shutdown. After an unclean exit, confirm by process/service-manager inspection that no writer remains, preserve the lock contents with the incident record, and remove only that exact lock file before restart. Never automate lock stealing from PID liveness alone.

Default endpoints:

```text
GET  /health
GET  /ready
GET  /metrics
GET  /v1/info
POST /v1/events:batch
POST /v2/events:batch
GET  /v2/receipts/<event-id>?recordHash=<expected-record-hash>
POST /v1/admin/routing-transitions
POST /v1/admin/checkpoints
```

`/v1/info`, `/metrics` and ingestion require the configured bearer token. `/health` is process liveness; `/ready` fails after a recorded background ledger error. Metrics are aggregate Prometheus text without customer-controlled labels. Event submissions are idempotent by `eventId` and canonical event content. See [`docs/G9P-observability-v1.md`](../../docs/G9P-observability-v1.md).

## Durable accepted-event intake

Before an event is assigned to a routing epoch or shard, the service writes a canonical ordered intake record under `intake/`. It synchronises the record, promotes it without replacing another record, and synchronises the intake directory before the event can enter the accepted state. Intake records are local service recovery state, not sealed `.g9p` evidence files.

After the applicable segment is sealed, the corresponding intake record is retired. On startup, the service strictly decodes and validates every retained record, removes records already represented by verified sealed history, promotes complete provisional records left by an interrupted write, and resumes sealing the remainder exactly once by event identity and canonical content. An invalid pre-acknowledgement partial is discarded with a redacted `INTAKE_PART_DISCARDED` recovery warning.

The public version 1 HTTP contract continues to drain accepted events synchronously and return `sealed` receipts. The `accepted` stage is intentionally topology-neutral so a routing-transition barrier can retain arrivals without assigning them to either the old or new epoch. Contract version 2 exposes accepted and provisional lifecycle receipts explicitly.

## Bounded active lifecycle

The version 2 endpoint returns HTTP 202 after durable intake and does not force an immediate seal. Accepted events are routed into one active segment per `(ledger, routing epoch, shard)`. Each stream has one bounded in-memory active block. When its byte or record limit is reached, the block is compressed and its exact compressed bytes, commitments and intake references are synchronised in service-local provisional state.

An active segment seals when it reaches its configured byte limit, record limit or age. Completed block boundaries and compressed bytes are preserved in the final `.g9p` segment. On restart, provisional blocks are strictly decoded, decompressed and reconciled byte-for-byte with durable intake before they can be sealed. Retained intake remains authoritative until the final segment has been promoted and verified.

Lifecycle configuration defaults:

```text
PROVENANCE_BLOCK_MAX_BYTES=1048576
PROVENANCE_BLOCK_MAX_RECORDS=1000
PROVENANCE_SEGMENT_MAX_BYTES=33554432
PROVENANCE_SEGMENT_MAX_RECORDS=10000
PROVENANCE_SEGMENT_MAX_AGE_MS=30000
PROVENANCE_MAX_ACCEPTED_EVENTS=100000
PROVENANCE_MAX_ACCEPTED_BYTES=1073741824
PROVENANCE_MAX_ACTIVE_BLOCK_BYTES=16777216
```

The block and segment byte limits count uncompressed canonical framed-record bytes, making admission decisions possible before compression; final stored sizes vary with Zstandard output. These are deployment-policy starting points, not G9P format constants. Intake capacity and single-record active-memory fit are checked before new events are accepted. A full intake or active-memory budget returns retryable `LEDGER_BACKPRESSURE`; already accepted events are retained and never discarded to relieve pressure.

The block, segment and age defaults are supported by the reproducible measurements in [`docs/G9P-lifecycle-sizing-v1.md`](../../docs/G9P-lifecycle-sizing-v1.md). Run `npm run benchmark:lifecycle` on representative deployment hardware before raising them.

The deterministic shard-resilience suite proves aggregate active-memory bounding under a hot subject, cooler-shard progress, exact concurrent intake admission, multi-shard provisional recovery and the serialized routing-transition barrier. It does not claim parallel mutation within one service process. See [`docs/G9P-shard-resilience-v1.md`](../../docs/G9P-shard-resilience-v1.md).

Receipt states are:

- `accepted`: durable topology-neutral intake exists.
- `provisional`: the record is in a completed, synchronised active block but has no final segment hash.
- `sealed`: the record is included in a verified final `.g9p` segment.

Every version 2 receipt contains `eventId`, `status`, `ledgerId` and the canonical `recordHash`. Accepted receipts additionally contain `intakeSequence` and `acceptedAt`. Provisional receipts retain those acceptance fields and add the routing epoch, shard, segment, block and record positions plus `openedAt`. Sealed receipts contain the routing epoch, shard, segment and record positions, exact segment hash and signer key identity.

Poll receipt state with a percent-encoded event ID and the expected lowercase record hash:

```text
GET /v2/receipts/event-123?recordHash=<64 lowercase hexadecimal characters>
```

The lookup is authenticated and idempotent. Unknown events return `RECEIPT_NOT_FOUND` with HTTP 404. A known event ID paired with a different record hash returns `EVENT_ID_CONFLICT` with HTTP 409. State does not move backwards: a synchronised provisional block is recovered or sealed after restart, and sealed receipts are rebuilt from verified history. Polling is the stable notification mechanism in this version; no push callback is implied.

A durable `accepted` receipt transfers custody to the ledger. The MySQL connector therefore stores the returned version 2 receipt and marks its outbox row delivered without waiting for segment age or size sealing. Final sealed state remains available through receipt polling.

The exact public contract is specified in [`docs/G9P-ingestion-receipts-v2.md`](../../docs/G9P-ingestion-receipts-v2.md).

`PROVENANCE_SHARD_COUNT` establishes epoch zero for new ledgers and must match an existing epoch-zero-only ledger. Once a signed transition exists, that ledger's active descriptor is authoritative.

Before writing a ledger's first segment, the service creates a signed epoch-zero descriptor under `routing/<ledger-directory>/epoch-000000000000.g9p`. Startup verifies that descriptor with the local topology-authority identity and derives the ledger's permitted routing policy from it. New ledgers store epoch-aware version 2 segments under `segments/<ledger-directory>/epoch-000000000000/shard-0000/`; every segment authenticates the epoch number and exact descriptor hash.

Immutable routing descriptors and segments are accessed through the sealed-storage contract. The bundled `LocalFilesystemSealedStorage` preserves these paths and remains the default. Embedded service deployments may inject another implementation into `LocalLedger`; it must provide create-only atomic publication, bounded exact-byte reads, deterministic final-key listing and its own incomplete-publication recovery. Durable intake, active-block state and development keys remain separate local service state. See [`docs/G9P-sealed-storage-v1.md`](../../docs/G9P-sealed-storage-v1.md).

Exact-byte backup/restore is specified in [`docs/G9P-backup-recovery-v1.md`](../../docs/G9P-backup-recovery-v1.md). Startup index reconstruction and external projection replay are specified in [`docs/G9P-projection-rebuild-v1.md`](../../docs/G9P-projection-rebuild-v1.md).

Legacy version 1 history without a descriptor fails closed by default. For one reviewed migration startup, set `PROVENANCE_ADOPT_LEGACY_ROUTING_HISTORY=true` to create an epoch-zero adoption descriptor after all existing segments pass verification. Disable the option again after migration. Sealed segment bytes are never changed.

## Routing transitions

Routing administration is disabled unless `PROVENANCE_ADMIN_TOKEN` is configured with a separate secret of at least 16 characters. The ingestion token cannot authorize topology changes.

Submit an explicitly expected current epoch, new shard count and reviewable reason:

```bash
curl -X POST http://127.0.0.1:8787/v1/admin/routing-transitions \
  -H "Authorization: Bearer $PROVENANCE_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "contractVersion": 1,
    "ledgerId": "governance-ledger",
    "expectedCurrentEpoch": 0,
    "shardCount": 4,
    "reason": "Increase measured write and verification concurrency"
  }'
```

The coordinator drains all earlier accepted events under the old policy, captures a complete old-shard head set, publishes and verifies the signed next-epoch descriptor, and then activates new epoch-scoped streams. Retrying the same requested transition after an uncertain response returns the already-active descriptor. Startup verifies every transition head before resuming retained intake under the published active epoch.

Abandoned segment and routing `.g9p.part` files are explicitly provisional and are discarded on startup. Completed active-block state is recovered separately and must match durable intake exactly; otherwise startup fails closed. Complete durable-intake provisional records are promoted and recovered. Final `.g9p` files remain create-only and authoritative. If sealing succeeded before provisional cleanup, verified sealed history wins and stale active state is retired.

The automated fault-injection suite interrupts intake append, compression, file and directory synchronisation, promotion, acknowledgement and both sides of routing-epoch publication. It then rebuilds the ledger from disk and checks exact event and epoch uniqueness.

## Checkpoint publication

Checkpoint administration uses the same separately configured administration credential but a distinct development checkpoint-publisher key. `POST /v1/admin/checkpoints` accepts exact fields `contractVersion` and `ledgerId`, drains and seals retained events, records the current head or explicit emptiness of every shard in the active routing epoch, links the previous checkpoint and publishes a create-only `.g9p` checkpoint. Checkpoints are stored under `checkpoints/<ledger-directory>/checkpoint-<number>.g9p` and are independently verifiable with `npm run verify:checkpoint`.

The separately deployable reference witness is documented in [`services/witness/README.md`](../witness/README.md). Witness receipts remain separate evidence and do not change an event's ingestion receipt state.

## Current limitations

- Contract version 1 waits for sealing. Version 2 uses polling and does not yet provide push notifications or project witnessed finality into per-event receipts.
- Local filesystem storage is the only bundled implementation; other adapters require deployment-specific durability and security qualification.
- The local signing key is not backed by a KMS or HSM.
- The local topology-authority key is not backed by a KMS, HSM or customer approval policy.
- The local checkpoint-publisher key is not backed by a KMS, HSM or customer approval policy.
- Without an external segment trust bundle, existing history is expected to use the current local signer. With a bundle, every historical and next segment position must be explicitly trusted.
- Transition administration currently uses one local topology-authority key and one bearer credential; threshold/customer authorization is not implemented.
- Version 1 witness receipts verify checkpoint signatures and configured publisher trust; they do not assert a full independent traversal of referenced segment history.
- Direct embedded construction of `LocalLedger` does not acquire the service-process lock; an embedding host must provide equivalent exclusive-writer ownership.
