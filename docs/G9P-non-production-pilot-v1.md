# G9P non-production pilot and recovery exercise v1

## Recorded result

On 2026-08-20, `npm run qualification:pilot` passed for both Integrated Custody and optional self-hosted Separated Custody.

For each profile the exercise:

1. created a new installation with encrypted, distinct signing identities and a pinned manifest;
2. accepted a deterministic qualification event;
3. injected interruption after a provisional segment had been synchronised but before promotion;
4. restarted from retained state and sealed the event exactly once;
5. copied every sealed object to a create-only backup;
6. restored those exact bytes into fresh storage;
7. rebuilt ledger indexes and the idempotent receipt from verified history; and
8. independently verified restored segment and routing objects against the recorded public identities.

This closes the repeatable reference pilot gate, not a site-specific deployment gate. It does not exercise MySQL/TLS, physical power loss, a service manager, storage hardware, operator alerts or an organisation’s incident process. Those results must be recorded in the environment where evidence will be relied upon.
