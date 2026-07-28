import { randomUUID } from "node:crypto";

import { ProvenanceServiceError } from "./errors.js";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function validateReceipt(receipt) {
  if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new ProvenanceServiceError("Ledger service returned an invalid receipt", {
      code: "INVALID_LEDGER_RESPONSE",
      retryable: false,
    });
  }

  for (const field of ["eventId", "status", "ledgerId", "shardId", "recordHash", "segmentHash", "signerKeyId"]) {
    requireString(receipt[field], `receipt.${field}`);
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
  constructor({ baseUrl, token, timeoutMs = 15_000, fetchImplementation = globalThis.fetch }) {
    this.baseUrl = new URL(requireString(baseUrl, "baseUrl"));
    if (!new Set(["http:", "https:"]).has(this.baseUrl.protocol)) {
      throw new TypeError("baseUrl must use HTTP or HTTPS");
    }
    this.token = requireString(token, "token");
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
    try {
      response = await this.fetch(new URL(path, this.baseUrl), {
        method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.token}`,
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

    const payload = await parseResponse(response);
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
}
