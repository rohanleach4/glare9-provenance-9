/**
 * This is the Node.js standard cryptography library node:crypto.
 * This has nothing to do with cryptocurrency, tokens, wallets, blockchains, or mining.
 * No cryptocurrency mining is happening; and your electricity bill is safe. 😉
 */
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";

import { invariant } from "./errors.js";

function lengthPrefix(length) {
  const result = Buffer.allocUnsafe(8);
  result.writeBigUInt64BE(BigInt(length));
  return result;
}

export function domainHash(domain, ...parts) {
  invariant(typeof domain === "string" && domain.length > 0, "HASH_DOMAIN", "Hash domain must be a non-empty string");
  const hash = createHash("sha256");
  const domainBytes = Buffer.from(`G9P\0${domain}`, "utf8");
  hash.update(lengthPrefix(domainBytes.length));
  hash.update(domainBytes);

  for (const part of parts) {
    const bytes = Buffer.from(part);
    hash.update(lengthPrefix(bytes.length));
    hash.update(bytes);
  }

  return hash.digest();
}

export function toHex(bytes) {
  return Buffer.from(bytes).toString("hex");
}

export function fromHex(value, expectedBytes) {
  invariant(typeof value === "string" && /^[0-9a-f]+$/u.test(value) && value.length % 2 === 0, "HEX_VALUE", "Expected lowercase hexadecimal text");
  const bytes = Buffer.from(value, "hex");
  if (expectedBytes !== undefined) {
    invariant(bytes.length === expectedBytes, "HEX_LENGTH", `Expected ${expectedBytes} bytes of hexadecimal data`);
  }
  return bytes;
}

export function exportPublicKey(publicKey) {
  return Buffer.from(publicKey.export({ format: "der", type: "spki" }));
}

export function importPublicKey(publicKeyDer) {
  return createPublicKey({ key: Buffer.from(publicKeyDer), format: "der", type: "spki" });
}

export function publicKeyId(publicKeyDer) {
  return toHex(domainHash("public-key-id-v1", publicKeyDer));
}

export function generateSigner() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyDer = exportPublicKey(publicKey);
  return {
    algorithm: "ed25519",
    keyId: publicKeyId(publicKeyDer),
    privateKey,
    publicKey,
    publicKeyDer,
    async sign(messageBytes) {
      return cryptoSign(null, Buffer.from(messageBytes), privateKey);
    },
  };
}

export function validateSigner(signer, code = "SIGNER_IDENTITY") {
  invariant(signer?.algorithm === "ed25519", code, "An Ed25519 signer is required");
  invariant(signer.publicKeyDer instanceof Uint8Array, code, "Signer publicKeyDer must contain an Ed25519 SPKI public key");
  invariant(typeof signer.keyId === "string" && signer.keyId === publicKeyId(signer.publicKeyDer), code, "Signer keyId does not match its public key");
  invariant(typeof signer.sign === "function" || signer.privateKey, code, "Signer must provide an asynchronous sign operation or a local private key");
  let publicKey;
  try { publicKey = importPublicKey(signer.publicKeyDer); } catch { invariant(false, code, "Signer publicKeyDer is not an importable Ed25519 public key"); }
  invariant(publicKey.asymmetricKeyType === "ed25519", code, "Signer publicKeyDer is not an Ed25519 public key");
  return signer;
}

export async function signDomainWithSigner(signer, domain, commitmentBytes) {
  validateSigner(signer);
  const message = domainHash(domain, commitmentBytes);
  const signature = typeof signer.sign === "function"
    ? await signer.sign(Uint8Array.from(message))
    : cryptoSign(null, message, signer.privateKey);
  invariant(signature instanceof Uint8Array && signature.byteLength === 64, "SIGNER_SIGNATURE", "Ed25519 signer returned an invalid signature");
  const publicKey = importPublicKey(signer.publicKeyDer);
  invariant(cryptoVerify(null, message, publicKey, signature), "SIGNER_SIGNATURE", "Signer returned a signature that does not match its public key");
  return Buffer.from(signature);
}

export function signCommitment(privateKey, commitmentBytes) {
  return signDomainCommitment(privateKey, "segment-signature-v1", commitmentBytes);
}

export function signDomainCommitment(privateKey, domain, commitmentBytes) {
  const message = domainHash(domain, commitmentBytes);
  return cryptoSign(null, message, privateKey);
}

export function verifyCommitment(publicKey, commitmentBytes, signature) {
  return verifyDomainCommitment(publicKey, "segment-signature-v1", commitmentBytes, signature);
}

export function verifyDomainCommitment(publicKey, domain, commitmentBytes, signature) {
  const message = domainHash(domain, commitmentBytes);
  return cryptoVerify(null, message, publicKey, signature);
}
