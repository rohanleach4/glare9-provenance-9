import { mkdir, open, readFile, readdir, stat, unlink } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { G9pError, invariant } from "./errors.js";
import { writeExclusiveAndPromote } from "./sealed-file.js";

const DEFAULT_MAX_OBJECT_BYTES = 512 * 1024 * 1024;

function validateKey(key, { prefix = false } = {}) {
  invariant(typeof key === "string" && key.length > 0, "SEALED_STORAGE_KEY", "Sealed storage key must be a non-empty string");
  invariant(!key.startsWith("/") && !key.includes("\\") && !key.includes("\0"), "SEALED_STORAGE_KEY", "Sealed storage key must be relative and use forward slashes");
  const parts = key.split("/");
  if (prefix && parts.at(-1) === "") parts.pop();
  invariant(parts.length > 0 && parts.every((part) => part.length > 0 && part !== "." && part !== ".."), "SEALED_STORAGE_KEY", "Sealed storage key contains an invalid path component");
  return prefix && key.endsWith("/") ? `${parts.join("/")}/` : parts.join("/");
}

function validateStorage(storage) {
  invariant(storage !== null && typeof storage === "object", "SEALED_STORAGE", "A sealed storage implementation is required");
  for (const method of ["initialize", "publish", "read", "list"]) {
    invariant(typeof storage[method] === "function", "SEALED_STORAGE", `Sealed storage must implement ${method}()`);
  }
  return storage;
}

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function walkFiles(directory, relative = "") {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const key = relative === "" ? entry.name : `${relative}/${entry.name}`;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkFiles(path, key));
    } else if (entry.isFile()) {
      files.push(key);
    } else {
      throw new G9pError("SEALED_STORAGE_ENTRY", `Unsupported filesystem entry at ${path}`);
    }
  }
  return files;
}

export class LocalFilesystemSealedStorage {
  constructor(rootDirectory, { testFaultInjector } = {}) {
    invariant(typeof rootDirectory === "string" && rootDirectory.length > 0, "SEALED_STORAGE_ROOT", "Local sealed storage requires a root directory");
    this.rootDirectory = resolve(rootDirectory);
    this.testFaultInjector = testFaultInjector;
  }

  #path(key, options) {
    const validated = validateKey(key, options);
    const path = resolve(this.rootDirectory, ...validated.replace(/\/$/u, "").split("/"));
    invariant(path.startsWith(`${this.rootDirectory}${sep}`), "SEALED_STORAGE_KEY", "Sealed storage key escapes its configured root");
    return path;
  }

  async initialize() {
    await mkdir(this.rootDirectory, { recursive: true });
    for (const namespace of ["segments", "routing", "checkpoints", "witnesses"]) {
      const namespacePath = join(this.rootDirectory, namespace);
      await mkdir(namespacePath, { recursive: true });
      const files = await walkFiles(namespacePath);
      const changedDirectories = new Set();
      for (const relative of files) {
        if (!relative.endsWith(".g9p.part")) continue;
        const path = join(namespacePath, ...relative.split("/"));
        await unlink(path);
        changedDirectories.add(resolve(path, ".."));
      }
      for (const directory of [...changedDirectories].sort()) await syncDirectory(directory);
    }
  }

  async publish(key, bytes, options = {}) {
    const validated = validateKey(key);
    invariant(validated.endsWith(".g9p"), "SEALED_STORAGE_EXTENSION", "Sealed objects must use the .g9p extension");
    invariant(bytes instanceof Uint8Array, "SEALED_STORAGE_BYTES", "Sealed object content must be bytes");
    const path = this.#path(validated);
    await writeExclusiveAndPromote(path, bytes, {
      errorCode: options.errorCode ?? "SEALED_STORAGE_WRITE",
      extensionErrorCode: options.extensionErrorCode ?? "SEALED_STORAGE_EXTENSION",
      description: options.description ?? "sealed object",
      testFaultInjector: options.testFaultInjector ?? this.testFaultInjector,
    });
    return { key: validated, byteLength: bytes.byteLength };
  }

  async read(key, { maxBytes = DEFAULT_MAX_OBJECT_BYTES } = {}) {
    const validated = validateKey(key);
    invariant(Number.isSafeInteger(maxBytes) && maxBytes > 0, "SEALED_STORAGE_LIMIT", "Sealed storage read limit must be a positive safe integer");
    const path = this.#path(validated);
    const details = await stat(path);
    invariant(details.isFile(), "SEALED_STORAGE_OBJECT", `Sealed storage key ${validated} is not a file`);
    invariant(details.size <= maxBytes, "SEALED_STORAGE_LIMIT", `Sealed storage key ${validated} exceeds the ${maxBytes} byte read limit`);
    return Uint8Array.from(await readFile(path));
  }

  async list(prefix) {
    const validated = validateKey(prefix, { prefix: true });
    const directoryKey = validated.endsWith("/") ? validated.slice(0, -1) : validated;
    const directory = this.#path(directoryKey);
    const files = await walkFiles(directory);
    return files
      .filter((relative) => !relative.endsWith(".g9p.part"))
      .map((relative) => `${directoryKey}/${relative}`)
      .sort();
  }
}

export function requireSealedStorage(storage) {
  return validateStorage(storage);
}

export const sealedStorageLimits = Object.freeze({
  maxObjectBytes: DEFAULT_MAX_OBJECT_BYTES,
});
