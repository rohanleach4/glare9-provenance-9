import { open, link, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import { fail, invariant } from "./errors.js";

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writeExclusiveAndPromote(outputPath, fileBytes, {
  errorCode = "SEALED_WRITE",
  extensionErrorCode = "SEALED_EXTENSION",
  description = "sealed file",
  testFaultInjector,
} = {}) {
  invariant(outputPath.endsWith(".g9p"), extensionErrorCode, `${description} output path must end with .g9p`);
  const partPath = `${outputPath}.part`;
  await mkdir(dirname(outputPath), { recursive: true });

  let handle;
  try {
    handle = await open(partPath, "wx", 0o600);
    testFaultInjector?.("sealed.after-open", { outputPath, partPath });
    await handle.writeFile(fileBytes);
    testFaultInjector?.("sealed.after-write", { outputPath, partPath });
    await handle.sync();
    testFaultInjector?.("sealed.after-file-sync", { outputPath, partPath });
    await handle.close();
    handle = undefined;

    // A hard-link promotion is atomic and refuses to replace an existing sealed file.
    testFaultInjector?.("sealed.before-promotion", { outputPath, partPath });
    await link(partPath, outputPath);
    testFaultInjector?.("sealed.after-promotion", { outputPath, partPath });
    await syncDirectory(dirname(outputPath));
    testFaultInjector?.("sealed.after-directory-sync", { outputPath, partPath });
    await unlink(partPath);
    testFaultInjector?.("sealed.after-part-removal", { outputPath, partPath });
    await syncDirectory(dirname(outputPath));
    testFaultInjector?.("sealed.after-cleanup-sync", { outputPath, partPath });
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => {});
    }
    fail(errorCode, `Could not write and promote ${description} at ${outputPath}`, error);
  }
}
