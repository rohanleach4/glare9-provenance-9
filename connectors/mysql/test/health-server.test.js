import assert from "node:assert/strict";
import test from "node:test";

import { createHealthServer } from "../src/health-server.js";

test("connector health surface is minimal and metrics require authentication", async () => {
  const worker = {
    snapshot: () => ({
      state: "running",
      inFlight: 2,
      deliveredEvents: 10,
      failedBatches: 1,
      lastSuccessAt: "2026-07-30T12:00:00.000Z",
      lastErrorAt: null,
    }),
  };
  const repository = {
    ping: async () => {},
    operationalMetrics: async () => ({ readyCount: 3, leasedCount: 2, deliveredCount: 10, deadLetteredCount: 1, oldestReadyAgeSeconds: 4.5 }),
  };
  const service = createHealthServer({ worker, repository, metricsToken: "metrics-token-123456" });
  const address = await service.listen({ host: "127.0.0.1", port: 0 });
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    assert.deepEqual(await (await fetch(`${baseUrl}/health`)).json(), { status: "ok" });
    assert.deepEqual(await (await fetch(`${baseUrl}/ready`)).json(), { status: "ready" });
    assert.equal((await fetch(`${baseUrl}/metrics`)).status, 401);
    const metrics = await fetch(`${baseUrl}/metrics`, { headers: { authorization: "Bearer metrics-token-123456" } });
    assert.equal(metrics.status, 200);
    const body = await metrics.text();
    assert.match(body, /g9p_mysql_connector_ready 1/u);
    assert.match(body, /g9p_mysql_connector_delivered_events_total 10/u);
    assert.match(body, /g9p_mysql_outbox_ready_events 3/u);
    assert.match(body, /g9p_mysql_outbox_oldest_ready_age_seconds 4.5/u);
  } finally {
    await service.close();
  }
});

test("connector readiness and metrics report database dependency failure without details", async () => {
  const worker = {
    snapshot: () => ({ state: "running", inFlight: 0, deliveredEvents: 0, failedBatches: 0, lastSuccessAt: null, lastErrorAt: null }),
  };
  const repository = { ping: async () => { throw new Error("private database address"); } };
  const service = createHealthServer({ worker, repository, metricsToken: "metrics-token-123456" });
  const address = await service.listen({ host: "127.0.0.1", port: 0 });
  try {
    const ready = await fetch(`http://127.0.0.1:${address.port}/ready`);
    assert.equal(ready.status, 503);
    assert.deepEqual(await ready.json(), { status: "not-ready" });
    const metrics = await fetch(`http://127.0.0.1:${address.port}/metrics`, { headers: { authorization: "Bearer metrics-token-123456" } });
    assert.match(await metrics.text(), /g9p_mysql_connector_ready 0/u);
  } finally {
    await service.close();
  }
});
