import { link, mkdir, open, readFile, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

import {
  decodeCanonical,
  encodeCanonical,
  eventHashHex,
  fromHex,
  G9pError,
  toHex,
  validateEvent,
} from "@glare9/provenance";

const INTAKE_FILE = /^intake-([0-9]{12})-([0-9a-f]{64})\.intake$/u;
const MAX_SEQUENCE = 999_999_999_999;
const MAX_INTAKE_BYTES = 64 * 1024 * 1024;

function exactFields(value, fields) {
  const actual = value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value).sort()
    : [];
  const expected = [...fields].sort();
  if (actual.length !== expected.length || !actual.every((field, index) => field === expected[index])) {
    throw new G9pError("INTAKE_FIELDS", "Durable intake record fields do not match version 1");
  }
}

function canonicalTimestamp(value) {
  const parsed = typeof value === "string" ? new Date(value) : new Date(Number.NaN);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new G9pError("INTAKE_TIMESTAMP", "Durable intake acceptedAt must be a canonical UTC timestamp");
  }
}

async function pathExists(path) {
  try {
    const handle = await open(path, "r");
    await handle.close();
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function fileName(sequence, recordHash) {
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > MAX_SEQUENCE) {
    throw new G9pError("INTAKE_SEQUENCE", "Durable intake sequence is outside its supported range");
  }
  return `intake-${sequence.toString().padStart(12, "0")}-${recordHash}.intake`;
}

function decodeRecord(bytes, expectedName) {
  let record;
  try {
    record = decodeCanonical(bytes, { maxBytes: 64 * 1024 * 1024 });
  } catch (error) {
    throw new G9pError("INTAKE_DECODE", `Could not decode durable intake record ${expectedName}`, { cause: error });
  }
  exactFields(record, ["kind", "version", "sequence", "acceptedAt", "recordHash", "event"]);
  if (record.kind !== "g9p-durable-intake" || record.version !== 1) {
    throw new G9pError("INTAKE_VERSION", "Unsupported durable intake record version");
  }
  if (!Number.isSafeInteger(record.sequence) || record.sequence < 0 || record.sequence > MAX_SEQUENCE) {
    throw new G9pError("INTAKE_SEQUENCE", "Durable intake record contains an invalid sequence");
  }
  canonicalTimestamp(record.acceptedAt);
  if (!(record.recordHash instanceof Uint8Array) || record.recordHash.byteLength !== 32) {
    throw new G9pError("INTAKE_HASH", "Durable intake recordHash must contain 32 bytes");
  }
  validateEvent(record.event);
  const recordHash = toHex(record.recordHash);
  if (eventHashHex(record.event) !== recordHash) {
    throw new G9pError("INTAKE_HASH", "Durable intake event does not match its recordHash");
  }
  if (fileName(record.sequence, recordHash) !== expectedName) {
    throw new G9pError("INTAKE_FILE", `Durable intake filename ${expectedName} does not match its content`);
  }
  return { ...record, recordHash };
}

async function readRecord(path, expectedName) {
  const fileStat = await stat(path);
  if (!fileStat.isFile() || fileStat.size > MAX_INTAKE_BYTES) {
    throw new G9pError("INTAKE_LIMIT", `Durable intake record ${expectedName} exceeds its permitted size`);
  }
  return decodeRecord(await readFile(path), expectedName);
}

export class DurableIntake {
  constructor(directory) {
    this.directory = directory;
    this.nextSequence = 0;
  }

  async initialize() {
    await mkdir(this.directory, { recursive: true });
    await this.#recoverParts();
    const records = [];
    const entries = await readdir(this.directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile()) continue;
      const match = INTAKE_FILE.exec(entry.name);
      if (match === null) {
        throw new G9pError("INTAKE_FILE", `Unexpected file ${entry.name} in durable intake directory`);
      }
      const record = await readRecord(join(this.directory, entry.name), entry.name);
      records.push({ ...record, path: join(this.directory, entry.name) });
      this.nextSequence = Math.max(this.nextSequence, record.sequence + 1);
    }
    return records;
  }

  async append(event, acceptedAt = new Date().toISOString()) {
    validateEvent(event);
    canonicalTimestamp(acceptedAt);
    const sequence = this.nextSequence;
    const recordHash = eventHashHex(event);
    const name = fileName(sequence, recordHash);
    const path = join(this.directory, name);
    const partPath = `${path}.part`;
    const payload = encodeCanonical({
      kind: "g9p-durable-intake",
      version: 1,
      sequence,
      acceptedAt,
      recordHash: fromHex(recordHash, 32),
      event,
    });
    if (payload.length > MAX_INTAKE_BYTES) {
      throw new G9pError("INTAKE_LIMIT", `Event ${event.eventId} exceeds the durable intake record limit`);
    }

    let handle;
    let promoted = false;
    let durable = false;
    try {
      handle = await open(partPath, "wx", 0o600);
      await handle.writeFile(payload);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await link(partPath, path);
      promoted = true;
      await syncDirectory(this.directory);
      durable = true;
      await unlink(partPath);
      await syncDirectory(this.directory);
    } catch (error) {
      if (handle !== undefined) await handle.close().catch(() => {});
      if (!promoted || !durable) {
        throw new G9pError("INTAKE_WRITE", `Could not durably retain event ${event.eventId}`, { cause: error });
      }
    }

    this.nextSequence += 1;
    return { sequence, acceptedAt, recordHash, event, path };
  }

  async remove(record) {
    try {
      await unlink(record.path);
      await syncDirectory(this.directory);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw new G9pError("INTAKE_REMOVE", `Could not retire durable intake record for event ${record.event.eventId}`, { cause: error });
      }
    }
  }

  async #recoverParts() {
    const entries = await readdir(this.directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".intake.part")) continue;
      const finalName = entry.name.slice(0, -5);
      const match = INTAKE_FILE.exec(finalName);
      if (match === null) {
        throw new G9pError("INTAKE_FILE", `Unexpected provisional file ${entry.name} in durable intake directory`);
      }
      const partPath = join(this.directory, entry.name);
      const finalPath = join(this.directory, finalName);
      if (await pathExists(finalPath)) {
        await unlink(partPath);
        await syncDirectory(this.directory);
        continue;
      }
      try {
        await readRecord(partPath, finalName);
      } catch {
        await unlink(partPath);
        await syncDirectory(this.directory);
        continue;
      }
      await link(partPath, finalPath);
      await syncDirectory(this.directory);
      await unlink(partPath);
      await syncDirectory(this.directory);
    }
  }
}
