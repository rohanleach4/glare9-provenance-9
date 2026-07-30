# Glare•9 Provenance offline witness

This one-shot workspace is operated separately from the ledger. It reads a copied checkpoint, requires an externally approved checkpoint-publisher key ID, verifies the checkpoint and writes one create-only signed witness receipt. It never connects to MySQL or reads event payloads.

The witness Ed25519 PKCS#8 key path and `.env` are external ignored secrets. The file-key adapter is experimental; production use still requires an approved KMS/HSM or customer-controlled signer. Run from the repository root with `npm run start:witness` after configuring `services/witness/.env`.
