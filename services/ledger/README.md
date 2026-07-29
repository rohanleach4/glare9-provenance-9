# Glare•9 Provenance Ledger Service

This workspace exposes the first authenticated ingestion boundary for database connectors. It accepts versioned event batches, routes them, seals `.g9p` segments synchronously and returns one receipt per event.

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
```

`/v1/info` and ingestion require the configured bearer token. Event submissions are idempotent by `eventId` and canonical event content.

The configured `PROVENANCE_SHARD_COUNT` must match the routing policy recorded in every existing segment. The service refuses startup on a mismatch because routing-epoch transitions are not implemented yet.

Before writing a ledger's first segment, the service creates a signed epoch-zero descriptor under `routing/<ledger-directory>/epoch-000000000000.g9p`. Startup verifies that descriptor with the local topology-authority identity and derives the ledger's permitted routing policy from it.

Legacy version 1 history without a descriptor fails closed by default. For one reviewed migration startup, set `PROVENANCE_ADOPT_LEGACY_ROUTING_HISTORY=true` to create an epoch-zero adoption descriptor after all existing segments pass verification. Disable the option again after migration. Sealed segment bytes are never changed.

## Current limitations

- Sealing is synchronous rather than accepted-then-sealed.
- Local filesystem storage is the only implementation.
- The local signing key is not backed by a KMS or HSM.
- The local topology-authority key is not backed by a KMS, HSM or customer approval policy.
- Existing history is expected to use the current local signer.
- Epoch-aware segment headers, live routing transitions, checkpoints and witnesses are not implemented.
