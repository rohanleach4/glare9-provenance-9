import assert from "node:assert/strict";

import { reconcileLifecycleReceipt } from "@glare9/provenance-connector-contract";
import { registerConnectorContractTests } from "@glare9/provenance-connector-contract/test-kit";

import { MySqlConnectorWorker } from "../src/worker.js";

const acceptedAt = "2026-07-30T12:00:00.000Z";

class MemoryOutboxRepository {
  constructor() {
    this.rows = [];
    this.nextSequence = 1;
    this.nextLease = 1;
    this.storageAvailable = true;
    this.failDeliveryCommit = false;
  }

  async enqueue(events) {
    for (const envelope of events) {
      this.rows.push({
        sequenceId: String(this.nextSequence++),
        eventId: envelope.eventId,
        envelope: structuredClone(envelope),
        attemptCount: 0,
        leaseToken: null,
        leaseExpired: false,
        delivered: false,
        quarantined: false,
        receipt: null,
        lastErrorCode: null,
      });
    }
  }

  async claimBatch({ batchSize }) {
    if (!this.storageAvailable) throw this.#unavailable();
    const rows = this.rows
      .filter((row) => !row.delivered && !row.quarantined && (row.leaseToken === null || row.leaseExpired))
      .sort((left, right) => Number(left.sequenceId) - Number(right.sequenceId))
      .slice(0, batchSize);
    const leaseToken = `lease-${this.nextLease++}`;
    return rows.map((row) => {
      row.leaseToken = leaseToken;
      row.leaseExpired = false;
      row.attemptCount += 1;
      return {
        sequenceId: row.sequenceId,
        eventId: row.eventId,
        envelope: structuredClone(row.envelope),
        attemptCount: row.attemptCount,
        leaseToken,
      };
    });
  }

  async markDelivered(claimed, receipts) {
    if (this.failDeliveryCommit) {
      this.failDeliveryCommit = false;
      this.storageAvailable = false;
      throw this.#unavailable();
    }
    if (!this.storageAvailable) throw this.#unavailable();
    for (const item of claimed) {
      const row = this.#leased(item);
      const receipt = receipts.find((candidate) => candidate.eventId === item.eventId);
      assert.ok(receipt);
      row.receipt = structuredClone(receipt);
      row.delivered = true;
      row.leaseToken = null;
    }
  }

  async markFailed(claimed, error) {
    if (!this.storageAvailable) throw this.#unavailable();
    for (const item of claimed) {
      const row = this.#leased(item);
      row.lastErrorCode = error.code ?? "DELIVERY_FAILED";
      row.quarantined = error.retryable === false;
      row.leaseToken = null;
    }
  }

  expireLeases() {
    for (const row of this.rows) {
      if (row.leaseToken !== null) row.leaseExpired = true;
    }
  }

  #leased(item) {
    const row = this.rows.find((candidate) => candidate.sequenceId === item.sequenceId);
    assert.equal(row?.leaseToken, item.leaseToken);
    return row;
  }

  #unavailable() {
    return Object.assign(new Error("Injected database failover"), {
      code: "DATABASE_UNAVAILABLE",
      retryable: true,
    });
  }
}

class MySqlContractHarness {
  constructor() {
    this.repository = new MemoryOutboxRepository();
    this.submitted = [];
    this.ledgerFailure = null;
    this.receipts = new Map();
    this.restart();
  }

  restart() {
    this.worker = new MySqlConnectorWorker({
      repository: this.repository,
      provenanceClient: {
        submitAcceptedBatch: async (events) => {
          this.submitted.push(...structuredClone(events));
          if (this.ledgerFailure !== null) {
            const failure = this.ledgerFailure;
            this.ledgerFailure = null;
            throw failure;
          }
          return events.map((item) => {
            let receipt = this.receipts.get(item.eventId);
            if (receipt === undefined) {
              receipt = {
                eventId: item.eventId,
                status: "accepted",
                ledgerId: item.ledgerId,
                recordHash: Buffer.from(item.eventId).toString("hex").padEnd(64, "0").slice(0, 64),
                intakeSequence: this.receipts.size,
                acceptedAt,
              };
              this.receipts.set(item.eventId, receipt);
            }
            return structuredClone(receipt);
          });
        },
      },
      connectorId: "mysql-contract-worker",
      batchSize: 100,
      retryBaseMs: 100,
      logger: { error() {} },
    });
  }

  enqueue(events) {
    return this.repository.enqueue(events);
  }

  deliverOnce() {
    return this.worker.runOnce();
  }

  submittedEventIds() {
    return this.submitted.map((item) => item.eventId);
  }

  state(eventId) {
    const row = this.repository.rows.find((candidate) => candidate.eventId === eventId);
    return {
      status: row.delivered ? "delivered" : row.quarantined ? "quarantined" : row.leaseToken === null ? "ready" : "leased",
      receipt: row.receipt,
      lastErrorCode: row.lastErrorCode,
    };
  }

  injectDeliveryCommitFailure() {
    this.repository.failDeliveryCommit = true;
  }

  restoreStorage() {
    this.repository.storageAvailable = true;
  }

  expireLeases() {
    this.repository.expireLeases();
  }

  injectLedgerFailure(error) {
    this.ledgerFailure = error;
  }

  reconcile(eventId, currentReceipt) {
    return reconcileLifecycleReceipt(this.state(eventId).receipt, currentReceipt);
  }
}

registerConnectorContractTests({
  connectorName: "MySQL outbox",
  createHarness: async () => new MySqlContractHarness(),
});
