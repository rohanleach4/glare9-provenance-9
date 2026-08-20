import { createConnection } from "node:net";

import { publicKeyId } from "@glare9/provenance";

const MAX_RESPONSE_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;
const ROLES = new Set(["segment", "topology", "checkpoint"]);

function signerError(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function exact(value, fields) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...fields].sort().join("\0");
}

export function requestSigner(socketPath, request, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (typeof socketPath !== "string" || socketPath.length === 0) throw signerError("SIGNER_SOCKET_PATH", "Signer socket path is required");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) throw signerError("SIGNER_TIMEOUT", "Signer timeout must be between 100 and 60,000 milliseconds");
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let settled = false;
    let received = Buffer.alloc(0);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error === undefined) resolve(value); else reject(error);
    };
    const timer = setTimeout(() => finish(signerError("SIGNER_TIMEOUT", "Self-hosted signer did not respond within the configured timeout")), timeoutMs);
    timer.unref();
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      received = Buffer.concat([received, chunk]);
      if (received.byteLength > MAX_RESPONSE_BYTES) return finish(signerError("SIGNER_RESPONSE_LIMIT", "Self-hosted signer response exceeded its size limit"));
      const newline = received.indexOf(0x0a);
      if (newline === -1) return;
      let response;
      try { response = JSON.parse(received.subarray(0, newline).toString("utf8")); } catch (cause) { return finish(signerError("SIGNER_RESPONSE", "Self-hosted signer returned invalid JSON", cause)); }
      if (response?.ok !== true) return finish(signerError(typeof response?.code === "string" ? response.code : "SIGNER_REJECTED", "Self-hosted signer rejected the operation"));
      return finish(undefined, response);
    });
    socket.once("error", (cause) => finish(signerError("SIGNER_UNAVAILABLE", "Self-hosted signer is unavailable", cause)));
    socket.once("end", () => finish(signerError("SIGNER_RESPONSE", "Self-hosted signer closed without a complete response")));
  });
}

export async function loadSocketSigner(socketPath, role, options = {}) {
  if (!ROLES.has(role)) throw signerError("SIGNER_ROLE", "Signer role is unsupported");
  const identity = await requestSigner(socketPath, { kind: "g9p-signer-request", version: 1, operation: "identity", role }, options);
  if (!exact(identity, ["ok", "kind", "version", "role", "algorithm", "keyId", "publicKey"])) throw signerError("SIGNER_IDENTITY", "Self-hosted signer identity response has unexpected fields");
  let publicKeyDer;
  try { publicKeyDer = Buffer.from(identity.publicKey, "base64"); } catch (cause) { throw signerError("SIGNER_IDENTITY", "Self-hosted signer public key is invalid", cause); }
  if (identity.kind !== "g9p-signer-response" || identity.version !== 1 || identity.role !== role || identity.algorithm !== "ed25519" || publicKeyDer.byteLength !== 44 || identity.keyId !== publicKeyId(publicKeyDer)) {
    throw signerError("SIGNER_IDENTITY", "Self-hosted signer identity does not match the G9P Ed25519 profile");
  }
  return Object.freeze({
    algorithm: identity.algorithm,
    keyId: identity.keyId,
    publicKeyDer: Uint8Array.from(publicKeyDer),
    async sign(messageBytes) {
      if (!(messageBytes instanceof Uint8Array) || messageBytes.byteLength !== 32) throw signerError("SIGNER_MESSAGE", "Self-hosted signer accepts only 32-byte G9P commitments");
      const response = await requestSigner(socketPath, { kind: "g9p-signer-request", version: 1, operation: "sign", role, message: Buffer.from(messageBytes).toString("base64") }, options);
      if (!exact(response, ["ok", "kind", "version", "role", "algorithm", "keyId", "signature"]) || response.kind !== "g9p-signer-response" || response.version !== 1 || response.role !== role || response.algorithm !== identity.algorithm || response.keyId !== identity.keyId) {
        throw signerError("SIGNER_RESPONSE", "Self-hosted signer response identity changed");
      }
      const signature = Buffer.from(response.signature, "base64");
      if (signature.byteLength !== 64 || signature.toString("base64") !== response.signature) throw signerError("SIGNER_SIGNATURE", "Self-hosted signer returned an invalid Ed25519 signature encoding");
      return signature;
    },
  });
}
