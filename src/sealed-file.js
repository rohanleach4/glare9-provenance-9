import { open, link, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import { fail, invariant } from "./errors.js";

export async function writeExclusiveAndPromote(outputPath, fileBytes, {
  errorCode = "SEALED_WRITE",
  extensionErrorCode = "SEALED_EXTENSION",
  description = "sealed file",
} = {}) {
  invariant(outputPath.endsWith(".g9p"), extensionErrorCode, `${description} output path must end with .g9p`);
  const partPath = `${outputPath}.part`;
  await mkdir(dirname(outputPath), { recursive: true });

  let handle;
  try {
    handle = await open(partPath, "wx", 0o600);
    await handle.writeFile(fileBytes);
    await handle.sync();
    await handle.close();
    handle = undefined;

    // A hard-link promotion is atomic and refuses to replace an existing sealed file.
    await link(partPath, outputPath);
    await unlink(partPath);
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => {});
    }
    fail(errorCode, `Could not write and promote ${description} at ${outputPath}`, error);
  }
}
