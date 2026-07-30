import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { acquireWriterLock } from "../src/writer-lock.js";

test("ledger writer lock rejects a second service and supports clean reacquisition", async () => {
  const directory = await mkdtemp(join(tmpdir(), "g9p-writer-lock-"));
  try {
    const first = await acquireWriterLock(directory);
    await assert.rejects(acquireWriterLock(directory), (error) => error.code === "LEDGER_WRITER_LOCKED");
    await first.release();
    await first.release();
    const second = await acquireWriterLock(directory);
    await second.release();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
