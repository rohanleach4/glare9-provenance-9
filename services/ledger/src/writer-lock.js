import { randomUUID } from "node:crypto";
import { open, mkdir, readFile, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

import { G9pError } from "@glare9/provenance";

const LOCK_NAME = ".ledger-writer.lock";

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function acquireWriterLock(dataDirectory) {
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const path = join(dataDirectory, LOCK_NAME);
  const token = randomUUID();
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new G9pError("LEDGER_WRITER_LOCKED", "The ledger data directory already has a writer lock; confirm no ledger process is running before removing a stale lock", { cause: error });
    }
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify({ kind: "g9p-ledger-writer-lock", version: 1, pid: process.pid, host: hostname(), startedAt: new Date().toISOString(), token })}\n`);
    await handle.sync();
    await syncDirectory(dataDirectory);
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(path).catch(() => {});
    throw new G9pError("LEDGER_WRITER_LOCK", "Could not establish the ledger writer lock durably", { cause: error });
  }

  let released = false;
  return Object.freeze({
    path,
    async release() {
      if (released) return;
      released = true;
      await handle.close();
      let current;
      try { current = JSON.parse(await readFile(path, "utf8")); } catch (error) {
        throw new G9pError("LEDGER_WRITER_LOCK", "Ledger writer lock changed or disappeared before release", { cause: error });
      }
      if (current?.token !== token) throw new G9pError("LEDGER_WRITER_LOCK", "Ledger writer lock ownership changed before release");
      await unlink(path);
      await syncDirectory(dataDirectory);
    },
  });
}
