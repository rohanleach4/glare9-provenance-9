# G9P signing-custody contract v1

## Purpose

G9P writers accept a neutral Ed25519 signing boundary so a Glare•9 Provenance installation can keep private keys either inside its integrated local key store or, optionally, inside a separately running self-hosted Glare•9 signer. The custody choice does not change authenticated `.g9p` formats, key identifiers or offline verifier behavior.

Glare•9 Provenance must not require a third-party signing, cloud, telemetry or online-verification service. Integrated custody is the self-contained default. Separated custody is an optional installation profile and must never become an implicit dependency or a silent fallback path.

## Signer shape

A callback-backed signer supplies:

- `algorithm`: exactly `ed25519`;
- `keyId`: the G9P public-key identifier derived from `publicKeyDer`;
- `publicKeyDer`: the 44-byte Ed25519 SPKI DER public key;
- `sign(messageBytes)`: an asynchronous operation returning a 64-byte Ed25519 signature.

The callback receives an exact 32-byte, domain-separated G9P commitment. It must sign those bytes as the Ed25519 message without hashing, encoding or prefixing them again. The core validates the returned length and verifies every custody signature against `publicKeyDer` before any sealed object is published.

Local signers may also supply a Node.js private-key object. Installed integrated custody uses encrypted local key files; unencrypted automatically generated development files remain a compatibility path only.

## Installation profiles

**Integrated Custody** keeps the encrypted segment, topology-authority and checkpoint-publisher keys in the installation's protected local key directory. It requires no additional process or network dependency.

**Separated Custody** keeps those encrypted keys in a separately running self-hosted Glare•9 signer. The ledger uses a local Unix-domain socket and receives only public identities and signatures. Historical verification never depends on that signer. If signing is unavailable, accepted intake remains bounded and durable, but the ledger must not publish unsigned evidence or fall back to integrated custody.

The selected profile and public key identifiers are recorded in the installation manifest. Changing custody after ledger history exists is a forward key-custody migration and rotation exercise; editing one environment variable is not sufficient.

## Operational requirements

A custody implementation must fail closed on timeout, authorization failure, unavailable or disabled keys, identity mismatch and malformed output. Retry policy must preserve the same commitment bytes and must never publish an object until the returned signature has been verified locally.

Logs and metrics may record role, G9P key ID, latency, availability class and redacted error codes. They must not record customer event content, canonical payloads, signing messages, passphrases, private keys or arbitrary exception text.

Qualification records bind the installation identifier, custody profile, public key IDs, software commit, configuration identity, recovery evidence and applicable segment trust-bundle position.
