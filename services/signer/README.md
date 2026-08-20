# Glare•9 Provenance self-hosted signer

This optional service implements the Separated Custody installation profile. It is a Glare•9 Provenance component, uses only Node.js built-ins and the G9P core, and does not call a third party or require network access.

The signer holds the encrypted segment, topology-authority and checkpoint-publisher keys. The ledger connects through a local Unix-domain socket, obtains the three public identities and submits only 32-byte domain-separated commitments. The ledger verifies every returned signature before publication. Historical verification never uses this service.

Use `npm run setup` from the repository root to create an installation rather than preparing these values manually. Start the signer before the ledger. A stale socket after an unclean exit must be removed only after confirming that no signer process is active.

Separated custody currently targets macOS and Linux. Operators wanting separate operating-system accounts should grant the ledger account access through a dedicated shared group and an explicitly reviewed socket mode; never make the socket accessible to other users.
