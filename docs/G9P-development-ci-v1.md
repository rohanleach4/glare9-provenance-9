# Development runtime and CI policy v1

## Supported toolchain

- Node.js major version 24, selected by `.nvmrc` and constrained to `>=24 <25`.
- npm major version 11, constrained to `>=11 <12` with engine enforcement enabled.
- The committed `package-lock.json` is authoritative; CI installs with `npm ci`.

Developers should switch to Node 24 through their normal version manager and use the npm version bundled or installed for that supported line. Unsupported majors must fail installation rather than silently produce a different dependency graph.

## Automated checks

`.github/workflows/ci.yml` runs the complete core, format, compatibility, connector-contract, ledger-service and MySQL connector unit suites on pull requests and pushes to `main`. The real Workbench-managed MySQL integration test remains opt-in because CI has no authorized database.

`.github/workflows/security.yml` runs repository secret/path scanning, JavaScript syntax checks, the production dependency vulnerability audit and GitHub CodeQL on pull requests, pushes to `main` and a weekly schedule. While the repository is private without GitHub Code Security, CodeQL completes locally in the workflow without attempting an unavailable SARIF upload; publication begins automatically when the repository becomes public.

The main CI workflow also enforces the native core coverage floors documented in `G9P-quality-hardening-v1.md`. The security workflow runs the bounded reproducible fuzz suite before CodeQL analysis.

No CI workflow starts Docker-based MySQL.
