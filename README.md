# Glare•9 Provenance

Glare•9 Provenance is an experimental, independently verifiable governance evidence ledger. It preserves append-only event history in compressed, signed `.g9p` segments without requiring an application to replace its operational database.

The current first iteration can:

- Deterministically encode and hash governance events
- Route events to a versioned shard policy
- Compress records into independent Zstandard blocks
- Seal hash-linked `.g9p` segments with Ed25519
- Create and independently verify signed routing-epoch `.g9p` descriptors
- Persist and verify per-ledger signed epoch-zero routing history
- Bind new epoch-scoped version 2 segments to their signed routing descriptor
- Verify segments offline and distinguish an embedded key from a trusted key
- Detect block mutation, signature mutation, truncation and incorrect chain links
- Accept authenticated event batches through a separately runnable ledger service
- Deliver schema-neutral MySQL transactional-outbox events through a switchable connector service

## Try the first iteration

Requirements: Node.js 24 or later and npm 11 or later.

```bash
npm install
npm run test:all
npm run demo
```

Verify a segment:

```bash
npm run verify -- path/to/segment.g9p
```

Preview deterministic sharding for a new ledger:

```bash
npm run shard -- governance-ledger 4 model:alpha model:beta policy:credit
```

Verify a signed routing-epoch descriptor:

```bash
npm run verify:epoch -- path/to/epoch-000001.g9p [trusted-key-id]
```

The implementation now includes an experimental ledger-ingestion service and MySQL outbox connector, but it is not production-ready. Do not use it for production evidence, credentials or signing keys.

## MySQL connector

Local MySQL development uses the existing server administered through **MySQL Workbench**, not Docker. Review and apply the outbox migration through Workbench, then configure the ledger and connector using their ignored `.env` files.

```bash
npm run start:ledger
npm run start:connector:mysql
```

See [`connectors/mysql/README.md`](./connectors/mysql/README.md) for setup, permissions and testing.

## Documentation

- [`Provenance-readme.md`](./Provenance-readme.md) — product, trust model and usage
- [`Sharding-readme.md`](./Sharding-readme.md) — sharding, segments and checkpoints
- [`Connector-readme.md`](./Connector-readme.md) — MySQL and future connectors
- [`Test-readme.md`](./Test-readme.md) — test and assurance strategy
- [`docs/G9P-format-v1.md`](./docs/G9P-format-v1.md) — experimental byte-level format
- [`docs/G9P-format-v2.md`](./docs/G9P-format-v2.md) — epoch-aware experimental segment format
- [`docs/G9P-routing-epochs-v1.md`](./docs/G9P-routing-epochs-v1.md) — signed routing epochs and forward-only resharding protocol
- [`TODO.md`](./TODO.md) — production go-live checklist

The open-source licence has not yet been selected or granted. Apache 2.0 is the current adoption-first preference, subject to formal approval.
