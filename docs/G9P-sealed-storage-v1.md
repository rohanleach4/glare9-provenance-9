# G9P sealed-storage contract v1

## Purpose and scope

This document defines the reference service boundary for storing immutable segment and routing-epoch `.g9p` objects. It separates sealed evidence custody from the local lifecycle engine without coupling G9P to a filesystem, object-store vendor, database or customer application schema.

This is a service contract, not a G9P container-format change. Stored bytes, hashes, signatures, chaining and offline verification are identical regardless of the adapter that retains them.

Durable accepted-event intake and completed active-block state are deliberately outside this contract. They are mutable service recovery state and remain under `intake/` and `provisional/` in the reference service. Only authoritative immutable `.g9p` history is placed behind sealed storage.

## Required operations

A sealed-storage implementation supplied to `LocalLedger` provides four asynchronous operations:

```text
initialize()
publish(key, bytes, options)
read(key, { maxBytes })
list(prefix)
```

### `initialize()`

Prepare the backend and reconcile adapter-private incomplete publication state. Incomplete objects must not become authoritative merely because their bytes appear complete. After initialization, `list()` exposes only final objects.

The bundled local adapter discards abandoned `.g9p.part` names. It never promotes them during recovery.

### `publish(key, bytes, options)`

Publish the exact supplied bytes at a previously absent key. The operation must:

- reject an invalid or non-`.g9p` key;
- never replace, truncate or mutate an existing final object;
- make the complete object visible atomically rather than exposing a partial final object;
- provide the backend's documented durability guarantee before reporting success;
- preserve the existing final bytes if a key collision or uncertain retry occurs.

The local adapter implements publication with exclusive `.g9p.part` creation, complete write, file synchronisation, create-only hard-link promotion, publication-directory synchronisation, provisional-name removal and cleanup-directory synchronisation.

### `read(key, { maxBytes })`

Return the exact stored bytes for one final key without interpreting them. The adapter must apply the caller's positive byte limit before allocating or returning oversized content. Readers must still cryptographically verify the returned bytes.

### `list(prefix)`

Return unique final object keys below the requested prefix in deterministic lexical order. Listing is discovery, not proof: the ledger validates every key shape and verifies every object's contents, signature, position and chain before rebuilding history.

The contract intentionally has no overwrite, update or delete operation for sealed evidence.

## Canonical reference keys

Keys are relative opaque strings using forward slashes. Absolute paths, empty components, `.` and `..` components, backslashes and NUL bytes are invalid.

```text
routing/<ledger-directory>/epoch-<12 digits>.g9p
segments/<ledger-directory>/<shard-id>/segment-<12 digits>.g9p
segments/<ledger-directory>/epoch-<12 digits>/<shard-id>/segment-<12 digits>.g9p
```

The second segment form is retained for legacy version 1 history. The third is used by epoch-aware version 2 segments. These keys are storage conventions only; verified container contents remain authoritative.

## Independent verification

`verifySegmentBytes(bytes, options)` and `verifyRoutingEpochBytes(bytes, options)` authenticate independently retrieved objects without calling or trusting a storage adapter. Existing path-based `verifySegment()` and `verifyRoutingEpoch()` remain compatible wrappers around those byte verifiers.

An auditor can therefore copy a sealed object from any backend, transport it independently, and verify its framing, bounds, compression, commitments, signature, trust status and chain references offline. The storage provider is never a cryptographic trust root.

## Reference implementation and injection

`LocalFilesystemSealedStorage` is the bundled adapter and preserves the existing `dataDirectory/segments` and `dataDirectory/routing` layout. `LocalLedger` constructs it by default, so existing deployments and command-line behavior do not change.

Embedded deployments may pass another contract implementation as `sealedStorage` when constructing `LocalLedger`. Tests demonstrate publication, restart reconstruction and idempotent receipt replay with a non-filesystem implementation while local intake and provisional state remain separate.

The bundled storage implementation is local and self-contained. Any future self-hosted storage implementation requires its own durability, consistency, authentication, authorization, encryption, availability, retention and disaster-recovery review. Passing the interface tests alone does not establish that a backend is suitable for production evidence.
