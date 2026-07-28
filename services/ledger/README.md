# Glare•9 Provenance Ledger Service

This workspace exposes the first authenticated ingestion boundary for database connectors. It accepts versioned event batches, routes them, seals `.g9p` segments synchronously and returns one receipt per event.

## Configure

Copy `.env.example` to the ignored `.env` file and set a long random bearer token:

```bash
cp services/ledger/.env.example services/ledger/.env
```

The local service generates a development Ed25519 segment key under its ignored data directory. That key store is not suitable for production.

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

## Current limitations

- Sealing is synchronous rather than accepted-then-sealed.
- Local filesystem storage is the only implementation.
- The local signing key is not backed by a KMS or HSM.
- Existing history is expected to use the current local signer.
- Checkpoints, witnesses and routing-epoch transitions are not implemented.
