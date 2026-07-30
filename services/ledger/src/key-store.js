import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
} from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
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

async function loadSigner(privateKeyPath) {
  const privateKeyDer = await readFile(privateKeyPath);
  const privateKey = createPrivateKey({ key: privateKeyDer, format: "der", type: "pkcs8" });
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

async function loadOrCreateNamedSigner(dataDirectory, name) {
  const keyDirectory = join(dataDirectory, "keys");
  const privateKeyPath = join(keyDirectory, `${name}.pk8`);
  const publicKeyPath = join(keyDirectory, `${name}.spki`);
  await mkdir(keyDirectory, { recursive: true, mode: 0o700 });

  try {
    return await loadSigner(privateKeyPath);
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

  return loadSigner(privateKeyPath);
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
