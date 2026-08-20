import { resolve } from "node:path";

function manifestError(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function exact(value, fields, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) manifestError("INSTALLATION_MANIFEST", `${name} has unexpected fields`);
}

export function validateInstallationManifest(manifest, { config, signers }) {
  exact(manifest, ["kind", "version", "product", "installationId", "createdAt", "custodyMode", "dataDirectory", "signerSocketPath", "keys"], "Installation manifest");
  if (manifest.kind !== "g9p-installation" || manifest.version !== 1 || manifest.product !== "Glare•9 Provenance") manifestError("INSTALLATION_MANIFEST", "Installation manifest identity is invalid");
  if (typeof manifest.installationId !== "string" || !/^[0-9a-f]{64}$/u.test(manifest.installationId)) manifestError("INSTALLATION_MANIFEST", "Installation identifier is invalid");
  if (typeof manifest.createdAt !== "string" || new Date(manifest.createdAt).toISOString() !== manifest.createdAt) manifestError("INSTALLATION_MANIFEST", "Installation timestamp is invalid");
  if (manifest.custodyMode !== config.custodyMode) manifestError("INSTALLATION_CUSTODY", "Configured custody mode does not match the installation manifest");
  if (resolve(manifest.dataDirectory) !== config.dataDirectory) manifestError("INSTALLATION_DATA_DIRECTORY", "Configured data directory does not match the installation manifest");
  const expectedSocketPath = config.custodyMode === "separated" ? config.signerSocketPath : null;
  if (manifest.signerSocketPath !== expectedSocketPath) manifestError("INSTALLATION_SIGNER_SOCKET", "Configured signer socket does not match the installation manifest");
  exact(manifest.keys, ["segment", "topology", "checkpoint"], "Installation key set");
  for (const role of ["segment", "topology", "checkpoint"]) {
    exact(manifest.keys[role], ["algorithm", "keyId"], `Installation ${role} key`);
    if (manifest.keys[role].algorithm !== "ed25519" || manifest.keys[role].keyId !== signers[role].keyId) manifestError("INSTALLATION_KEY_ID", `Configured ${role} signer does not match the installation manifest`);
  }
  return Object.freeze({ installationId: manifest.installationId, custodyMode: manifest.custodyMode });
}
