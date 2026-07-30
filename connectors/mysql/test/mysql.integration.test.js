import assert from "node:assert/strict";
import test from "node:test";

import mysql from "mysql2/promise";

import { MySqlOutboxRepository } from "../src/outbox-repository.js";

const mysqlUrl = process.env.MYSQL_INTEGRATION_URL;
const integration = mysqlUrl === undefined ? test.skip : test;

function sampleEvent(eventId) {
  return {
    version: 1,
    eventId,
    ledgerId: "mysql-integration-ledger",
    subject: "model:mysql-test",
    type: "ai.model.registered",
    schemaVersion: 1,
    occurredAt: "2026-07-28T12:00:00.000Z",
    recordedAt: "2026-07-28T12:00:00.000Z",
    source: { kind: "outbox", identity: "integration-test" },
    payload: { name: "MySQL integration test" },
  };
}

integration("repository leases, delivers, retries and dead-letters real MySQL rows", async () => {
  const pool = mysql.createPool(mysqlUrl);
  const tableName = `provenance_outbox_test_${process.pid}`;
  const table = `\`${tableName}\``;
  try {
    await pool.query(`
      CREATE TABLE ${table} (
        sequence_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        event_id VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
        envelope JSON NOT NULL,
        available_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        lease_owner VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
        lease_token CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
        lease_expires_at DATETIME(6) NULL,
        attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
        delivered_at DATETIME(6) NULL,
        dead_lettered_at DATETIME(6) NULL,
        receipt JSON NULL,
        last_error_code VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
        last_error_message VARCHAR(1024) NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (sequence_id),
        UNIQUE KEY uq_event_id (event_id),
        KEY ix_available (delivered_at, dead_lettered_at, available_at, lease_expires_at, sequence_id)
      ) ENGINE=InnoDB
    `);

    const repository = new MySqlOutboxRepository({
      pool,
      table: tableName,
      leaseSeconds: 30,
      maxAttempts: 1,
    });

    const deliveredEvent = sampleEvent("mysql-event-delivered");
    await pool.execute(`INSERT INTO ${table} (event_id, envelope) VALUES (?, ?)`, [
      deliveredEvent.eventId,
      JSON.stringify(deliveredEvent),
    ]);
    const deliveredClaim = await repository.claimBatch({ batchSize: 10, leaseOwner: "integration-worker" });
    assert.equal(deliveredClaim.length, 1);
    assert.deepEqual(deliveredClaim[0].envelope, deliveredEvent);

    const receipt = {
      eventId: deliveredEvent.eventId,
      status: "accepted",
      ledgerId: deliveredEvent.ledgerId,
      recordHash: "a".repeat(64),
      intakeSequence: 0,
      acceptedAt: "2026-07-30T12:00:00.000Z",
    };
    await repository.markDelivered(deliveredClaim, [receipt]);
    const [[deliveredRow]] = await pool.query(`SELECT delivered_at, receipt FROM ${table} WHERE event_id = ?`, [deliveredEvent.eventId]);
    assert.ok(deliveredRow.delivered_at instanceof Date);
    assert.equal(deliveredRow.receipt.status, "accepted");
    assert.equal(deliveredRow.receipt.recordHash, receipt.recordHash);

    const failedEvent = sampleEvent("mysql-event-failed");
    await pool.execute(`INSERT INTO ${table} (event_id, envelope) VALUES (?, ?)`, [
      failedEvent.eventId,
      JSON.stringify(failedEvent),
    ]);
    const failedClaim = await repository.claimBatch({ batchSize: 10, leaseOwner: "integration-worker" });
    const failure = Object.assign(new Error("Permanent ledger rejection"), {
      code: "EVENT_ID_CONFLICT",
      retryable: false,
    });
    await repository.markFailed(failedClaim, failure, { retryDelayMs: 1_000 });
    const [[failedRow]] = await pool.query(`SELECT dead_lettered_at, last_error_code FROM ${table} WHERE event_id = ?`, [failedEvent.eventId]);
    assert.ok(failedRow.dead_lettered_at instanceof Date);
    assert.equal(failedRow.last_error_code, "EVENT_ID_CONFLICT");
  } finally {
    await pool.query(`DROP TABLE IF EXISTS ${table}`);
    await pool.end();
  }
});
