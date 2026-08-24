# Provenance•9 non-production operations qualification v1

## Recorded exercise

`npm run qualification:operations` creates disposable Integrated Custody and self-hosted Separated Custody installations, validates their manifests and starts each ledger behind a temporary locally controlled mutual-TLS identity.

For each profile the exercise confirms:

- TLS 1.3 is negotiated;
- a client without the locally issued certificate is rejected during the TLS handshake;
- liveness and readiness respond successfully through mutual TLS;
- metrics reject an unauthenticated request and accept the installation credential;
- authenticated ingestion produces a sealed receipt using the installed segment identity;
- authenticated checkpoint publication succeeds using the installed checkpoint identity;
- topology authority is exercised through signed genesis routing creation.

The script generates its one-day disposable CA, server and client identities with the locally installed `openssl` executable, writes them only beneath a temporary directory and removes the complete exercise directory afterward. It does not call a hosted service.

## Boundary

This evidence narrows the transport, monitoring and installed-custody gate, but it does not approve a real certificate authority, host, service manager, backup destination, monitoring-retention system or operator team. It does not exercise MySQL and is not a substitute for deployment-specific incident and power-loss rehearsals.
