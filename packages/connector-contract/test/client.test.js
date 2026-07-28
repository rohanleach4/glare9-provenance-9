import assert from "node:assert/strict";
import test from "node:test";

import { ProvenanceClient, ProvenanceServiceError } from "../src/index.js";

function response(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("client submits the versioned batch contract and validates receipts", async () => {
  let captured;
  const client = new ProvenanceClient({
    baseUrl: "https://ledger.example/",
    token: "test-token",
    fetchImplementation: async (url, options) => {
      captured = { url: url.toString(), options };
      const event = JSON.parse(options.body).events[0];
      return response(200, {
        contractVersion: 1,
        receipts: [{
          eventId: event.eventId,
          status: "sealed",
          ledgerId: event.ledgerId,
          shardId: "shard-0000",
          segmentNumber: 0,
          recordIndex: 0,
          recordHash: "a".repeat(64),
          segmentHash: "b".repeat(64),
          signerKeyId: "c".repeat(64),
        }],
      });
    },
  });

  const receipts = await client.submitBatch([{ eventId: "event-1", ledgerId: "ledger-1" }]);
  assert.equal(receipts[0].status, "sealed");
  assert.equal(captured.url, "https://ledger.example/v1/events:batch");
  assert.equal(captured.options.headers.authorization, "Bearer test-token");
  assert.equal(JSON.parse(captured.options.body).contractVersion, 1);
});

test("client preserves structured service errors", async () => {
  const client = new ProvenanceClient({
    baseUrl: "https://ledger.example/",
    token: "test-token",
    fetchImplementation: async () => response(409, {
      code: "EVENT_ID_CONFLICT",
      message: "Conflicting event ID",
      retryable: false,
      requestId: "request-1",
    }),
  });

  await assert.rejects(
    client.submitBatch([{ eventId: "event-1" }]),
    (error) => error instanceof ProvenanceServiceError
      && error.code === "EVENT_ID_CONFLICT"
      && error.retryable === false,
  );
});

test("client rejects a receipt for the wrong event", async () => {
  const client = new ProvenanceClient({
    baseUrl: "https://ledger.example/",
    token: "test-token",
    fetchImplementation: async () => response(200, {
      contractVersion: 1,
      receipts: [{
        eventId: "different-event",
        status: "sealed",
        ledgerId: "ledger-1",
        shardId: "shard-0000",
        segmentNumber: 0,
        recordIndex: 0,
        recordHash: "a".repeat(64),
        segmentHash: "b".repeat(64),
        signerKeyId: "c".repeat(64),
      }],
    }),
  });

  await assert.rejects(
    client.submitBatch([{ eventId: "event-1" }]),
    (error) => error.code === "INVALID_LEDGER_RESPONSE" && error.retryable === false,
  );
});
