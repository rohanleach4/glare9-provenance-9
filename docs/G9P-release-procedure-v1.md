# G9P release and supply-chain procedure v1

## Version and contents

Software uses Semantic Versioning and every workspace version must match the root. G9P format/protocol versions are independent. A release updates `CHANGELOG.md`, specifications, conformance vectors and migration notes as applicable, then passes aggregate tests, coverage, fuzzing, repository scan and production dependency audit from a clean commit.

All packages remain private during the experimental series. The release unit is a source archive plus checksums, CycloneDX SBOM and provenance evidence; registry publication requires a separately approved package/licence decision.

## Reproducibility

`npm run release:evidence -- <output-directory>` operates only on a clean tagged commit. It creates a deterministic `git archive` gzip with timestamp-free compression, a SHA-256 checksum and an npm CycloneDX SBOM. Running it twice for the same commit must reproduce the archive checksum. The repository has no compilation step; reproducibility therefore covers exact source, lockfile and generated release metadata, not host-specific benchmark results.

## Signing and provenance

The release tag must be an annotated tag signed by an approved maintainer SSH or GPG key. GitHub release assets must use the exact locally verified checksum. GitHub artifact attestations or an equivalent Sigstore-compatible provenance statement must bind the source commit, workflow identity, archive, checksum and SBOM. Signing keys must not be stored in the repository or ordinary workflow variables.

Two-person review confirms version, changelog, clean status, tag identity, test evidence, dependency findings, SBOM, reproducibility result and asset hashes. Revocation never rewrites an old release; publish a security advisory and a new signed release.

## Deferred approval

Release signing identities, public package names, support lifetime and licence remain owner/governance decisions. This procedure establishes the technical evidence path without claiming those approvals.
