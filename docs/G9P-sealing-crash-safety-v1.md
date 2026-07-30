# G9P local sealing crash-safety record v1

## Scope

This document records the deterministic crash-boundary demonstration for the reference local-filesystem writer. It applies to sealed segment and routing-epoch `.g9p` files written through the shared create-only sealing primitive. It is an implementation assurance record, not a change to either G9P container format.

The writer follows this sequence:

1. Exclusively create `<sealed-path>.part`.
2. Write every byte of the complete signed container.
3. Synchronise the provisional file.
4. Create the final `.g9p` name as a hard link, refusing to replace an existing name.
5. Synchronise the containing directory so publication is durable.
6. Remove the provisional name.
7. Synchronise the directory again so cleanup is durable.

Only the final `.g9p` name is authoritative. A `.g9p.part` name is never interpreted as sealed history.

## Demonstrated interruption matrix

`services/ledger/test/fault-injection.test.js` injects one failure at each boundary, inspects the filesystem before restart, reconstructs the ledger from that exact state and proves that the retained event is sealed exactly once. Repeated ingestion must return the same receipt, durable intake must be empty after recovery and no provisional segment may remain.

| Injected boundary | Final `.g9p` | `.g9p.part` | Restart rule |
| --- | ---: | ---: | --- |
| Before block compression | absent | absent | Rebuild from durable intake. |
| After block compression | absent | absent | Discard volatile work and rebuild from durable intake. |
| After provisional open | absent | present | Discard the non-authoritative provisional file and rebuild. |
| After complete write | absent | present | Discard the non-authoritative provisional file and rebuild. |
| After provisional file sync | absent | present | Discard the non-authoritative provisional file and rebuild. |
| Immediately before promotion | absent | present | Discard the non-authoritative provisional file and rebuild. |
| Immediately after hard-link promotion | present | present | Verify and adopt the final file; discard the provisional name. |
| After publication directory sync | present | present | Verify and adopt the durable final file; discard the provisional name. |
| After provisional-name removal | present | absent | Verify and adopt the final file. |
| After cleanup directory sync | present | absent | Verify and adopt the final file. |

At the two boundaries where both names exist, the test confirms that they contain identical bytes and identify the same filesystem inode. The existing sealed-path collision tests separately prove that promotion cannot overwrite an existing segment or routing descriptor.

## Recovery invariants

- Durable intake remains the custody record until verified sealed history is discovered and reconciled.
- Startup discards matching `.g9p.part` files; it never promotes them based on their contents.
- Startup verifies every final `.g9p` file before rebuilding event and shard indexes.
- If publication is visible after an uncertain response, restart adopts the verified final file and retires its intake and active state.
- If publication is absent, restart reprocesses the retained intake into the same logical event position.
- A final-name collision fails closed and preserves the bytes already stored at that path.

These rules cover both possible observations around a directory-publication boundary: either the final name is visible and must verify, or it is absent and durable intake is replayed. They do not permit two accepted histories for one shard epoch.

## Assurance boundary

The automated suite deterministically interrupts execution immediately after the named filesystem operation returns. This demonstrates the reference service's state-machine and recovery behavior, including file synchronisation, both directory synchronisations and create-only promotion.

It does not certify a filesystem, operating system, storage controller or device against real power loss. Deployment qualification still requires abrupt-process and power-loss exercises on the actual storage stack, confirmation that file and directory synchronisation have the promised durability semantics, and monitoring for I/O or verification failures.
