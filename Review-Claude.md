# Glare9-Provenance — Code Review

**Reviewed:** 2026-07-30
**Scope:** `src/`, `services/ledger`, `services/witness`, `connectors/mysql`, docs, package manifests.
**Version reviewed:** `0.1.0-alpha.1` (explicitly pre-production, per README/TODO.md).

## Overall assessment

This is an unusually well-engineered pre-production codebase. Consistent patterns throughout:
exact-field validation on every parsed structure (`rejectUnknownFields`/`exact`/`exactFields`),
domain-separated hashing (`domainHash("kind-v1", ...)`), bounded allocation before parsing
untrusted bytes, `timingSafeEqual` for token comparisons, path-escape checks on all filesystem
keys, and an honest, detailed threat model ([docs/G9P-threat-model-v1.md](docs/G9P-threat-model-v1.md))
and go-live checklist ([TODO.md](TODO.md)) that already acknowledge most of the real gaps (no
KMS/HSM, no external witness diversity, single-writer topology, etc.).

No critical/exploitable vulnerabilities were found in the reviewed code paths. Findings below are
mostly hardening suggestions, a couple of real edge-case gaps, and maintainability observations.

---

## Findings

### 1. Single-writer topology is a soft assumption, not an enforced one

**Area:** [services/ledger/src/local-ledger.js](services/ledger/src/local-ledger.js)
**Severity:** Medium

`LocalLedger` serializes writes in-process (`#serialize()`), and duplicate `eventId` detection
within a batch and against the durable intake index relies on that single-process serialization.
Nothing at the storage layer (file locking, an advisory lock, a PID/lease file) prevents two
ledger-service processes from being pointed at the same `dataDirectory` simultaneously — which
would let conflicting events for the same `eventId` be accepted into different shards/segments
without detection. The docs describe single-writer as a supported-topology requirement, but there's
no runtime guard that fails fast if a second process attaches to the same data directory.

**Suggestion:** Take an exclusive lock file (e.g. `O_EXCL` lock in `dataDirectory`) on ledger
startup and fail immediately if already held, rather than relying on operational discipline alone.

### 2. `MySQL` outbox table name is validated late, not at config load

**Area:** [connectors/mysql/src/config.js](connectors/mysql/src/config.js#L69), [connectors/mysql/src/table.js](connectors/mysql/src/table.js)
**Severity:** Low (defense-in-depth, not an actual injection — see below)

`loadConnectorConfig()` passes `MYSQL_OUTBOX_TABLE` straight through with no format check. The
value is only validated later, inside `MySqlOutboxRepository`'s constructor via
`quoteTablePath()`, which does correctly whitelist identifiers with
`/^[A-Za-z_][A-Za-z0-9_$]*$/u` and backtick-quotes them — so **there is no actual SQL injection
risk** in the current code path. Still, validating at config-load time (like every other env var
in this file) would surface misconfiguration earlier and keep validation co-located with the rest
of the config's fail-fast checks.

### 3. Varint encoder has no explicit output-size cap

**Area:** [src/codec/canonical.js](src/codec/canonical.js) `encodeVarUint()`
**Severity:** Low (theoretical)

`encodeVarUint` loops until `remaining === 0n` with no maximum iteration/byte-length guard. In
practice every caller feeds it a zig-zag-encoded `Number.isSafeInteger` value or a length already
bounds-checked elsewhere, so this isn't currently reachable with attacker-controlled unbounded
input — but it's an implicit invariant rather than an enforced one. A future caller change could
reintroduce risk silently.

**Suggestion:** Add an explicit cap (e.g. assert output ≤ 10 bytes, enough for a 64-bit value) so
the function is safe independent of caller discipline.

### 4. Corrupted `.intake.part` files are discarded silently

**Area:** [services/ledger/src/durable-intake.js](services/ledger/src/durable-intake.js) recovery path
**Severity:** Low

On startup recovery, a part file that fails to parse is unlinked without any log line. Since these
are pre-acknowledgement partial writes this is the correct _safety_ behavior, but silent data
discard makes it harder to notice a disk/hardware fault pattern in production.

**Suggestion:** Log a warning (with path, not content) whenever a partial intake file is discarded
during recovery.

### 5. Checkpoint's `previousCheckpointHash` chain check is opt-in

**Area:** [src/checkpoint.js](src/checkpoint.js) `verifyCheckpointBytes()`
**Severity:** Low/Medium (usage-dependent)

Chain-linking verification against `expectedPreviousCheckpointHash` only happens if the caller
passes that option — `verifyCheckpointBytes()` will happily return a "valid" result for a
checkpoint whose stated previous hash was never checked against real history. This is presumably
intentional (some callers only want signature/shape verification), but the return value doesn't
flag whether chain continuity was actually asserted, which makes it easy for an integrating caller
to assume more was verified than actually was.

**Suggestion:** Include something like `previousHashVerified: boolean` in the result so downstream
code/logs can distinguish "signature valid" from "signature valid AND chained".

### 6. `LocalLedger` is a very large, multi-responsibility class

**Area:** [services/ledger/src/local-ledger.js](services/ledger/src/local-ledger.js) (1,141 lines)
**Severity:** Low (maintainability, not correctness)

This single class owns routing-epoch loading/transition, checkpoint publication, durable intake,
active-segment lifecycle (append/complete/seal/recover), and back-pressure — with dozens of
private methods. It's internally consistent and well-tested, but its size makes it the highest-risk
file to safely modify in future changes.

**Suggestion:** Consider splitting into cooperating modules (e.g. routing/epoch management,
segment sealing, intake/back-pressure) behind the same public `LocalLedger` façade, purely for
future change-safety — not urgent given current test coverage.

### 7. Duplicate "exact fields" validators across modules

**Area:** `src/checkpoint.js`, `src/routing-epoch.js`, `src/signer-trust.js`,
`services/ledger/src/active-segment-store.js`, `services/ledger/src/durable-intake.js`
**Severity:** Low

At least five near-identical implementations of "object has exactly these fields, nothing more"
exist independently. They're each correct, but consolidating into one exported helper (e.g. in
`src/errors.js`) would reduce the chance of a future one drifting (e.g. forgetting the
`Array.isArray` exclusion).

