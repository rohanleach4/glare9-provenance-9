import { createPrivateKey, createPublicKey, sign as cryptoSign } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

import { publicKeyId } from "@glare9/provenance";

function custodyError(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

export async function readProtectedPassphrase(path) {
  const details = await stat(path);
  if (!details.isFile()) throw custodyError("SIGNER_PASSPHRASE_FILE", "Signer passphrase path must identify a regular file");
  if (process.platform !== "win32" && (details.mode & 0o077) !== 0) throw custodyError("SIGNER_PASSPHRASE_PERMISSIONS", "Signer passphrase file must not be accessible by group or other users");
  const bytes = await readFile(path);
  if (bytes.byteLength < 32 || bytes.byteLength > 4096) throw custodyError("SIGNER_PASSPHRASE_LENGTH", "Signer passphrase must contain between 32 and 4,096 bytes");
  return bytes;
}

export async function loadCustodySigner(path, passphrase) {
  let privateKey;
  try { privateKey = createPrivateKey({ key: await readFile(path), format: "pem", passphrase }); } catch (cause) { throw custodyError("SIGNER_KEY_LOAD", "Signer key could not be decrypted or imported", cause); }
  const publicKey = createPublicKey(privateKey);
  const publicKeyDer = Buffer.from(publicKey.export({ format: "der", type: "spki" }));
  return Object.freeze({
    algorithm: "ed25519",
    keyId: publicKeyId(publicKeyDer),
    publicKeyDer: Uint8Array.from(publicKeyDer),
    async sign(messageBytes) { return cryptoSign(null, Buffer.from(messageBytes), privateKey); },
  });
}
