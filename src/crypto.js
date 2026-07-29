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
  };
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
