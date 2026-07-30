import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

function purl(name, version) {
  const encoded = name.startsWith("@")
    ? `@${name.slice(1).split("/").map(encodeURIComponent).join("/")}`
    : encodeURIComponent(name);
  return `pkg:npm/${encoded}@${encodeURIComponent(version)}`;
}

export async function generateSbom(lockPath = "package-lock.json") {
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  const components = [];
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    const match = path.match(/(?:^|\/)node_modules\/(?:@([^/]+)\/)?([^/]+)$/u);
    const name = entry.name ?? (match === null ? undefined : match[1] === undefined ? match[2] : `@${match[1]}/${match[2]}`);
    if (path === "" || name === undefined || entry.version === undefined || entry.dev === true) continue;
    components.push({
      type: path.includes("node_modules/") ? "library" : "application",
      name,
      version: entry.version,
      bomRef: purl(name, entry.version),
      purl: purl(name, entry.version),
      ...(entry.integrity === undefined ? {} : { hashes: [{ alg: "SHA-512", content: entry.integrity.replace(/^sha512-/u, "") }] }),
    });
  }
  components.sort((left, right) => left.bomRef.localeCompare(right.bomRef));
  const root = lock.packages?.[""] ?? { name: lock.name, version: lock.version };
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: { component: { type: "application", name: root.name, version: root.version, bomRef: purl(root.name, root.version), purl: purl(root.name, root.version) } },
    components,
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${JSON.stringify(await generateSbom(), null, 2)}\n`);
}
