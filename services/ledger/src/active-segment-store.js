import { mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

import {
  decodeCanonical,
  encodeCanonical,
  G9pError,
} from "@glare9/provenance";

const ACTIVE_FILE = /^active-([0-9a-f]{64})-([0-9]{12})-(shard-[0-9]{4})-([0-9]{12})\.state$/u;
const MAX_ACTIVE_STATE_BYTES = 128 * 1024 * 1024;

function exactFields(value, fields, name) {
  const actual = value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value).sort()
    : [];
  const expected = [...fields].sort();
  if (actual.length !== expected.length || !actual.every((field, index) => field === expected[index])) {
    throw new G9pError("ACTIVE_STATE_FIELDS", `${name} fields do not match active-state version 1`);
  }
}

function canonicalTimestamp(value) {
  const parsed = typeof value === "string" ? new Date(value) : new Date(Number.NaN);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new G9pError("ACTIVE_STATE_TIMESTAMP", "Active segment openedAt must be a canonical UTC timestamp");
  }
}

async function pathExists(path) {
  try {
    await stat(path);
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

function validateState(state, expectedName) {
  exactFields(state, [
    "kind",
    "version",
    "ledgerDirectory",
    "ledgerId",
    "epochNumber",
    "shardId",
    "segmentNumber",
    "formatVersion",
    "openedAt",
    "previousSegmentHash",
    "blocks",
  ], "Active segment");
  if (state.kind !== "g9p-active-segment" || state.version !== 1) {
    throw new G9pError("ACTIVE_STATE_VERSION", "Unsupported active-segment state version");
  }
  if (typeof state.ledgerDirectory !== "string" || !/^[0-9a-f]{64}$/u.test(state.ledgerDirectory)) {
    throw new G9pError("ACTIVE_STATE_LEDGER", "Active segment has an invalid ledger directory identity");
  }
  if (typeof state.ledgerId !== "string" || state.ledgerId.length === 0) {
    throw new G9pError("ACTIVE_STATE_LEDGER", "Active segment has an invalid ledger identity");
  }
  if (!Number.isSafeInteger(state.epochNumber) || state.epochNumber < 0
    || !Number.isSafeInteger(state.segmentNumber) || state.segmentNumber < 0
    || !new Set([1, 2]).has(state.formatVersion)) {
    throw new G9pError("ACTIVE_STATE_POSITION", "Active segment has an invalid epoch, segment, or format version");
  }
  if (typeof state.shardId !== "string" || !/^shard-[0-9]{4}$/u.test(state.shardId)) {
    throw new G9pError("ACTIVE_STATE_SHARD", "Active segment has an invalid shard identity");
  }
  canonicalTimestamp(state.openedAt);
  if (state.previousSegmentHash !== null
    && (!(state.previousSegmentHash instanceof Uint8Array) || state.previousSegmentHash.byteLength !== 32)) {
    throw new G9pError("ACTIVE_STATE_PREVIOUS", "Active segment previous hash must be null or 32 bytes");
  }
  if (!Array.isArray(state.blocks) || state.blocks.length === 0) {
    throw new G9pError("ACTIVE_STATE_BLOCKS", "Active segment state must contain at least one completed block");
  }
  for (const [index, block] of state.blocks.entries()) {
    exactFields(block, ["blockIndex", "records", "uncompressedLength", "recordsHash", "data"], `Active block ${index}`);
    if (block.blockIndex !== index || !Array.isArray(block.records) || block.records.length === 0) {
      throw new G9pError("ACTIVE_STATE_BLOCKS", "Active segment blocks must be non-empty and consecutively indexed");
    }
    if (!Number.isSafeInteger(block.uncompressedLength) || block.uncompressedLength < 1
      || !(block.recordsHash instanceof Uint8Array) || block.recordsHash.byteLength !== 32
      || !(block.data instanceof Uint8Array) || block.data.byteLength < 1) {
      throw new G9pError("ACTIVE_STATE_BLOCKS", "Active segment contains invalid compressed-block metadata");
    }
    for (const record of block.records) {
      exactFields(record, ["eventId", "recordHash"], "Active block record");
      if (typeof record.eventId !== "string" || record.eventId.length === 0
        || typeof record.recordHash !== "string" || !/^[0-9a-f]{64}$/u.test(record.recordHash)) {
        throw new G9pError("ACTIVE_STATE_RECORD", "Active segment contains an invalid record reference");
      }
    }
  }
  if (ActiveSegmentStore.fileName(state) !== expectedName) {
    throw new G9pError("ACTIVE_STATE_FILE", `Active state filename ${expectedName} does not match its content`);
  }
  return state;
}

async function readState(path, expectedName) {
  const details = await stat(path);
  if (!details.isFile() || details.size > MAX_ACTIVE_STATE_BYTES) {
    throw new G9pError("ACTIVE_STATE_LIMIT", `Active state ${expectedName} exceeds its permitted size`);
  }
  let decoded;
  try {
    decoded = decodeCanonical(await readFile(path), { maxBytes: MAX_ACTIVE_STATE_BYTES });
  } catch (error) {
    throw new G9pError("ACTIVE_STATE_DECODE", `Could not decode active state ${expectedName}`, { cause: error });
  }
  return validateState(decoded, expectedName);
}

export class ActiveSegmentStore {
  constructor(directory, { testFaultInjector } = {}) {
    this.directory = directory;
    this.testFaultInjector = testFaultInjector;
  }

  static fileName(state) {
    return `active-${state.ledgerDirectory}-${state.epochNumber.toString().padStart(12, "0")}-${state.shardId}-${state.segmentNumber.toString().padStart(12, "0")}.state`;
  }

  async initialize() {
    await mkdir(this.directory, { recursive: true });
    const initial = await readdir(this.directory, { withFileTypes: true });
    for (const entry of initial) {
      if (!entry.isFile() || !entry.name.endsWith(".state.new")) continue;
      const finalName = entry.name.slice(0, -4);
      if (!ACTIVE_FILE.test(finalName)) {
        throw new G9pError("ACTIVE_STATE_FILE", `Unexpected provisional active-state file ${entry.name}`);
      }
      const newPath = join(this.directory, entry.name);
      const finalPath = join(this.directory, finalName);
      if (await pathExists(finalPath)) {
        await unlink(newPath);
      } else {
        await readState(newPath, finalName);
        await rename(newPath, finalPath);
      }
      await syncDirectory(this.directory);
    }

    const states = [];
    for (const entry of (await readdir(this.directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile() || !ACTIVE_FILE.test(entry.name)) {
        throw new G9pError("ACTIVE_STATE_FILE", `Unexpected file ${entry.name} in active-state directory`);
      }
      const path = join(this.directory, entry.name);
      states.push({ ...(await readState(path, entry.name)), path });
    }
    return states;
  }

  async persist(state) {
    const name = ActiveSegmentStore.fileName(state);
    validateState(state, name);
    const path = join(this.directory, name);
    const newPath = `${path}.new`;
    const payload = encodeCanonical(state);
    if (payload.length > MAX_ACTIVE_STATE_BYTES) {
      throw new G9pError("ACTIVE_STATE_LIMIT", `Active state ${name} exceeds its permitted size`);
    }
    await unlink(newPath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    let handle;
    try {
      handle = await open(newPath, "wx", 0o600);
      await handle.writeFile(payload);
      this.testFaultInjector?.("active-state.after-write", { path, newPath });
      await handle.sync();
      this.testFaultInjector?.("active-state.after-file-sync", { path, newPath });
      await handle.close();
      handle = undefined;
      await rename(newPath, path);
      this.testFaultInjector?.("active-state.after-promotion", { path, newPath });
      await syncDirectory(this.directory);
      this.testFaultInjector?.("active-state.after-directory-sync", { path, newPath });
    } catch (error) {
      if (handle !== undefined) await handle.close().catch(() => {});
      throw new G9pError("ACTIVE_STATE_WRITE", `Could not persist active segment state ${name}`, { cause: error });
    }
    return path;
  }

  async remove(state) {
    const path = state.path ?? join(this.directory, ActiveSegmentStore.fileName(state));
    try {
      await unlink(path);
      await syncDirectory(this.directory);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw new G9pError("ACTIVE_STATE_REMOVE", `Could not remove active segment state ${path}`, { cause: error });
      }
    }
  }
}
