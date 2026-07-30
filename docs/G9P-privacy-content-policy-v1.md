# G9P privacy, retention and customer-content policy v1

## Data minimisation

The ledger records customer-supplied evidence opaquely and does not infer a lawful basis. Integrators must minimise payloads, prefer commitments or governed references for sensitive/large content, avoid secrets and define purpose, controller/processor roles, residency and access before ingestion. Metrics and logs must not contain customer-controlled labels or payloads.

## Immutability and deletion

Sealed `.g9p` bytes are never edited or deleted to simulate correction. Corrections and withdrawals are new events linked to the superseded assertion. Where erasure is legally required, deployments should keep personal content outside the ledger, record only a non-reversible commitment and delete the governed external object under an approved retention schedule.

A deletion-reference event may record that an external object was deleted, why, under whose authority and which commitment it previously satisfied. It must not reproduce the deleted content. Cryptographic hashes can remain personal data when linkable or guessable; hashing alone is not anonymisation.

## Retention classes

Deployments must classify sealed evidence, accepted/provisional recovery state, connector outbox rows, dead letters, backups, projections, logs and monitoring data separately. Sealed-history retention must match the stated assurance purpose. Temporary recovery state is retained until sealing and reconciliation. Outbox and projection copies may be removed only under their verified procedures. Backup expiry must not create an undisclosed history gap.

Legal hold overrides ordinary expiry but does not authorize hidden rewriting. Expiry or destruction must produce an external auditable record and preserve any required trusted head/checkpoint needed to describe the retained history honestly.

## Access and export

Access follows least privilege by role. Customer exports include exact sealed bytes, applicable routing/checkpoint objects, trusted-key context and verification instructions. A valid export proves recorded history, not factual truth or completeness outside the supplied trust boundary.

Before production use, the customer and operator must approve data inventory, lawful basis, retention durations, subject-request handling, backup destruction, breach notification and cross-border processing. This technical policy is not legal advice.
