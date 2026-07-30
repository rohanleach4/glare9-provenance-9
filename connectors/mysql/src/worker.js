function delay(milliseconds, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export class MySqlConnectorWorker {
  constructor({
    repository,
    provenanceClient,
    connectorId,
    batchSize = 100,
    pollIntervalMs = 1_000,
    retryBaseMs = 1_000,
    retryMaxMs = 60_000,
    logger = console,
  }) {
    this.repository = repository;
    this.provenanceClient = provenanceClient;
    this.connectorId = connectorId;
    this.batchSize = batchSize;
    this.pollIntervalMs = pollIntervalMs;
    this.retryBaseMs = retryBaseMs;
    this.retryMaxMs = retryMaxMs;
    this.logger = logger;
    this.status = {
      state: "starting",
      inFlight: 0,
      deliveredEvents: 0,
      failedBatches: 0,
      lastSuccessAt: null,
      lastErrorAt: null,
      lastErrorCode: null,
    };
  }

  retryDelay(attemptCount) {
    const exponent = Math.max(0, Math.min(20, attemptCount - 1));
    return Math.min(this.retryMaxMs, this.retryBaseMs * (2 ** exponent));
  }

  async runOnce() {
    const claimed = await this.repository.claimBatch({
      batchSize: this.batchSize,
      leaseOwner: this.connectorId,
    });
    if (claimed.length === 0) return 0;

    this.status.inFlight = claimed.length;
    try {
      for (const item of claimed) {
        if (item.envelope === null || typeof item.envelope !== "object" || Array.isArray(item.envelope)) {
          throw Object.assign(new Error(`Outbox row ${item.sequenceId} does not contain an event object`), {
            code: "INVALID_OUTBOX_ENVELOPE",
            retryable: false,
          });
        }
        if (item.envelope.eventId !== item.eventId) {
          throw Object.assign(new Error(`Outbox row ${item.sequenceId} event ID does not match its envelope`), {
            code: "OUTBOX_EVENT_ID_MISMATCH",
            retryable: false,
          });
        }
      }
      const receipts = await this.provenanceClient.submitAcceptedBatch(claimed.map((item) => item.envelope));
      await this.repository.markDelivered(claimed, receipts);
      this.status.deliveredEvents += claimed.length;
      this.status.lastSuccessAt = new Date().toISOString();
      this.status.lastErrorCode = null;
      return claimed.length;
    } catch (error) {
      const highestAttempt = Math.max(...claimed.map((item) => item.attemptCount));
      await this.repository.markFailed(claimed, error, {
        retryDelayMs: this.retryDelay(highestAttempt),
      });
      this.status.failedBatches += 1;
      this.status.lastErrorAt = new Date().toISOString();
      this.status.lastErrorCode = error.code ?? "DELIVERY_FAILED";
      this.logger.error("MySQL outbox delivery failed", {
        code: this.status.lastErrorCode,
        count: claimed.length,
        retryable: error.retryable !== false,
      });
      return 0;
    } finally {
      this.status.inFlight = 0;
    }
  }

  async run(signal) {
    this.status.state = "running";
    while (!signal.aborted) {
      try {
        const delivered = await this.runOnce();
        if (delivered === 0) await delay(this.pollIntervalMs, signal);
      } catch (error) {
        this.status.failedBatches += 1;
        this.status.lastErrorAt = new Date().toISOString();
        this.status.lastErrorCode = error.code ?? "CONNECTOR_LOOP_FAILED";
        this.logger.error("MySQL connector loop failed", {
          code: this.status.lastErrorCode,
          message: error.message,
        });
        await delay(this.pollIntervalMs, signal);
      }
    }
    this.status.state = "stopped";
  }

  snapshot() {
    return { ...this.status };
  }
}
