# What you need for a commercial Provenance•9 release

Provenance•9 is an Apache-2.0-licensed, Foundation-stage evidence ledger. You may evaluate, modify, deploy and sell services built around it under the licence terms. The amount of qualification you need depends on what you intend to claim, the evidence you will store and the environment in which customers will rely on it.

This guide helps adopters choose a proportionate path. It is technical guidance, not legal, regulatory, insurance or certification advice.

## Start with the intended use

### 1. Evaluation, demonstration or development

Use this path when evidence is disposable and nobody will rely on it for a contractual, regulatory or audit decision.

Recommended minimum:

- use a tagged source release or a recorded Git commit;
- run `npm ci` and `npm run test:all` on Node.js 24/npm 11;
- use development-only data and credentials;
- keep the service on a private interface;
- exercise the demo, offline verifier and one backup/restore cycle; and
- describe the result as an evaluation, not production assurance.

You do not normally need an independent auditor, production certificate authority, high-availability design or formal incident process for this path.

### 2. Internal pilot or low-risk commercial trial

Use this path when a limited group will rely on the system, but the evidence is not yet used for regulated, safety-critical or high-value decisions.

In addition to the evaluation minimum:

- create a named installation with its own installation identifier;
- select Integrated Custody or the optional self-hosted Separated Custody profile;
- protect and back up signing keys, passphrases and external trust bundles;
- configure TLS/mTLS and separate ingestion and administration credentials;
- configure authenticated metrics, readiness checks and basic alerts;
- use durable storage and test exact-byte backup, restore and offline verification;
- record retention, privacy and incident-handling decisions;
- run the applicable connector test for the actual database, or record the connector as not applicable; and
- record a deployment-owner decision naming the release, configuration, completed exercises and accepted residual risks.

### 3. Commercial Foundation deployment

Use this path when customers will rely on evidence operationally, while accepting the published Foundation-stage limitations.

In addition to the pilot controls:

- deploy from a signed tag and verify the source archive checksum and SBOM;
- use installation-specific production identities rather than disposable qualification identities;
- rehearse key rotation, credential rotation, service restart, corrupt-storage response, backup restoration and connector backlog recovery;
- set measured resource, retention, recovery and alert thresholds for the intended host;
- preserve trusted heads or checkpoints outside the writer/storage boundary;
- review the threat model and explicitly accept or mitigate each applicable residual risk;
- disclose that the evidence formats are Candidate and the software is Foundation-stage;
- disclose whether independent security, cryptographic or interoperability review has occurred; and
- avoid claims of regulated assurance, high availability, witnessed finality or an SLA unless separately established.

A deployment owner may perform and record this review themselves. A paid independent assessment is recommended where the risk justifies it, but it is not a project-level licence or release prerequisite.

### 4. Regulated, high-assurance or high-value deployment

The customer's own legal, compliance, security and audit requirements govern this path. The customer should engage reviewers who are independent of both the software maintainer and the deployment operator where that independence is required.

Likely additional work includes:

- independent security review of the threat model, parser boundaries and cryptographic design;
- an externally authored verifier consuming the language-neutral conformance vectors;
- production PKI, certificate issuance, rotation and revocation procedures;
- HSM, KMS or another customer-approved signing-key custody design;
- independently administered witnesses, retained trusted heads or fork monitoring;
- qualified database, storage, backup, failover, disaster-recovery and power-loss behavior;
- privacy impact assessment, retention/legal-hold controls and jurisdiction-specific review;
- penetration testing, sustained-load/resource-exhaustion testing and dependency governance;
- change control, separation of duties and incident exercises with retained evidence; and
- contractual support, availability, recovery and verification commitments.

Those activities are deployment-specific. A successful audit of one installation does not automatically certify another customer's infrastructure or a different database connector.

## Responsibility boundary

| Area | Provenance•9 project provides | Deployment owner/customer decides | Independent reviewer may assess |
|---|---|---|---|
| evidence format | specifications, frozen vectors and two repository verifiers | accepted versions and trust roots | ambiguity, interoperability and cryptographic construction |
| software | source, tests, fuzzing, scans, SBOM and release evidence | approved release, patches and operating environment | secure design, implementation and supply chain |
| identity and keys | integrated and separated custody profiles, rotation procedures | CA, key ownership, backup, revocation and role separation | custody strength and governance |
| storage and recovery | create-only reference storage, exact-byte backup/restore tools | storage platform, retention, RPO/RTO and disaster recovery | durability and recovery evidence |
| connectors | MySQL reference connector and contract test kit | actual database, grants, TLS, schema and failover | environment-specific least privilege and resilience |
| operations | health, readiness, metrics, alerts and runbooks | monitoring, staffing, escalation and incident decisions | operational control design and exercise evidence |
| assurance claims | documented capabilities and residual risks | what the deployment claims and relies upon | whether evidence supports those claims |

## Database and connector portability

The bundled connector is for MySQL. Its local TLS and least-privilege qualification applies only to the tested MySQL connector, driver and environment. It does not qualify PostgreSQL, MariaDB, SQL Server, SQLite or a customer's differently configured MySQL service.

For another database, implement the connector contract without changing permanent `.g9p` verification semantics. Repeat ordering, uncertain-acceptance recovery, quarantine, receipt reconciliation, least-privilege, TLS, failover and backlog exercises in the selected environment.

## Deployment decision record

Before operational reliance, retain a short decision record containing:

- deployment owner and date;
- release tag, Git commit and verified archive checksum;
- installation identifier and custody profile;
- signer, topology and checkpoint public key identifiers;
- storage, backup, database and transport profiles;
- tests and exercises completed in the named environment;
- open critical/high findings, which must be zero;
- other accepted findings and residual risks;
- independent reviews completed, planned or explicitly unavailable;
- assurance wording that may be used externally;
- excluded claims; and
- rollback, review and requalification triggers.

Requalify after a material format, signer, trust, database, storage, operating-system, certificate-authority or topology change.

## Known Foundation-stage boundaries

The reference deployment is intentionally narrow:

- single authoritative ledger writer, without an HA or denial-of-service guarantee;
- no automatic protection against host destruction or loss of every backup;
- no automatic public fork monitor or threshold routing authority;
- a compromised writer and storage operator may rewrite recent history for a reader that retained no trusted head or independent witness;
- a compromised service host can reach the configured signing operation;
- no blanket production, regulated, legal or factual-truth claim; and
- no claim that every assertion submitted to the ledger is honest or complete.

These boundaries may be acceptable for evaluation or a controlled Foundation deployment. Higher-assurance customers can address them through deployment architecture, independent witnesses, stronger custody, external review and contracted engineering.

## Commercial help and contracted development

Commercial support can include deployment planning, connector development, integration, evidence export, custody integration, witness operation, performance qualification, documentation and audit-readiness engineering. Customers remain free to perform this work themselves or appoint any supplier or auditor; purchasing services is not a condition of the Apache 2.0 licence.

To discuss commercial support or contracted development, contact **hello@glare9.com**. Do not send credentials, private keys, customer evidence or confidential vulnerability details by ordinary email.

Security vulnerabilities should be reported through the private process in [`SECURITY.md`](./SECURITY.md).
