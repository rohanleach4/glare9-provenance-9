import { createServer } from "node:http";

function send(response, status, payload) {
  const bytes = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": bytes.length,
    "cache-control": "no-store",
  });
  response.end(bytes);
}

export function createHealthServer({ worker, repository }) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://connector.local");
    if (request.method === "GET" && url.pathname === "/health") {
      send(response, 200, { status: "ok", connector: worker.snapshot() });
      return;
    }
    if (request.method === "GET" && url.pathname === "/ready") {
      try {
        await repository.ping();
        send(response, 200, { status: "ready", connector: worker.snapshot() });
      } catch {
        send(response, 503, { status: "not-ready", connector: worker.snapshot() });
      }
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
