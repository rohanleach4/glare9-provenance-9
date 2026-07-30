# G9P backup, retention and disaster-recovery procedure v1

## Objective

Preserve and recover authoritative `.g9p` history without decoding, re-encoding, recompressing, resigning or otherwise rewriting sealed bytes. This procedure applies to segment and routing-epoch objects exposed by the sealed-storage contract.

Durable intake, provisional active-block state, service configuration and signing keys require separate operational backups. They are not immutable evidence and are not substitutes for sealed history.

## Backup procedure

1. Enumerate both `routing/` and `segments/` final keys through the storage adapter.
2. Read each object with an explicit size bound.
3. Copy the exact byte sequence to a create-only backup key with the same relative name.
4. Compare source and backup byte lengths and cryptographic file hashes.
5. Independently verify every copied routing descriptor and segment against the expected trust roots.
6. Record the complete key inventory, verification result, backup generation and custody location.
7. Do not report success until the destination's durability guarantee has completed.

Incremental backups may add newly sealed keys. They must never replace an existing backup key. A collision with different bytes is an incident, not an update.

## Retention procedure

Retention acts on whole immutable objects. A policy may retain an object in primary storage, copy it to a reviewed archive tier, or remove a primary copy after the archived copy and all required chain dependencies have been verified. It must never edit payloads, remove frames, change compression, renew signatures or renumber segments.

Routing descriptors, checkpoint dependencies and every segment required to verify a retained chain must remain discoverable. Deleting an intermediate segment makes later previous-segment links unverifiable. Content-erasure obligations must therefore be handled through data minimisation, encryption-key policy or deletion references defined before evidence is accepted; historical `.g9p` bytes are not rewritten.

## Restore and disaster recovery

1. Start with an empty sealed-storage namespace and stopped ingestion service.
2. Restore routing keys and segment keys using create-only publication and their original relative names.
3. Compare every restored object byte-for-byte with the backup inventory.
4. Run independent routing and segment verification, including trust, sequence, epoch and previous-link checks.
5. Start the ledger with the intended signer and topology trust configuration.
6. Allow startup to reconstruct routing history, shard heads, event identity and receipts exclusively from verified `.g9p` history.
7. Reconcile any separately restored intake only after sealed-history reconstruction; records already sealed must retire idempotently.
8. Resume ingestion only after operators record the recovered heads and a repeat submission returns the original sealed receipt.

Never fill a gap by creating a replacement object at an old segment number. A missing or corrupt object is an incomplete recovery and must fail closed.

## Automated evidence

`services/ledger/test/storage-operations.test.js` creates signed multi-segment history, copies exact objects to a retention archive, verifies all archived objects, removes the primary test store, restores into a fresh store and rebuilds stable receipts from verified history. Every source, backup and restored byte sequence is compared exactly.

The test demonstrates the reference state machine. Production qualification must additionally exercise the selected storage backend, backup service, access controls, encryption, geographic failure assumptions, recovery-time objective, recovery-point objective and operator runbook.
