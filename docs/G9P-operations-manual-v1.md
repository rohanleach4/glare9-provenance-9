# G9P operations manual v1

## Administrator responsibilities

Administrators provision the single-writer reference topology, ignored data directories, filesystem permissions, service identities, metrics credentials, backup targets and the dedicated Workbench-managed outbox. They apply MySQL migration/grants explicitly, maintain separate ingestion and routing-administration credentials and never commit runtime data or secrets.

Before startup, confirm Node/npm versions, empty or previously verified storage, configured shard count compatibility, signer/topology key provenance, lifecycle capacities and exact backup coverage. After startup, require ready status and verify signer/topology identifiers against the approved inventory.

## Operator responsibilities

Operators monitor readiness, capacity ratios, accepted/provisional backlog, active memory, connector ready/leased/dead-letter counts and oldest-ready age. They run exact-byte backup/restore and projection-rebuild exercises, perform signed routing transitions only under reviewed change control and use the incident runbooks without rewriting evidence.

Routine checks:

- daily: readiness, backlog age, dead-letter change and background errors;
- weekly: exact backup inventory, security workflow results and capacity trend;
- before change: offline verify current heads and preserve configuration/key identity;
- after change: verify new routing/segment objects, receipts and monitoring continuity.

## Verifier responsibilities

Verifiers obtain sealed bytes independently where possible, supply an externally trusted signer/topology identity and verify format, canonical decoding, compression, hashes, Merkle roots, signatures, previous links and routing epochs. They distinguish self-consistent embedded keys from trusted identity and never infer factual truth or witnessed finality from a valid segment.

Follow `G9P-format-v1.md`, `G9P-format-v2.md`, `G9P-routing-epochs-v1.md`, `G9P-signer-trust-operations-v1.md` and the backup/rebuild procedures. Record tool version, trusted-key inputs, exact object hashes and any gaps.

## Incident responder responsibilities

Responders prioritize custody and evidence preservation over availability. They may stop ingestion, mark a service not-ready, isolate credentials and restore exact verified copies into fresh storage. They must not delete intake/outbox state, mutate sealed history, generate replacement identities or disclose customer content in diagnostics.

Use `G9P-incident-runbooks-v1.md` for key compromise, corrupt/missing storage, witness gaps and connector backlog. Escalate cryptographic ambiguity, conflicting event identity or missing trusted bytes as assurance incidents.

## Change and handover record

Every operational change records approver, time, software commit, configuration identity, key IDs, routing epoch, pre/post readiness, verification result and rollback criteria. Handover includes current limitations: no production KMS/HSM, TLS identity layer, checkpoint/witness service, active-active writer or uptime SLA.

This manual consolidates roles; detailed procedures remain authoritative in the linked public documents. It assumes no customer business schema and does not grant production approval.
