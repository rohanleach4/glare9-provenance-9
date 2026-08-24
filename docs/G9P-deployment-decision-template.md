# Provenance•9 deployment decision template

Keep the completed record with the deployment's protected operational evidence. Do not commit credentials, private keys, customer evidence or confidential infrastructure details.

## Identity

- Deployment name:
- Deployment owner:
- Decision date:
- Intended use and users:
- Release tag:
- Git commit:
- Verified source-archive SHA-256:
- Installation identifier:
- Custody profile:
- Public segment, topology and checkpoint key identifiers:

## Environment

- Host/operating-system profile:
- Storage and durability assumptions:
- Backup destination and restore result:
- TLS/mTLS and certificate-authority profile:
- Database connector and qualification result, or not applicable:
- Monitoring, alerting and log-retention profile:
- Incident and escalation owner:

## Evidence reviewed

- Aggregate tests:
- Coverage gates:
- Dependency audit:
- Repository/security scan:
- Installation pilot:
- Operations/TLS exercise:
- Backup/restore exercise:
- Connector exercise:
- Other environment-specific tests:

## Findings and assurance

- Open critical findings (must be zero):
- Open high findings (must be zero):
- Other accepted findings:
- Independent security/cryptographic review completed, planned or unavailable:
- External verifier confirmation completed, planned or unavailable:
- Assurance wording permitted externally:
- Claims explicitly excluded:
- Residual risks accepted or mitigated:

## Decision

- Decision: approve controlled reliance / continue pilot / do not deploy
- Conditions and expiry/review date:
- Rollback criteria:
- Changes that require requalification:
- Deployment-owner name and recorded acknowledgement:
