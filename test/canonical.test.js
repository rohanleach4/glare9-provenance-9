import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeCanonical,
  encodeCanonical,
  eventHashHex,
  validateEvent,
} from "../src/index.js";

function event(overrides = {}) {
  return {
    version: 1,
    eventId: "event-001",
    ledgerId: "test-ledger",
    subject: "model:test",
    type: "ai.model.registered",
    schemaVersion: 1,
    occurredAt: "2026-07-28T12:00:00.000Z",
    recordedAt: "2026-07-28T12:00:01.000Z",
    source: { kind: "semantic", identity: "test:operator" },
    payload: { name: "Test model", active: true },
    ...overrides,
  };
}

test("canonical maps produce identical bytes regardless of insertion order", () => {
  const left = { alpha: 1, nested: { zulu: true, beta: "value" } };
  const right = { nested: { beta: "value", zulu: true }, alpha: 1 };
  assert.deepEqual(encodeCanonical(left), encodeCanonical(right));
});

test("canonical values round trip bytes, arrays, floats, integers, and maps", () => {
  const input = {
    bytes: Uint8Array.from([0, 1, 2, 255]),
    array: [null, false, true, -12, 1.25, "text"],
    map: { value: 42 },
  };
  const encoded = encodeCanonical(input);
  const decoded = decodeCanonical(encoded);

  assert.deepEqual([...decoded.bytes], [0, 1, 2, 255]);
  assert.deepEqual(decoded.array, input.array);
  assert.equal(decoded.map.value, 42);
  assert.deepEqual(encodeCanonical(decoded), encoded);
});

test("decoder rejects non-minimal integer encodings", () => {
  assert.throws(
    () => decodeCanonical(Buffer.from([0x10, 0x80, 0x00])),
    (error) => error.code === "DECODE_NON_CANONICAL",
  );
});

test("event validation rejects unknown envelope fields", () => {
  assert.throws(
    () => validateEvent(event({ undocumented: true })),
    (error) => error.code === "EVENT_UNKNOWN_FIELD",
  );
});

test("event hashes are deterministic and change with content", () => {
  const first = eventHashHex(event());
  assert.equal(first, eventHashHex(event()));
  assert.notEqual(first, eventHashHex(event({ payload: { name: "Changed", active: true } })));
});
