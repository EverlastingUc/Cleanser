import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanProject } from "../src/cleaner.js";
import { loadConfig } from "../src/config.js";

const examplesRoot = fileURLToPath(new URL("../examples/", import.meta.url));

test("JavaScript and TypeScript examples are formatter-clean", async () => {
  for (const name of ["javascript", "typescript"]) {
    const root = path.join(examplesRoot, name);
    const results = await cleanProject({
      root,
      config: await loadConfig(root),
      write: false,
    });
    assert.ok(results.length > 0, `Expected source files in ${name} example.`);
    assert.ok(
      results.every((result) => result.status === "unchanged"),
      `Expected every ${name} example source file to already be formatted.`,
    );
  }
});
