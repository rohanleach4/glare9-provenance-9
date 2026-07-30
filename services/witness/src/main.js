import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { publicKeyId, writeWitnessReceipt } from "@glare9/provenance";

function required(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

const privateKey = createPrivateKey({ key: await readFile(resolve(required("G9P_WITNESS_PRIVATE_KEY_PATH"))), format: "der", type: "pkcs8" });
const publicKey = createPublicKey(privateKey);
const publicKeyDer = Buffer.from(publicKey.export({ format: "der", type: "spki" }));
const witness = { algorithm: "ed25519", keyId: publicKeyId(publicKeyDer), privateKey, publicKey, publicKeyDer };
const trustedPublisherKeyIds = required("G9P_TRUSTED_CHECKPOINT_PUBLISHER_KEY_IDS").split(",").map((value) => value.trim());
const result = await writeWitnessReceipt({
  outputPath: resolve(required("G9P_WITNESS_RECEIPT_PATH")),
  checkpointBytes: await readFile(resolve(required("G9P_CHECKPOINT_PATH"))),
  witness,
  trustedPublisherKeyIds,
});
process.stdout.write(`${JSON.stringify({ status: "witnessed", ...result })}\n`);
