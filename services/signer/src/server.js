import { chmod, mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname } from "node:path";

const MAX_REQUEST_BYTES = 16 * 1024;
const ROLES = new Set(["segment", "topology", "checkpoint"]);

function exact(value, fields) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...fields].sort().join("\0");
}

function send(socket, value) {
  socket.end(`${JSON.stringify(value)}\n`);
}

function canonicalBase64(value, expectedBytes) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.byteLength === expectedBytes && bytes.toString("base64") === value ? bytes : null;
}

function handleRequest(request, signers, audit) {
  if (request?.kind !== "g9p-signer-request" || request.version !== 1 || !ROLES.has(request.role)) return { code: "SIGNER_REQUEST" };
  const signer = signers[request.role];
  if (request.operation === "identity" && exact(request, ["kind", "version", "operation", "role"])) {
    audit({ operation: "identity", role: request.role, keyId: signer.keyId, status: "allowed" });
    return { response: { ok: true, kind: "g9p-signer-response", version: 1, role: request.role, algorithm: signer.algorithm, keyId: signer.keyId, publicKey: Buffer.from(signer.publicKeyDer).toString("base64") } };
  }
  if (request.operation !== "sign" || !exact(request, ["kind", "version", "operation", "role", "message"])) return { code: "SIGNER_REQUEST" };
  const message = canonicalBase64(request.message, 32);
  if (message === null) return { code: "SIGNER_MESSAGE" };
  return { signer, message };
}

export function createSignerServer({ socketPath, socketMode = 0o600, signers, audit = () => {} }) {
  if (process.platform === "win32") throw new Error("Separated custody currently requires Unix-domain socket support");
  for (const role of ROLES) {
    const signer = signers?.[role];
    if (signer?.algorithm !== "ed25519" || typeof signer.sign !== "function" || !(signer.publicKeyDer instanceof Uint8Array)) throw new Error(`A valid ${role} signer is required`);
  }
  const server = createServer((socket) => {
    socket.setTimeout(5_000, () => socket.destroy());
    let received = Buffer.alloc(0);
    let handled = false;
    socket.on("data", async (chunk) => {
      if (handled) return;
      received = Buffer.concat([received, chunk]);
      if (received.byteLength > MAX_REQUEST_BYTES) { handled = true; return send(socket, { ok: false, code: "SIGNER_REQUEST_LIMIT" }); }
      const newline = received.indexOf(0x0a);
      if (newline === -1) return;
      handled = true;
      let request;
      try { request = JSON.parse(received.subarray(0, newline).toString("utf8")); } catch { return send(socket, { ok: false, code: "SIGNER_REQUEST" }); }
      const result = handleRequest(request, signers, audit);
      if (result.code !== undefined) return send(socket, { ok: false, code: result.code });
      if (result.response !== undefined) return send(socket, result.response);
      try {
        const signature = await result.signer.sign(result.message);
        if (!(signature instanceof Uint8Array) || signature.byteLength !== 64) return send(socket, { ok: false, code: "SIGNER_SIGNATURE" });
        audit({ operation: "sign", role: request.role, keyId: result.signer.keyId, status: "allowed" });
        return send(socket, { ok: true, kind: "g9p-signer-response", version: 1, role: request.role, algorithm: result.signer.algorithm, keyId: result.signer.keyId, signature: Buffer.from(signature).toString("base64") });
      } catch {
        audit({ operation: "sign", role: request.role, keyId: result.signer.keyId, status: "failed" });
        return send(socket, { ok: false, code: "SIGNER_OPERATION" });
      }
    });
    socket.on("error", () => {});
  });
  server.maxConnections = 64;
  return Object.freeze({
    async listen() {
      await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
      await chmod(socketPath, socketMode);
      return socketPath;
    },
    async close() {
      if (!server.listening) return;
      await new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    },
  });
}
