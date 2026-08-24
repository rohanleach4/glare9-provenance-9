# G9P release and supply-chain procedure v1

## Version and contents

Software uses Semantic Versioning and every workspace version must match the root. G9P format/protocol versions are independent. A release updates `CHANGELOG.md`, specifications, conformance vectors and migration notes as applicable, then passes aggregate tests, coverage, fuzzing, repository scan and production dependency audit from a clean commit.

All packages remain registry-private during the Foundation source-release series. The release unit is a source archive plus checksums, CycloneDX SBOM and provenance evidence; registry publication requires a separately approved public-package decision.

## Reproducibility

`npm run release:evidence -- <output-directory>` operates only on a clean tagged commit. It creates a deterministic `git archive` gzip with timestamp-free compression, a SHA-256 checksum and an npm CycloneDX SBOM. Running it twice for the same commit must reproduce the archive checksum. The repository has no compilation step; reproducibility therefore covers exact source, lockfile and generated release metadata, not host-specific benchmark results.

## Signing and provenance

The release tag must be an annotated tag signed by an approved maintainer SSH or GPG key held under Glare•9-controlled local custody. Authorized public signing identities are recorded in `RELEASE_SIGNERS`; private keys must not be stored in the repository or ordinary workflow variables. Release assets must use the exact locally verified checksum. The signed tag, deterministic source archive, checksum, SBOM and `release-evidence.json` bind the release version to its source commit without requiring a hosted signing or attestation service.

An independent second-person review of version, changelog, clean status, tag identity, test evidence, dependency findings, SBOM, reproducibility result and asset hashes is recommended. When no second reviewer is available, the maintainer may perform and record the same checklist as a disclosed single-maintainer verification; the release must not imply independent review. Revocation never rewrites an old release; publish a security advisory and a new signed release.

## Deferred approval

Apache License 2.0, DCO inbound contributions and the trademark policy are approved for the source release. Release signing identities, public package names and the support lifetime remain owner/governance decisions. This procedure establishes the technical evidence path without claiming those remaining approvals.
