# Glare•9 Provenance Ledger Service

This workspace exposes the first authenticated ingestion boundary for database connectors. It durably retains versioned events before routing, seals `.g9p` segments synchronously and returns one receipt per event.

## Configure

Copy `.env.example` to the ignored `.env` file and set a long random bearer token:

```bash
cp services/ledger/.env.example services/ledger/.env
```

The local service generates separate development Ed25519 segment-signing and topology-authority keys under its ignored data directory. That key store is not suitable for production.

## Run

From the repository root:

```bash
npm run start:ledger
```

Default endpoints:

```text
GET  /health
GET  /v1/info
POST /v1/events:batch
POST /v1/admin/routing-transitions
```

`/v1/info` and ingestion require the configured bearer token. Event submissions are idempotent by `eventId` and canonical event content.

## Durable accepted-event intake

Before an event is assigned to a routing epoch or shard, the service writes a canonical ordered intake record under `intake/`. It synchronises the record, promotes it without replacing another record, and synchronises the intake directory before the event can enter the accepted state. Intake records are local service recovery state, not sealed `.g9p` evidence files.

After the applicable segment is sealed, the corresponding intake record is retired. On startup, the service strictly decodes and validates every retained record, removes records already represented by verified sealed history, promotes complete provisional records left by an interrupted write, and resumes sealing the remainder exactly once by event identity and canonical content.

The public version 1 HTTP contract continues to drain accepted events synchronously and return `sealed` receipts. The internal `accepted` stage is intentionally topology-neutral so a routing-transition barrier can retain arrivals without assigning them to either the old or new epoch. A later contract version will expose accepted and provisional receipts explicitly.

`PROVENANCE_SHARD_COUNT` establishes epoch zero for new ledgers and must match an existing epoch-zero-only ledger. Once a signed transition exists, that ledger's active descriptor is authoritative.

Before writing a ledger's first segment, the service creates a signed epoch-zero descriptor under `routing/<ledger-directory>/epoch-000000000000.g9p`. Startup verifies that descriptor with the local topology-authority identity and derives the ledger's permitted routing policy from it. New ledgers store epoch-aware version 2 segments under `segments/<ledger-directory>/epoch-000000000000/shard-0000/`; every segment authenticates the epoch number and exact descriptor hash.

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

Abandoned segment and routing `.g9p.part` files are explicitly provisional and are discarded on startup; their retained intake can then be sealed again. Complete durable-intake provisional records are promoted and recovered. Final `.g9p` files remain create-only and authoritative.

The automated fault-injection suite interrupts intake append, compression, file and directory synchronisation, promotion, acknowledgement and both sides of routing-epoch publication. It then rebuilds the ledger from disk and checks exact event and epoch uniqueness.

## Current limitations

- The public HTTP contract waits for sealing even though durable accepted intake now exists internally.
- Local filesystem storage is the only implementation.
- The local signing key is not backed by a KMS or HSM.
- The local topology-authority key is not backed by a KMS, HSM or customer approval policy.
- Existing history is expected to use the current local signer.
- Transition administration currently uses one local topology-authority key and one bearer credential; threshold/customer authorization is not implemented.
- Checkpoints and witnesses are not implemented.
