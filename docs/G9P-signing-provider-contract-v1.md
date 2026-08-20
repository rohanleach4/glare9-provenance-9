# G9P signing-provider contract v1

## Purpose

G9P writers accept a provider-neutral Ed25519 signer so production deployments can keep private keys behind a KMS, HSM or customer-controlled signing service. The signing boundary does not change the authenticated `.g9p` formats, key identifiers or verifier behavior.

This contract establishes the application boundary only. A provider adapter is production-ready only after its custody, authorization, audit, availability, rotation and recovery behavior has been qualified in the target environment.

## Signer shape

A callback-backed signer supplies:

- `algorithm`: exactly `ed25519`;
- `keyId`: the G9P public-key identifier derived from `publicKeyDer`;
- `publicKeyDer`: the 44-byte Ed25519 SPKI DER public key;
- `sign(messageBytes)`: an asynchronous operation returning a 64-byte Ed25519 signature.

The callback receives an exact 32-byte, domain-separated G9P commitment. It must sign those bytes as the Ed25519 message without hashing, encoding or prefixing them again. The core validates the returned length and verifies every provider signature against `publicKeyDer` before any sealed object is published.

Local signers may continue to supply a Node.js private-key object. That compatibility path is for development and migration; production adapters should expose only the callback and public identity.

## Operational requirements

A production adapter must fail closed on timeout, authorization failure, throttling, disabled or scheduled-for-deletion keys, identity mismatch and malformed provider output. It must not fall back to a local key. Retry policy must preserve the same commitment bytes and must never publish an object until the returned signature has been verified locally.

Provider logs and metrics may record provider key references, G9P key IDs, latency, availability class and redacted error codes. They must not record customer event content, canonical payloads, signing messages, credentials or arbitrary provider exception text.

Qualification records must bind the provider key/version, exported public key, derived G9P key ID, adapter version, authorization policy, signing algorithm, test commit and applicable segment trust-bundle position.

## Next adapters

Provider-specific adapters belong behind this contract. Selection should be based on verified Ed25519 support and the deployment environment; the core package does not select a cloud or HSM vendor.
