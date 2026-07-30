import { timingSafeEqual, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createServer as createSecureServer } from "node:https";

import { G9pError } from "@glare9/provenance";

import { ledgerMetrics } from "./metrics.js";

function tokenMatches(header, expectedTokens) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7), "utf8");
  return expectedTokens.some((token) => {
    const expected = Buffer.from(token, "utf8");
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  });
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

function sendText(response, status, contentType, text) {
  const bytes = Buffer.from(text, "utf8");
  response.writeHead(status, {
    "content-type": contentType,
    "content-length": bytes.length,
    "cache-control": "no-store",
  });
  response.end(bytes);
}

function hasExactFields(value, fields) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  return actual.length === expected.length && actual.every((field, index) => field === expected[index]);
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
  if (error.code === "RECEIPT_NOT_FOUND") return 404;
  if (error.code === "LEDGER_BACKPRESSURE") return 429;
  if (new Set(["INTAKE_WRITE", "ACTIVE_STATE_WRITE", "SEGMENT_WRITE", "COMPRESS_FAILED"]).has(error.code)) return 503;
  if (error instanceof G9pError) return 400;
  return 500;
}

function retryable(error) {
  if (!(error instanceof G9pError)) return true;
  return new Set(["INTAKE_WRITE", "ACTIVE_STATE_WRITE", "SEGMENT_WRITE", "COMPRESS_FAILED", "LEDGER_BACKPRESSURE"]).has(error.code);
}

export function createLedgerServer({ ledger, apiToken, apiTokens = [apiToken], adminToken, adminTokens = adminToken === undefined ? [] : [adminToken], tls, maxBatchEvents = 500, maxRequestBytes = 8 * 1024 * 1024, logger = console, testFaultInjector }) {
  const handler = async (request, response) => {
    const requestId = request.headers["x-request-id"] ?? randomUUID();
    try {
      const url = new URL(request.url, "http://ledger.local");
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { status: "ok" });
        return;
      }

      if (request.method === "GET" && url.pathname === "/ready") {
        const ready = ledger.info().backgroundError === null;
        sendJson(response, ready ? 200 : 503, { status: ready ? "ready" : "not-ready" });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/admin/routing-transitions") {
        if (adminTokens.length === 0) {
          sendJson(response, 404, { code: "NOT_FOUND", message: "Route not found", retryable: false, requestId });
          return;
        }
        if (!tokenMatches(request.headers.authorization, adminTokens)) {
          sendJson(response, 401, { code: "UNAUTHORISED", message: "A valid administration token is required", retryable: false, requestId });
          return;
        }
        const body = await readJson(request, maxRequestBytes);
        if (body?.contractVersion !== 1) {
          throw new G9pError("INVALID_TRANSITION", "Request must contain contractVersion 1");
        }
        const transition = await ledger.transitionRouting({
          ledgerId: body.ledgerId,
          shardCount: body.shardCount,
          reason: body.reason,
          expectedCurrentEpoch: body.expectedCurrentEpoch,
        });
        sendJson(response, 200, { contractVersion: 1, transition, requestId });
        return;
      }

      if (!tokenMatches(request.headers.authorization, apiTokens)) {
        sendJson(response, 401, { code: "UNAUTHORISED", message: "A valid bearer token is required", retryable: false, requestId });
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/info") {
        sendJson(response, 200, { contractVersion: 1, ...ledger.info() });
        return;
      }

      if (request.method === "GET" && url.pathname === "/metrics") {
        sendText(response, 200, "text/plain; version=0.0.4; charset=utf-8", ledgerMetrics(ledger.info()));
        return;
      }

      if (request.method === "GET" && url.pathname.startsWith("/v2/receipts/")) {
        let eventId;
        try {
          eventId = decodeURIComponent(url.pathname.slice("/v2/receipts/".length));
        } catch (error) {
          throw new G9pError("RECEIPT_EVENT_ID", "Receipt lookup contains an invalid encoded event ID", { cause: error });
        }
        if (url.searchParams.size !== 1 || !url.searchParams.has("recordHash")) {
          throw new G9pError("RECEIPT_RECORD_HASH", "Receipt lookup requires exactly one recordHash query parameter");
        }
        const receipt = await ledger.receipt(eventId, url.searchParams.get("recordHash"));
        sendJson(response, 200, { contractVersion: 2, receipt, requestId });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/events:batch") {
        const body = await readJson(request, maxRequestBytes);
        if (body?.contractVersion !== 1 || !Array.isArray(body.events) || body.events.length < 1 || body.events.length > maxBatchEvents) {
          throw new G9pError("INVALID_BATCH", `Request must contain contractVersion 1 and between 1 and ${maxBatchEvents} events`);
        }
        const receipts = await ledger.ingestBatch(body.events);
        testFaultInjector?.("service.before-acknowledgement", { requestId, receipts });
        sendJson(response, 200, { contractVersion: 1, receipts, requestId });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v2/events:batch") {
        const body = await readJson(request, maxRequestBytes);
        if (!hasExactFields(body, ["contractVersion", "events"])
          || body.contractVersion !== 2 || !Array.isArray(body.events) || body.events.length < 1 || body.events.length > maxBatchEvents) {
          throw new G9pError("INVALID_BATCH", `Request must contain contractVersion 2 and between 1 and ${maxBatchEvents} events`);
        }
        const receipts = await ledger.ingestAcceptedBatch(body.events);
        testFaultInjector?.("service.before-acknowledgement", { requestId, receipts });
        sendJson(response, 202, { contractVersion: 2, receipts, requestId });
        return;
      }

      sendJson(response, 404, { code: "NOT_FOUND", message: "Route not found", retryable: false, requestId });
    } catch (error) {
      const status = errorStatus(error);
      if (status === 500) logger.error("Ledger request failed", { requestId, code: error.code ?? "UNEXPECTED" });
      sendJson(response, status, {
        code: error.code ?? "INTERNAL_ERROR",
        message: status === 500 ? "The ledger service could not complete the request" : error.message,
        retryable: retryable(error),
        requestId,
      });
    }
  };
  const server = tls === undefined ? createServer(handler) : createSecureServer(tls, handler);

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
