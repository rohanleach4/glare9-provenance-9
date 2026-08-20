# G9P supported JavaScript API v1

## Supported entry points

The Foundation software series supports only package entry points declared in the root `exports` map:

- `@glare9/provenance` — complete reviewed core surface;
- `@glare9/provenance/verify` — read-only event, segment, routing, checkpoint and witness verification;
- `@glare9/provenance/write` — canonical event and sealed-evidence writers;
- `@glare9/provenance/custody` — signer identity, callback and positional-trust primitives.

The connector client supports `@glare9/provenance-connector-contract` and its documented `./test-kit` entry point. Imports from undocumented `src/`, service or connector files are not supported application APIs.

## Compatibility

During software major version zero, a documented entry point may add exports in a minor release. Removing or incompatibly changing a documented export requires a minor version, changelog entry and migration note. Patch releases must preserve documented behavior. Sealed G9P bytes have their own stronger version and retained-verification rules; package SemVer never authorizes reinterpretation of evidence.

The verification entry point must remain independent of MySQL, ledger-service state, custody services and network access. The write entry point must preserve deterministic encoding and the authenticated format versions it declares.
