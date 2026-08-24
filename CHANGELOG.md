# Changelog

All notable changes to Provenance•9 are recorded here. The project follows Semantic Versioning for software releases, while permanent G9P format and protocol versions remain independent as defined in `docs/G9P-format-compatibility-policy-v1.md`.

## Unreleased

## 0.1.0-alpha.2 — 2026-08-24

### Added

- Adopted the public name Provenance•9, stewarded by Glare•9, while retaining established technical identifiers and compatibility with legacy installation manifests.
- Experimental immutable evidence ledger core, ledger service, MySQL outbox connector, routing epochs, accepted-first receipts, bounded lifecycle, operational tooling and independent verification assets.
- Independent-review hardening for exclusive service writer ownership, explicit checkpoint-chain assurance, fail-fast MySQL table validation, bounded varint encoding and redacted intake recovery warnings.
- Neutral asynchronous Ed25519 signing with local verification before publication, enabling optional self-hosted separated custody without exposing private keys to G9P writers.
- Local MySQL TLS 1.3 and exact-table least-privilege qualification with explicit portability limits.
- Proportionate commercial-release guidance for evaluation, Foundation deployments and customer-led higher-assurance programmes.

### Changed

- Disabled unavailable private-repository CodeQL database uploads while retaining local analysis.
- Reframed deployment approval and independent review as disclosed deployment-owner decisions and assurance recommendations.
- Required UTC outbox timestamp defaults so leasing remains correct in non-UTC server environments.
- Increased the bounded release-archive buffer so evidence generation supports the complete source tree.

## 0.1.0-alpha.1

- Initial experimental package version. This version is not approved for production evidence or public package publication.