### 8. Event `source.keyId` format isn't constrained to match signer key IDs

**Area:** [src/event.js](src/event.js) `validateEvent()`
**Severity:** Low

`source.keyId` accepts any 1–256 character string, whereas `signer-trust.js` and the crypto layer
always deal in 64-character lowercase hex key IDs (`publicKeyId()`/`KEY_ID` regex). If
`source.keyId` is meant to reference a cryptographic signer identity, allowing arbitrary text means
malformed/lookalike key IDs pass event validation and only fail later (or not at all, if unused
downstream).

**Suggestion:** If `source.keyId` is intended to reference a real signing key, validate it against
the same `/^[0-9a-f]{64}$/u` pattern used elsewhere.

### 9. `mysql2` dependency uses a caret range

**Area:** [connectors/mysql/package.json](connectors/mysql/package.json)
**Severity:** Low

`"mysql2": "^3.23.1"` permits automatic minor/patch upgrades. Combined with an existing lockfile
this is low-risk, but for a component that talks to a production database with credentials, pinning
(or at minimum enabling `npm audit`/Dependabot/Renovate gating on this workspace) is worth
confirming is in place — the root repo already runs `npm audit --omit=dev --audit-level=high` in
`scripts.audit:dependencies`, which is good practice.

---

## Things done well (worth calling out explicitly)

- **Domain-separated hashing everywhere** (`domainHash("event-record-v1", ...)`,
  `"segment-signature-v1"`, `"merkle-leaf-v1"`, etc.) — prevents cross-context hash confusion, a
  classic real-world flaw in signed-ledger designs.
- **Consistent bounded parsing.** Sealed storage, canonical codec, and segment verification all
  check size/length limits _before_ allocating or decoding, defending against decompression/parsing
  DoS.
- **Path-traversal defenses are thorough and repeated correctly**: `LocalFilesystemSealedStorage`
  validates keys, rejects `..`/absolute/backslash/NUL, and double-checks the resolved path is still
  inside the configured root before every read/write.
- **Timing-safe token comparison** in both the ledger HTTP server and the MySQL connector's health
  server (`timingSafeEqual`), plus length equality checked before comparison, and admin vs.
  ingestion tokens are required to be disjoint at config-load time
  ([services/ledger/src/config.js](services/ledger/src/config.js)).
- **SQL is fully parameterized** in the MySQL outbox repository; the only interpolated values are
  identifiers passed through a strict allow-list quoting function (`quoteTablePath`) or integers
  already validated as safe integers in bounded ranges — no user-controlled string ever reaches a
  query body directly.
- **Immutable, indexed trust bundles** (`Object.freeze`, `WeakSet`/`WeakMap` memoized validation) in
  `signer-trust.js` prevent accidental mutation of a security-critical policy object.
- **Honest, specific threat model and TODO list.** Residual risks (no KMS/HSM yet, no witness
  diversity, single-node availability profile) are documented rather than glossed over, which is
  rare and valuable at this project stage.

---

## Suggested priority order

1. Enforce single-writer topology at runtime (finding 1) — the one item with real integrity impact
   if operational assumptions are violated.
2. Add `previousHashVerified` signal to checkpoint verification (finding 5).
3. Move MySQL outbox table validation to config load time (finding 2) and add a size cap to
   `encodeVarUint` (finding 3) — both cheap, defense-in-depth changes.
4. Log discarded partial intake files (finding 4).
5. Everything else (findings 6–9) is maintainability/consistency polish, safe to defer.
