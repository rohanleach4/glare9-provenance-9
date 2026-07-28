import { timingSafeEqual, randomUUID } from "node:crypto";
import { createServer } from "node:http";

import { G9pError } from "@glare9/provenance";

function tokenMatches(header, expectedToken) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7), "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function sendJson(response, status, payload) {
  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": bytes.length,
    "cache-control": "no-store",
  });
  response.end(bytes);
}

async function readJson(request, maxBytes) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maxBytes) {
      throw new G9pError("REQUEST_TOO_LARGE", `Request exceeds the ${maxBytes} byte limit`);
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    throw new G9pError("INVALID_JSON", "Request body is not valid JSON", { cause: error });
  }
}

function errorStatus(error) {
  if (error.code === "REQUEST_TOO_LARGE") return 413;
  if (error.code === "EVENT_ID_CONFLICT") return 409;
  if (new Set(["SEGMENT_WRITE", "COMPRESS_FAILED"]).has(error.code)) return 503;
  if (error instanceof G9pError) return 400;
  return 500;
}

function retryable(error) {
  if (!(error instanceof G9pError)) return true;
  return new Set(["SEGMENT_WRITE", "COMPRESS_FAILED"]).has(error.code);
}

export function createLedgerServer({ ledger, apiToken, maxBatchEvents = 500, maxRequestBytes = 8 * 1024 * 1024, logger = console }) {
  const server = createServer(async (request, response) => {
    const requestId = request.headers["x-request-id"] ?? randomUUID();
    try {
      const url = new URL(request.url, "http://ledger.local");
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { status: "ok" });
        return;
      }

      if (!tokenMatches(request.headers.authorization, apiToken)) {
        sendJson(response, 401, { code: "UNAUTHORISED", message: "A valid bearer token is required", retryable: false, requestId });
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/info") {
        sendJson(response, 200, { contractVersion: 1, ...ledger.info() });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/events:batch") {
        const body = await readJson(request, maxRequestBytes);
        if (body?.contractVersion !== 1 || !Array.isArray(body.events) || body.events.length < 1 || body.events.length > maxBatchEvents) {
          throw new G9pError("INVALID_BATCH", `Request must contain contractVersion 1 and between 1 and ${maxBatchEvents} events`);
        }
        const receipts = await ledger.ingestBatch(body.events);
        sendJson(response, 200, { contractVersion: 1, receipts, requestId });
        return;
      }

      sendJson(response, 404, { code: "NOT_FOUND", message: "Route not found", retryable: false, requestId });
    } catch (error) {
      const status = errorStatus(error);
      if (status === 500) logger.error("Ledger request failed", { requestId, code: error.code ?? "UNEXPECTED", message: error.message });
      sendJson(response, status, {
        code: error.code ?? "INTERNAL_ERROR",
        message: status === 500 ? "The ledger service could not complete the request" : error.message,
        retryable: retryable(error),
        requestId,
      });
    }
  });

  return {
    server,
    async listen({ host, port }) {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, resolve);
      });
      return server.address();
    },
    async close() {
      if (!server.listening) return;
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
