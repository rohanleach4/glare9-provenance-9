import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
} from "node:crypto";
import { mkdir, open, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { publicKeyId } from "@glare9/provenance";

async function writeExclusive(path, bytes, mode) {
  const handle = await open(path, "wx", mode);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function keyError(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

export async function readProtectedPassphrase(passphrasePath) {
  const details = await stat(passphrasePath);
  if (!details.isFile()) throw keyError("KEY_PASSPHRASE_FILE", "Signing-key passphrase path must identify a regular file");
  if (process.platform !== "win32" && (details.mode & 0o077) !== 0) {
    throw keyError("KEY_PASSPHRASE_PERMISSIONS", "Signing-key passphrase file must not be accessible by group or other users");
  }
  const bytes = await readFile(passphrasePath);
  if (bytes.byteLength < 32 || bytes.byteLength > 4096) throw keyError("KEY_PASSPHRASE_LENGTH", "Signing-key passphrase must contain between 32 and 4,096 bytes");
  return bytes;
}

export async function loadSignerFile(privateKeyPath, { passphrase } = {}) {
  const privateKeyDer = await readFile(privateKeyPath);
  let privateKey;
  try {
    privateKey = privateKeyDer.subarray(0, 27).toString("ascii").startsWith("-----BEGIN")
      ? createPrivateKey({ key: privateKeyDer, format: "pem", passphrase })
      : createPrivateKey({ key: privateKeyDer, format: "der", type: "pkcs8", passphrase });
  } catch (cause) {
    throw keyError("KEY_LOAD", "Signing key could not be decrypted or imported", cause);
  }
  const publicKey = createPublicKey(privateKey);
  const publicKeyDer = Buffer.from(publicKey.export({ format: "der", type: "spki" }));
  return {
    algorithm: "ed25519",
    keyId: publicKeyId(publicKeyDer),
    privateKey,
    publicKey,
    publicKeyDer,
  };
}

export function loadExternalSigner(privateKeyPath) {
  return loadSignerFile(privateKeyPath);
}

export async function loadProtectedSigner(privateKeyPath, passphrasePath) {
  return loadSignerFile(privateKeyPath, { passphrase: await readProtectedPassphrase(passphrasePath) });
}

export async function createEncryptedSigner(keyDirectory, name, passphrase) {
  if (!(passphrase instanceof Uint8Array) || passphrase.byteLength < 32) throw keyError("KEY_PASSPHRASE_LENGTH", "Signing-key passphrase must contain at least 32 bytes");
  await mkdir(keyDirectory, { recursive: true, mode: 0o700 });
  const privateKeyPath = join(keyDirectory, `${name}.pem`);
  const publicKeyPath = join(keyDirectory, `${name}.spki`);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = Buffer.from(privateKey.export({ format: "pem", type: "pkcs8", cipher: "aes-256-cbc", passphrase: Buffer.from(passphrase) }));
  const publicKeyDer = Buffer.from(publicKey.export({ format: "der", type: "spki" }));
  await writeExclusive(privateKeyPath, privateKeyPem, 0o600);
  await writeExclusive(publicKeyPath, publicKeyDer, 0o644);
  const signer = await loadSignerFile(privateKeyPath, { passphrase });
  return { signer, privateKeyPath, publicKeyPath };
}

async function loadOrCreateNamedSigner(dataDirectory, name) {
  const keyDirectory = join(dataDirectory, "keys");
  const privateKeyPath = join(keyDirectory, `${name}.pk8`);
  const publicKeyPath = join(keyDirectory, `${name}.spki`);
  await mkdir(keyDirectory, { recursive: true, mode: 0o700 });

  try {
    return await loadSignerFile(privateKeyPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyDer = Buffer.from(privateKey.export({ format: "der", type: "pkcs8" }));
  const publicKeyDer = Buffer.from(publicKey.export({ format: "der", type: "spki" }));

  try {
    await writeExclusive(privateKeyPath, privateKeyDer, 0o600);
    await writeExclusive(publicKeyPath, publicKeyDer, 0o644);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }

  return loadSignerFile(privateKeyPath);
}

export function loadOrCreateLocalSigner(dataDirectory) {
  return loadOrCreateNamedSigner(dataDirectory, "segment-signing-key");
}

export function loadOrCreateLocalTopologyAuthority(dataDirectory) {
  return loadOrCreateNamedSigner(dataDirectory, "topology-authority-key");
}

export function loadOrCreateLocalCheckpointPublisher(dataDirectory) {
  return loadOrCreateNamedSigner(dataDirectory, "checkpoint-publisher-key");
}
