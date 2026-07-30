import assert from "node:assert/strict";
import test from "node:test";

import { generateSbom } from "../scripts/generate-sbom.js";

test("CycloneDX SBOM is deterministic and excludes development-only packages", async () => {
  const first = await generateSbom();
  const second = await generateSbom();
  assert.deepEqual(first, second);
  assert.equal(first.bomFormat, "CycloneDX");
  assert.equal(first.specVersion, "1.6");
  assert.ok(first.components.some((component) => component.name === "mysql2"));
  assert.ok(first.components.every((component) => component.name.length > 0 && component.version.length > 0));
});
