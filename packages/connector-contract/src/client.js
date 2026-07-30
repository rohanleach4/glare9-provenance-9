import { randomUUID } from "node:crypto";

import { ProvenanceServiceError } from "./errors.js";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function receiptObject(receipt) {
  if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new ProvenanceServiceError("Ledger service returned an invalid receipt", {
      code: "INVALID_LEDGER_RESPONSE",
      retryable: false,
    });
  }
  return receipt;
}

function requireHex(value, name) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new ProvenanceServiceError(`Ledger service returned invalid ${name}`, {
      code: "INVALID_LEDGER_RESPONSE",
      retryable: false,
    });
  }
  return value;
}

function requireReceiptString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new ProvenanceServiceError(`Ledger service returned invalid ${name}`, {
      code: "INVALID_LEDGER_RESPONSE",
      retryable: false,
    });
  }
  return value;
}

function requireInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ProvenanceServiceError(`Ledger service returned invalid ${name}`, {
      code: "INVALID_LEDGER_RESPONSE",
      retryable: false,
    });
  }
  return value;
}

function requireTimestamp(value, name) {
  requireReceiptString(value, name);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new ProvenanceServiceError(`Ledger service returned invalid ${name}`, {
      code: "INVALID_LEDGER_RESPONSE",
      retryable: false,
    });
  }
  return value;
}

function exactReceiptFields(receipt, fields) {
  const actual = Object.keys(receipt).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || !actual.every((field, index) => field === expected[index])) {
    throw new ProvenanceServiceError("Ledger service returned receipt fields that do not match contract version 2", {
      code: "INVALID_LEDGER_RESPONSE",
      retryable: false,
    });
  }
}

function validateReceipt(receipt) {
  receiptObject(receipt);

  for (const field of ["eventId", "status", "ledgerId", "shardId", "recordHash", "segmentHash", "signerKeyId"]) {
    requireReceiptString(receipt[field], `receipt.${field}`);
  }
  if (receipt.status !== "sealed") {
    throw new ProvenanceServiceError(`Ledger service returned unsupported receipt status ${receipt.status}`, {
      code: "INVALID_LEDGER_RESPONSE",
      retryable: false,
    });
  }
  for (const field of ["segmentNumber", "recordIndex"]) {
    if (!Number.isSafeInteger(receipt[field]) || receipt[field] < 0) {
      throw new ProvenanceServiceError(`Ledger service returned invalid receipt.${field}`, {
        code: "INVALID_LEDGER_RESPONSE",
        retryable: false,
      });
    }
  }
  return receipt;
}

export function validateLifecycleReceipt(receipt) {
  receiptObject(receipt);
  for (const field of ["eventId", "status", "ledgerId"]) requireReceiptString(receipt[field], `receipt.${field}`);
  requireHex(receipt.recordHash, "receipt.recordHash");

  if (receipt.status === "accepted") {
    exactReceiptFields(receipt, ["eventId", "status", "ledgerId", "recordHash", "intakeSequence", "acceptedAt"]);
    requireInteger(receipt.intakeSequence, "receipt.intakeSequence");
    requireTimestamp(receipt.acceptedAt, "receipt.acceptedAt");
    return receipt;
  }
  if (receipt.status === "provisional") {
    exactReceiptFields(receipt, [
      "eventId", "status", "ledgerId", "recordHash", "intakeSequence", "acceptedAt",
      "shardId", "routingEpochNumber", "segmentNumber", "blockIndex", "recordIndex", "openedAt",
    ]);
    requireReceiptString(receipt.shardId, "receipt.shardId");
    for (const field of ["intakeSequence", "routingEpochNumber", "segmentNumber", "blockIndex", "recordIndex"]) {
      requireInteger(receipt[field], `receipt.${field}`);
    }
    requireTimestamp(receipt.acceptedAt, "receipt.acceptedAt");
    requireTimestamp(receipt.openedAt, "receipt.openedAt");
    return receipt;
  }
  if (receipt.status === "sealed") {
    exactReceiptFields(receipt, [
      "eventId", "status", "ledgerId", "recordHash", "shardId", "routingEpochNumber",
      "segmentNumber", "recordIndex", "segmentHash", "signerKeyId",
    ]);
    requireReceiptString(receipt.shardId, "receipt.shardId");
    for (const field of ["routingEpochNumber", "segmentNumber", "recordIndex"]) {
      requireInteger(receipt[field], `receipt.${field}`);
    }
    requireHex(receipt.segmentHash, "receipt.segmentHash");
    requireHex(receipt.signerKeyId, "receipt.signerKeyId");
    return receipt;
  }
  throw new ProvenanceServiceError(`Ledger service returned unsupported receipt status ${receipt.status}`, {
    code: "INVALID_LEDGER_RESPONSE",
    retryable: false,
  });
}

async function parseResponse(response) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new ProvenanceServiceError("Ledger service response is too large", {
      status: response.status,
      code: "LEDGER_RESPONSE_LIMIT",
      retryable: true,
    });
  }

  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
    throw new ProvenanceServiceError("Ledger service response is too large", {
      status: response.status,
      code: "LEDGER_RESPONSE_LIMIT",
      retryable: true,
    });
  }

  try {
    return text.length === 0 ? {} : JSON.parse(text);
  } catch (error) {
    throw new ProvenanceServiceError("Ledger service returned invalid JSON", {
      status: response.status,
      code: "INVALID_LEDGER_RESPONSE",
      retryable: response.status >= 500,
      cause: error,
    });
  }
}

