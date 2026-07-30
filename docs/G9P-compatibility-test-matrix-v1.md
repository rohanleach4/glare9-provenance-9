# G9P compatibility test matrix v1

## Declared support

| Artifact | Supported behavior |
| --- | --- |
| Event envelope version 1 | Read, validate, hash and write. |
| Segment format version 1 | Read, verify and write for standalone and legacy compatibility. |
| Segment format version 2 | Read, verify and write with signed routing-epoch binding. |
| Routing-epoch protocol version 1 in container version 2 | Read, verify and write. |
| Receipt contract version 1 | Synchronous sealed ingestion compatibility. |
| Receipt contract version 2 | Accepted-first ingestion and authenticated lifecycle polling. |

No implicit downgrade, best-effort parsing or unknown-field tolerance is permitted for cryptographic containers and event envelopes. Unknown event versions, unknown envelope fields and unsupported magic-version bytes fail with stable explicit errors before their content is accepted as history.

## Upgrade tests

- Version 1 segment fixtures continue to verify.
- Version 2 segments authenticate the exact routing descriptor and chain inside an epoch-scoped shard.
- Verified version 1 history can be adopted only through the explicit signed epoch-zero migration option; its bytes remain unchanged.
- Later routing epochs write version 2 segments while retained version 1 history remains readable.
- Future event-envelope versions are rejected with `EVENT_VERSION`.
- Future segment and routing container magic versions are rejected with `FORMAT_MAGIC`.
- Receipt clients reject unsupported contract shapes and state-specific fields.

## Policy boundary

This matrix records tested current behavior. It does not by itself approve the permanent public stability period, deprecation window, package semantic-version policy or source-language commitment. Those product decisions remain separately gated in `TODO.md`.
