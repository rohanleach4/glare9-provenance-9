# G9P transport identity and credential rotation profile v1

The ledger service supports TLS 1.3 when certificate/key paths are configured and optional mutual TLS when a client CA is supplied. Production deployments terminate TLS either in-process or at an approved identity-aware proxy; plaintext binding is restricted to local development or a protected loopback hop.

Bearer authorization accepts one to four distinct credentials per role. Rotation order is: configure new plus old on the ledger, configure clients with new plus old, verify new use, remove old from clients, then remove old from the ledger. The connector retries an identical request with the next credential only after HTTP 401, preserving event identity and request body. Ingestion and administration token sets cannot overlap.

Certificates and tokens are external secrets and are never committed. Production authorization must bind service identity to least-privilege roles, restrict routing administration separately, record issuance/revocation externally and rehearse expiry/rotation. TLS does not establish event factual truth or signer trust.