export class ProvenanceClient {
  constructor({ baseUrl, token, tokens = token === undefined ? undefined : [token], timeoutMs = 15_000, fetchImplementation = globalThis.fetch }) {
    this.baseUrl = new URL(requireString(baseUrl, "baseUrl"));
    if (!new Set(["http:", "https:"]).has(this.baseUrl.protocol)) {
      throw new TypeError("baseUrl must use HTTP or HTTPS");
    }
    if (!Array.isArray(tokens) || tokens.length < 1 || tokens.length > 4) throw new TypeError("tokens must contain one to four credentials");
    this.tokens = tokens.map((entry, index) => requireString(entry, `tokens[${index}]`));
    if (new Set(this.tokens).size !== this.tokens.length) throw new TypeError("tokens must be distinct");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100) {
      throw new TypeError("timeoutMs must be an integer of at least 100 milliseconds");
    }
    if (typeof fetchImplementation !== "function") {
      throw new TypeError("fetchImplementation must be a function");
    }
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImplementation;
  }

  async request(path, { method = "GET", body } = {}) {
    const requestId = randomUUID();
    let response;
    let payload;
    for (let index = 0; index < this.tokens.length; index += 1) {
      try {
        response = await this.fetch(new URL(path, this.baseUrl), {
          method,
          headers: {
            accept: "application/json",
            authorization: `Bearer ${this.tokens[index]}`,
            "content-type": "application/json",
            "x-request-id": requestId,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        throw new ProvenanceServiceError("Could not reach the ledger service", {
          code: error?.name === "TimeoutError" ? "LEDGER_TIMEOUT" : "LEDGER_UNAVAILABLE",
          retryable: true,
          requestId,
          cause: error,
        });
      }
      payload = await parseResponse(response);
      if (response.status !== 401 || index === this.tokens.length - 1) break;
    }
    if (!response.ok) {
      throw new ProvenanceServiceError(payload.message ?? `Ledger service returned HTTP ${response.status}`, {
        status: response.status,
        code: payload.code ?? "LEDGER_REQUEST_FAILED",
        retryable: payload.retryable ?? (response.status >= 500 || response.status === 429),
        requestId: payload.requestId ?? requestId,
      });
    }
    return payload;
  }

  async health() {
    return this.request("/health");
  }

  async submitBatch(events) {
    if (!Array.isArray(events) || events.length === 0) {
      throw new TypeError("submitBatch requires at least one event");
    }
    const payload = await this.request("/v1/events:batch", {
      method: "POST",
      body: { contractVersion: 1, events },
    });

    if (payload.contractVersion !== 1 || !Array.isArray(payload.receipts) || payload.receipts.length !== events.length) {
      throw new ProvenanceServiceError("Ledger service returned an invalid batch response", {
        code: "INVALID_LEDGER_RESPONSE",
        retryable: false,
      });
    }
    const receipts = payload.receipts.map(validateReceipt);
    receipts.forEach((receipt, index) => {
      if (receipt.eventId !== events[index]?.eventId) {
        throw new ProvenanceServiceError("Ledger service returned receipts in the wrong order or for the wrong events", {
          code: "INVALID_LEDGER_RESPONSE",
          retryable: false,
        });
      }
    });
    return receipts;
  }

  async submitAcceptedBatch(events) {
    if (!Array.isArray(events) || events.length === 0) {
      throw new TypeError("submitAcceptedBatch requires at least one event");
    }
    const payload = await this.request("/v2/events:batch", {
      method: "POST",
      body: { contractVersion: 2, events },
    });
    if (payload.contractVersion !== 2 || !Array.isArray(payload.receipts) || payload.receipts.length !== events.length) {
      throw new ProvenanceServiceError("Ledger service returned an invalid accepted-first batch response", {
        code: "INVALID_LEDGER_RESPONSE",
        retryable: false,
      });
    }
    const receipts = payload.receipts.map(validateLifecycleReceipt);
    receipts.forEach((receipt, index) => {
      if (receipt.eventId !== events[index]?.eventId) {
        throw new ProvenanceServiceError("Ledger service returned receipts in the wrong order or for the wrong events", {
          code: "INVALID_LEDGER_RESPONSE",
          retryable: false,
        });
      }
    });
    return receipts;
  }

  async getReceipt(eventId, recordHash) {
    requireString(eventId, "eventId");
    if (typeof recordHash !== "string" || !/^[0-9a-f]{64}$/u.test(recordHash)) {
      throw new TypeError("recordHash must contain 64 lowercase hexadecimal characters");
    }
    const path = `/v2/receipts/${encodeURIComponent(eventId)}?recordHash=${encodeURIComponent(recordHash)}`;
    const payload = await this.request(path);
    if (payload.contractVersion !== 2) {
      throw new ProvenanceServiceError("Ledger service returned an invalid receipt lookup response", {
        code: "INVALID_LEDGER_RESPONSE",
        retryable: false,
      });
    }
    const receipt = validateLifecycleReceipt(payload.receipt);
    if (receipt.eventId !== eventId || receipt.recordHash !== recordHash) {
      throw new ProvenanceServiceError("Ledger service returned a receipt for different event content", {
        code: "INVALID_LEDGER_RESPONSE",
        retryable: false,
      });
    }
    return receipt;
  }
}
