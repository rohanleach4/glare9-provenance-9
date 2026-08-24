import { createHash } from "node:crypto";
import { createGzip } from "node:zlib";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { spawnSync } from "node:child_process";

import { generateSbom } from "./generate-sbom.js";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: process.cwd(), encoding: "utf8", ...options });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
  return result.stdout;
}

const outputDirectory = process.argv[2] === undefined ? null : resolve(process.argv[2]);
if (outputDirectory === null) throw new Error("Usage: npm run release:evidence -- <output-directory>");
if (run("git", ["status", "--porcelain"]).trim() !== "") throw new Error("Release evidence requires a clean working tree");

const commit = run("git", ["rev-parse", "HEAD"]).trim();
const version = JSON.parse(await readFile("package.json", "utf8")).version;
const releaseTag = `v${version}`;
const tagsAtCommit = run("git", ["tag", "--points-at", commit]).trim().split("\n").filter(Boolean);
if (!tagsAtCommit.includes(releaseTag)) throw new Error(`Release evidence requires tag ${releaseTag} at HEAD`);
if (run("git", ["cat-file", "-t", `refs/tags/${releaseTag}`]).trim() !== "tag") {
  throw new Error(`Release tag ${releaseTag} must be annotated`);
}
run("git", ["verify-tag", releaseTag]);
const prefix = `glare9-provenance-${version}/`;
await mkdir(outputDirectory, { recursive: true });
const tarPath = resolve(outputDirectory, `glare9-provenance-${version}.tar`);
const archivePath = `${tarPath}.gz`;
const archive = spawnSync("git", ["archive", "--format=tar", `--prefix=${prefix}`, commit], {
  cwd: process.cwd(),
  encoding: null,
  maxBuffer: 256 * 1024 * 1024,
});
if (archive.error !== undefined) throw archive.error;
if (archive.status !== 0) throw new Error("git archive failed");
await writeFile(tarPath, archive.stdout);
await pipeline((await open(tarPath, "r")).createReadStream(), createGzip({ level: 9, mtime: 0 }), (await open(archivePath, "w")).createWriteStream());
const archiveBytes = await readFile(archivePath);
const sha256 = createHash("sha256").update(archiveBytes).digest("hex");
await writeFile(`${archivePath}.sha256`, `${sha256}  ${basename(archivePath)}\n`);

const sbom = await generateSbom();
await writeFile(resolve(outputDirectory, `glare9-provenance-${version}.cdx.json`), `${JSON.stringify(sbom, null, 2)}\n`);
await writeFile(resolve(outputDirectory, "release-evidence.json"), `${JSON.stringify({ version, commit, releaseTag, archive: basename(archivePath), sha256 }, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ version, commit, releaseTag, archive: archivePath, sha256 })}\n`);
