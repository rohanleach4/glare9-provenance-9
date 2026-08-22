# G9P implementation threat model v1

## Status and scope

This is the public implementation threat model for the Foundation Glare•9 Provenance reference system. It covers writers, readers, connectors, sealed storage, recovery state, signing keys, service credentials and hostile `.g9p` input. It is an engineering artifact, not an independent security assessment; external review is a separate go-live gate.

The protected claim is narrow: accepted evidence is durably retained, sealed history is tamper-evident, and conforming readers can detect unsupported mutation, omission or reordering within the evidence they receive. The ledger does not prove that an assertion is true, that an authenticated source was honest, or that an operator supplied complete history.

## Assets and trust boundaries

| Asset | Required property | Principal boundary |
|---|---|---|
| canonical event identity | identical meaning produces the committed bytes; conflicting event IDs fail | connector → ingestion service |
| durable accepted intake | acknowledged custody survives restart without duplication | service process → recovery filesystem |
| sealed `.g9p` object | create-only exact bytes, signature and chain commitments | writer → sealed storage |
| routing history | signed, complete, forward-only epoch transitions | administrator → topology authority |
| signing identity | private key confidentiality and externally governed trust | key provider → writer/verifier |
| connector outbox | ordered retryable custody until ledger acceptance | application → MySQL connector |
| verifier result | bounded parsing and explicit trust status | untrusted bytes → reader |
| monitoring/diagnostics | operational utility without content or credential disclosure | service → operator tooling |

MySQL is outside the ledger trust boundary. It remains mutable and is neither required for offline verification nor authoritative after the ledger has returned durable acceptance.

## Adversaries and capabilities

The model considers a network attacker, malicious or compromised submitter, compromised connector credential, dishonest writer operator, storage operator able to delete/replace objects, compromised signing key, malicious verifier input, accidental administrator, and resource-exhaustion attacker. It also considers crashes and partial local writes as non-malicious fault sources.

The current single-node profile does not defend availability against host compromise, storage destruction or denial of service. Without an implemented witness, a writer and storage operator acting together can present a self-consistent replacement history to a reader that has no prior trusted head. External trust anchors, exact-byte backups and future witnesses are required to detect that class of equivocation.

## Threats and controls

| Threat | Existing control | Residual risk / required action |
|---|---|---|
| ambiguous or non-canonical values | deterministic binary encoding, strict field sets, minimal varints, full re-encoding | independent review of the specification and vectors |
| event-ID reuse with different content | domain-separated record hash and conflict rejection | compromised source may submit false but internally valid evidence |
| event movement between shards | deterministic routing plus authenticated routing policy | policy authority compromise can authorize a harmful forward transition |
| segment mutation or reordering | block hashes, Merkle root, exact file hash, signatures and previous links | deletion of a terminal suffix needs an external trusted head/witness |
| routing-history fork | signed descriptors, previous descriptor hash and complete old-head barrier | no threshold authority or public fork monitor yet |
| decompression bomb or hostile lengths | file, frame, collection, record and output ceilings before allocation/decompression | deployment memory limits and sustained-load qualification remain necessary |
| parser crash or differential interpretation | bounded fuzz/property tests and shared conformance vectors with a separate verifier | more languages and independent fuzzing remain desirable |
| partial sealing or acknowledgement loss | `.g9p.part`, file/directory sync, create-only promotion, durable intake and idempotent retry | physical power-loss guarantees depend on qualified storage |
| connector outage or uncertain acceptance | leases, identical retry, monotonic receipt reconciliation and dead letters | production-like MySQL failover/TLS qualification remains open |
| credential theft or replay | separate ingestion/admin credentials, bounded APIs, redacted diagnostics, TLS 1.3/mTLS and overlapping credential support | real deployment identity issuance, rotation and operator exercise remain open |
| signing-key theft | encrypted integrated custody, optional self-hosted separated custody, external trust bootstrap and forward revocation procedure | a compromised service account/host can still reach signing; site-specific custody exercise remains open |
| storage replacement or omission | offline verification, exact-byte backup, chain reconstruction, checkpoints and separately runnable reference witness | independently administered witness coverage and retained trusted heads remain deployment policy |
| customer-content disclosure | aggregate metrics, diagnostic redaction, schema-neutral connector and published privacy/content policy | deployment retention, access and lawful-basis decisions remain operator responsibilities |
| malicious dependency or build | lockfile, dependency audit, CodeQL, repository scanning, SBOM and reproducible signed-release procedure | the first public signed release and its two-person evidence review have not occurred |

## Trust decisions a verifier must make

A valid embedded Ed25519 key proves only self-consistency. A verifier must obtain trusted signer and topology-authority identities outside the object, decide which format/profile versions it accepts, enforce resource limits before parsing, require expected predecessor/epoch commitments when verifying a chain, and report missing history rather than reconnecting it.

Verification has distinct outcomes: structurally parsed, cryptographically self-consistent, trusted signer/authority, complete chain/topology, and externally witnessed. The current implementation supports the first four when the caller supplies trust and history; it must never report witnessed finality.

## Security invariants

1. No `accepted` receipt precedes durable intake publication.
2. No sealed object is overwritten or repaired in place.
3. Every committed event is decoded canonically and routes under the authenticated policy.
4. Every length and decompressed output is bounded before untrusted allocation.
5. Embedded keys are never promoted to trusted identity automatically.
6. Recovery derives authority from verified bytes, not filenames or mutable indexes.
7. A missing, conflicting or unsupported object fails closed.
8. Connectors never gain access to customer business tables through the ledger contract.

## Review and maintenance

Any permanent format, trust, storage, connector-custody or key-lifecycle change updates this document and its conformance/failure evidence. An independent reviewer must validate threat completeness, cryptographic construction, parser boundaries and residual-risk wording before production use. Findings remain open go-live items until explicitly resolved or accepted by the product owner.
