# Independent agent review response — 2026-07

## Scope and outcome

An external agent reviewed the pre-Foundation repository on 2026-07-30 and reported no critical or exploitable vulnerability. This is useful independent engineering feedback, but it is not the formal independent security approval required by the go-live checklist.

The review raised nine findings. The project accepted findings 1–5 with the refinements below and recorded explicit decisions for findings 6–9.

## Accepted findings

1. **Single-writer enforcement:** `start:ledger` now takes a durable create-only lock in the configured data directory before opening keys or recovery state. A second service fails with `LEDGER_WRITER_LOCKED`. Stale locks are removed only through the documented operator procedure after confirming no writer exists; automatic PID-based stealing is deliberately avoided because PID reuse can violate integrity.
2. **Early MySQL table validation:** connector configuration now validates the outbox table or `schema.table` during environment loading, while repository construction retains the same validation and quoting boundary.
3. **Varint output bound:** the canonical encoder now enforces the same ten-byte maximum as the decoder, making the invariant local even though public callers already supply safe integers and bounded lengths.
4. **Discarded intake observability:** invalid pre-acknowledgement intake partials still discard safely, but now emit a structured `INTAKE_PART_DISCARDED` recovery warning. The warning excludes paths, hashes, payloads and arbitrary exception text.
5. **Checkpoint chain assurance:** checkpoint verification accepts an explicit `expectedPreviousCheckpointHash`, rejects a mismatch and returns `previousHashVerified`. Signature/shape-only verification reports `false`; callers can no longer mistake it for chain validation.

## Challenged or deferred findings

6. **Split `LocalLedger`: deferred.** The class is large, but a structural refactor across routing barriers, intake custody and sealing recovery has meaningful regression risk. It should follow a stable internal boundary proposal and retain the current test matrix rather than be mixed into security hardening.
7. **Consolidate exact-field helpers: deferred.** The implementations intentionally produce profile-specific error codes and slightly different trust boundaries. A shared helper is reasonable only if it preserves those observable verification semantics.
8. **Constrain `event.source.keyId` to Ed25519 IDs: not adopted for envelope v1.** The field identifies an opaque source-system key or credential reference and is not a claim that a G9P Ed25519 signature was verified. A future customer-signed event envelope has separately versioned algorithm, registration, key-ID and signature semantics.
9. **Pin `mysql2` manifest range: not adopted.** The committed lockfile selects exact bytes, CI uses lockfile installation, and scheduled security checks cover dependency changes. Keeping the compatible range permits an intentional reviewed lockfile upgrade; production release evidence remains tied to the exact lockfile and SBOM.

No accepted change alters sealed `.g9p` bytes or reinterprets existing evidence.
