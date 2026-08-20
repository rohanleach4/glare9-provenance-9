# Changelog

All notable changes to Glare•9 Provenance are recorded here. The project follows Semantic Versioning for software releases, while permanent G9P format and protocol versions remain independent as defined in `docs/G9P-format-compatibility-policy-v1.md`.

## Unreleased

### Added

- Experimental immutable evidence ledger core, ledger service, MySQL outbox connector, routing epochs, accepted-first receipts, bounded lifecycle, operational tooling and independent verification assets.
- Independent-review hardening for exclusive service writer ownership, explicit checkpoint-chain assurance, fail-fast MySQL table validation, bounded varint encoding and redacted intake recovery warnings.
- Neutral asynchronous Ed25519 signing with local verification before publication, enabling optional self-hosted separated custody without exposing private keys to G9P writers.

## 0.1.0-alpha.1

- Initial experimental package version. This version is not approved for production evidence or public package publication.
