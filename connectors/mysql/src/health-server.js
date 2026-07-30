import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

import { connectorMetrics } from "./metrics.js";

function tokenMatches(header, expectedToken) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7), "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function send(response, status, payload) {
  const bytes = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": bytes.length,
    "cache-control": "no-store",
  });
  response.end(bytes);
}

function sendText(response, status, text) {
  const bytes = Buffer.from(text);
  response.writeHead(status, {
    "content-type": "text/plain; version=0.0.4; charset=utf-8",
    "content-length": bytes.length,
    "cache-control": "no-store",
  });
  response.end(bytes);
}

export function createHealthServer({ worker, repository, metricsToken }) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://connector.local");
    if (request.method === "GET" && url.pathname === "/health") {
      send(response, 200, { status: "ok" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/ready") {
      try {
        await repository.ping();
        send(response, 200, { status: "ready" });
      } catch {
        send(response, 503, { status: "not-ready" });
      }
      return;
    }
    if (request.method === "GET" && url.pathname === "/metrics") {
      if (metricsToken === undefined) {
        send(response, 404, { code: "NOT_FOUND" });
        return;
      }
      if (!tokenMatches(request.headers.authorization, metricsToken)) {
        send(response, 401, { code: "UNAUTHORISED" });
        return;
      }
      let ready = true;
      let outbox;
      try {
        await repository.ping();
        outbox = await repository.operationalMetrics();
      } catch {
        ready = false;
      }
      sendText(response, 200, connectorMetrics(worker.snapshot(), ready, outbox));
      return;
    }
    send(response, 404, { code: "NOT_FOUND" });
  });

  return {
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
