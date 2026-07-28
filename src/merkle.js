import { domainHash } from "./crypto.js";
import { invariant } from "./errors.js";

export function merkleRoot(recordHashes) {
  invariant(Array.isArray(recordHashes), "MERKLE_INPUT", "Merkle input must be an array of hashes");

  if (recordHashes.length === 0) {
    return domainHash("merkle-empty-v1");
  }

  let level = recordHashes.map((hash) => {
    invariant(hash instanceof Uint8Array && hash.byteLength === 32, "MERKLE_HASH", "Merkle leaves must be 32-byte hashes");
    return domainHash("merkle-leaf-v1", hash);
  });

  while (level.length > 1) {
    const next = [];
    for (let index = 0; index < level.length; index += 2) {
      if (index + 1 === level.length) {
        next.push(level[index]);
      } else {
        next.push(domainHash("merkle-node-v1", level[index], level[index + 1]));
      }
    }
    level = next;
  }

  return level[0];
}
