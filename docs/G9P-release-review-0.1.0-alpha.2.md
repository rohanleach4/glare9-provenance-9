# Provenance•9 release review — 0.1.0-alpha.2

## Review mode

This release uses disclosed single-maintainer verification by Rohan Leach on 24 August 2026. No independent second-person release review is claimed.

The signed tag identifies the exact reviewed commit. Generated release evidence binds that commit to the deterministic source archive, SHA-256 checksum and CycloneDX SBOM.

## Verification checklist

- [x] Root and workspace versions agree at `0.1.0-alpha.2`.
- [x] Changelog describes the release.
- [x] Node.js 24 and npm 11 clean dependency installation completed.
- [x] Aggregate core, ledger, connector, signer and witness suites passed.
- [x] Core coverage passed at 98.02% lines, 92.05% branches and 96.41% functions.
- [x] Custody coverage passed at 88.95% lines, 74.48% branches and 80.77% functions.
- [x] Bounded fuzzing passed with the recorded deterministic seed.
- [x] Repository security scan passed.
- [x] Production dependency audit reported zero vulnerabilities.
- [x] Isolated local MySQL integration and TLS/least-privilege qualification passed; its limits are recorded separately.
- [x] No critical or high finding is open in the maintained findings register.
- [x] Release limitations, missing independent review and Foundation/Candidate status are disclosed.

## Release claim

This is a Foundation-stage prerelease source distribution. It does not claim Stable format status, regulated assurance, independent security approval, independently witnessed finality, high availability or an SLA.
