# Provenance•9 offline witness

This one-shot workspace is operated separately from the ledger. It reads a copied checkpoint, requires an externally approved checkpoint-publisher key ID, verifies the checkpoint and writes one create-only signed witness receipt. It never connects to MySQL or reads event payloads.

The witness Ed25519 key path and `.env` are external ignored secrets. A witness is separately administered and must protect, back up and qualify its own signing identity; it never requires a third-party signing service. Run from the repository root with `npm run start:witness` after configuring `services/witness/.env`.
