# Glare•9 Provenance installation v1

## Requirements

- macOS or Linux for the optional Unix-socket Separated Custody profile;
- Node.js 24 and npm 11;
- a dedicated operating-system account;
- a durable data volume with sufficient intake, provisional, sealed-history and backup capacity;
- restrictive filesystem permissions and a separately tested backup destination;
- no third-party hosted service, telemetry, licence server or internet connection at runtime.

## Create an installation

Run the interactive installer from the repository root:

```bash
npm run setup
```

The heading is **Glare•9 Provenance — Installation Mode**. Integrated Custody is the self-contained default. Separated Custody is optional and adds the self-hosted Glare•9 signer over a local Unix-domain socket.

For repeatable setup:

```bash
npm run setup -- --custody integrated --install-dir /srv/glare9-provenance
```

or:

```bash
npm run setup -- \
  --custody separated \
  --install-dir /srv/glare9-provenance \
  --signer-socket /run/glare9-provenance/signer.sock
```

Setup is create-only. It refuses to replace a manifest, credentials, configuration or key file. It generates distinct encrypted Ed25519 identities for segment signing, topology authority and checkpoint publication, creates random ingestion/administration credentials, applies restrictive modes and records public key identifiers in `installation.json`.

## Start

Integrated Custody:

```bash
npm run start:installed -- ledger /srv/glare9-provenance/ledger.env
```

Separated Custody starts the signer first in a different terminal or service-manager unit:

```bash
npm run start:installed -- signer /srv/glare9-provenance/signer.env
npm run start:installed -- ledger /srv/glare9-provenance/ledger.env
```

The ledger validates the custody mode, data directory and all three live public identities against the manifest before opening the service. Separated Custody has no local-key fallback. If the signer is unavailable, no new segment, routing descriptor or checkpoint can be signed.

## Secrets and recovery

The environment files, encrypted private keys and passphrase file are mode `0600` on POSIX systems. Encryption reduces accidental at-rest exposure but does not make a compromised running service account safe: that account can reach the configured signing operation.

Back up these classes separately and test restoring them together:

1. exact sealed `.g9p` bytes and retained intake/provisional recovery state;
2. encrypted signing-key files;
3. the passphrase file in a separately protected location;
4. `installation.json`, public key files and service configuration;
5. positional trust bundles, TLS identity and operational records where configured.

Losing either a private key or its passphrase prevents new signatures and may prevent an installation from continuing under its recorded identity. Do not copy credentials into shell history, tickets or public qualification output.

Run the disposable reference exercise after installation changes:

```bash
npm run qualification:pilot
npm run qualification:operations
```

The first command exercises interruption, recovery and exact-byte backup/restore. The second requires a local `openssl` executable and exercises both installed custody profiles through mutual TLS, readiness, authenticated metrics, sealed ingestion and checkpoint publication. They create no persistent operational installation and report their limitations explicitly.
