export class ProvenanceServiceError extends Error {
  constructor(message, {
    status = 0,
    code = "PROVENANCE_SERVICE_ERROR",
    retryable = true,
    requestId,
    cause,
  } = {}) {
    super(message, cause === undefined ? {} : { cause });
    this.name = "ProvenanceServiceError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.requestId = requestId;
  }
}
