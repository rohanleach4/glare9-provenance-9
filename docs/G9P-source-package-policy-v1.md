# G9P source-language and package policy v1

## Decision

The maintained reference implementation remains Node.js 24 JavaScript using native ECMAScript modules through the Foundation 0.x series. A TypeScript migration is not justified while service boundaries are still evolving; generated declarations or a future typed client may be added without changing sealed bytes.

The monorepo retains four boundaries: public core/offline tools, ledger service, shared connector contract and database-specific connectors. Database drivers remain connector-local. A connector moves to another repository or language only when it gains independent maintainers, release cadence or runtime requirements.

## Compatibility

Package versions use Semantic Versioning. During 0.x, documented exports and HTTP/connector contracts may make breaking changes in a minor release, with changelog and migration notes. Patch releases must not intentionally break documented behavior. Stored `.g9p` compatibility is governed separately and can never be inferred from an npm package version.

All workspaces remain `private: true` for the initial source-release series; npm registry publication is a separate decision. The reviewed root export map defines the supported application surface in `G9P-supported-api-v1.md`. Consumers must not depend on undocumented `src/` paths, and offline verification remains independent of MySQL and service dependencies.

Node 24/npm 11 remain the only supported development/runtime line for this Foundation series. A future runtime transition requires CI overlap, lockfile regeneration, compatibility evidence and a documented support window.
