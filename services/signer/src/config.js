import { resolve } from "node:path";

function required(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return resolve(value);
}

function socketMode(value = "0600") {
  if (!/^(?:0?[0-7]{3})$/u.test(value)) throw new Error("PROVENANCE_SIGNER_SOCKET_MODE must be a three-digit octal mode");
  const parsed = Number.parseInt(value, 8);
  if ((parsed & 0o006) !== 0) throw new Error("PROVENANCE_SIGNER_SOCKET_MODE must not allow access by other users");
  return parsed;
}

export function loadSignerConfig(environment = process.env) {
  return Object.freeze({
    socketPath: required(environment, "PROVENANCE_SIGNER_SOCKET_PATH"),
    socketMode: socketMode(environment.PROVENANCE_SIGNER_SOCKET_MODE),
    passphrasePath: required(environment, "PROVENANCE_SIGNER_PASSPHRASE_FILE"),
    keyPaths: Object.freeze({
      segment: required(environment, "PROVENANCE_SIGNER_SEGMENT_KEY_PATH"),
      topology: required(environment, "PROVENANCE_SIGNER_TOPOLOGY_KEY_PATH"),
      checkpoint: required(environment, "PROVENANCE_SIGNER_CHECKPOINT_KEY_PATH"),
    }),
  });
}
