import { randomUUID } from "node:crypto";

import { quoteTablePath } from "./table.js";

function parseEnvelope(value, eventId) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export class MySqlOutboxRepository {
  constructor({ pool, table, leaseSeconds = 30, maxAttempts = 20 }) {
    if (pool === undefined || typeof pool.getConnection !== "function") {
      throw new TypeError("A mysql2 promise pool is required");
    }
    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > 3_600) {
      throw new TypeError("leaseSeconds must be an integer between 5 and 3,600");
    }
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10_000) {
      throw new TypeError("maxAttempts must be an integer between 1 and 10,000");
    }
    this.pool = pool;
    this.table = quoteTablePath(table);
    this.leaseSeconds = leaseSeconds;
    this.maxAttempts = maxAttempts;
  }

  async claimBatch({ batchSize, leaseOwner }) {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1_000) {
      throw new TypeError("batchSize must be an integer between 1 and 1,000");
    }
    if (typeof leaseOwner !== "string" || leaseOwner.length < 1 || leaseOwner.length > 128 || !/^[\x20-\x7e]+$/u.test(leaseOwner)) {
      throw new TypeError("leaseOwner must contain between 1 and 128 printable ASCII characters");
    }
    const connection = await this.pool.getConnection();
    const leaseToken = randomUUID();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query(`
        SELECT sequence_id, event_id, envelope, attempt_count
        FROM ${this.table}
        WHERE delivered_at IS NULL
          AND dead_lettered_at IS NULL
          AND available_at <= UTC_TIMESTAMP(6)
          AND (lease_expires_at IS NULL OR lease_expires_at <= UTC_TIMESTAMP(6))
        ORDER BY sequence_id
        LIMIT ${Number(batchSize)}
        FOR UPDATE SKIP LOCKED
      `);

      if (rows.length === 0) {
        await connection.commit();
        return [];
      }

      const placeholders = rows.map(() => "?").join(", ");
      const sequenceIds = rows.map((row) => row.sequence_id);
      const [update] = await connection.execute(`
        UPDATE ${this.table}
        SET lease_owner = ?,
            lease_token = ?,
            lease_expires_at = DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ${Number(this.leaseSeconds)} SECOND),
            attempt_count = attempt_count + 1,
            last_error_code = NULL,
            last_error_message = NULL
        WHERE sequence_id IN (${placeholders})
          AND delivered_at IS NULL
          AND dead_lettered_at IS NULL
      `, [leaseOwner, leaseToken, ...sequenceIds]);
      if (update.affectedRows !== rows.length) {
        throw new Error("Could not lease every selected outbox row");
      }
      await connection.commit();

      return rows.map((row) => ({
        sequenceId: String(row.sequence_id),
        eventId: row.event_id,
        envelope: parseEnvelope(row.envelope, row.event_id),
        attemptCount: Number(row.attempt_count) + 1,
        leaseToken,
      }));
    } catch (error) {
      await connection.rollback().catch(() => {});
      throw error;
    } finally {
      connection.release();
    }
  }

  async markDelivered(claimed, receipts) {
    const byEventId = new Map(receipts.map((receipt) => [receipt.eventId, receipt]));
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      for (const item of claimed) {
        const receipt = byEventId.get(item.eventId);
        if (receipt === undefined) throw new Error(`Ledger response omitted receipt for ${item.eventId}`);
        const [result] = await connection.execute(`
          UPDATE ${this.table}
          SET delivered_at = UTC_TIMESTAMP(6),
              receipt = ?,
              lease_owner = NULL,
              lease_token = NULL,
              lease_expires_at = NULL,
              last_error_code = NULL,
              last_error_message = NULL
          WHERE sequence_id = ?
            AND lease_token = ?
            AND delivered_at IS NULL
        `, [JSON.stringify(receipt), item.sequenceId, item.leaseToken]);
        if (result.affectedRows !== 1) throw new Error(`Lease was lost before event ${item.eventId} could be marked delivered`);
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback().catch(() => {});
      throw error;
    } finally {
      connection.release();
    }
  }

  async markFailed(claimed, error, { retryDelayMs }) {
    const errorCode = String(error.code ?? "DELIVERY_FAILED").slice(0, 128);
    const errorMessage = String(error.message ?? "Delivery failed").slice(0, 1024);
    const retryable = error.retryable !== false;
    const retryDelayMicroseconds = Math.max(100_000, Math.round(retryDelayMs * 1_000));
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      for (const item of claimed) {
        const shouldDeadLetter = !retryable || item.attemptCount >= this.maxAttempts;
        const [result] = await connection.execute(`
          UPDATE ${this.table}
          SET lease_owner = NULL,
              lease_token = NULL,
              lease_expires_at = NULL,
              last_error_code = ?,
              last_error_message = ?,
              dead_lettered_at = CASE WHEN ? THEN UTC_TIMESTAMP(6) ELSE dead_lettered_at END,
              available_at = CASE
                WHEN ? THEN available_at
                ELSE TIMESTAMPADD(MICROSECOND, ?, UTC_TIMESTAMP(6))
              END
          WHERE sequence_id = ?
            AND lease_token = ?
            AND delivered_at IS NULL
        `, [
          errorCode,
          errorMessage,
          shouldDeadLetter,
          shouldDeadLetter,
          retryDelayMicroseconds,
          item.sequenceId,
          item.leaseToken,
        ]);
        if (result.affectedRows !== 1) throw new Error(`Lease was lost before event ${item.eventId} failure could be recorded`);
      }
      await connection.commit();
    } catch (recordingError) {
      await connection.rollback().catch(() => {});
      throw recordingError;
    } finally {
      connection.release();
    }
  }

  async ping() {
    await this.pool.query("SELECT 1");
  }

  async close() {
    await this.pool.end();
  }
}
