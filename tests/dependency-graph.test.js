import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG } from "../src/config.js";
import { analyzeProject } from "../src/analyzer.js";
import { buildDependencyGraph } from "../src/dependency-graph.js";

async function withProject(callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cleanser-graph-"));
  try {
    await callback(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("builds a stable local module graph and detects unresolved relative imports", async () => {
  await withProject(async (root) => {
    const sourceDirectory = path.join(root, "src");
    await fs.mkdir(sourceDirectory);
    await fs.writeFile(
      path.join(sourceDirectory, "a.ts"),
      [
        'import { b } from "./b.js";',
        'import "./missing.js";',
        'import fs from "node:fs";',
        "export const a = b + Boolean(fs);",
      ].join("\n"),
    );
    await fs.writeFile(
      path.join(sourceDirectory, "b.ts"),
      'import { a } from "./a.js"; export const b = a;',
    );

    const graph = await buildDependencyGraph({
      root,
      config: DEFAULT_CONFIG,
    });
    assert.deepEqual(graph.nodes, ["src/a.ts", "src/b.ts"]);
    assert.deepEqual(
      graph.edges.map(({ sourcePath, targetPath }) => [sourcePath, targetPath]),
      [
        ["src/a.ts", "src/b.ts"],
        ["src/a.ts", undefined],
        ["src/b.ts", "src/a.ts"],
      ],
    );
    assert.deepEqual(
      graph.brokenImports.map((item) => item.specifier),
      ["./missing.js"],
    );
    assert.deepEqual(graph.cycles, [["src/a.ts", "src/b.ts"]]);
  });
});

test("analyzer reports broken imports and circular module dependencies", async () => {
  await withProject(async (root) => {
    await fs.writeFile(
      path.join(root, "a.ts"),
      'import { b } from "./b.js"; import "./missing.js"; export const a = b;',
    );
    await fs.writeFile(
      path.join(root, "b.ts"),
      'import { a } from "./a.js"; export const b = a;',
    );

    const findings = await analyzeProject({ root, config: DEFAULT_CONFIG });
    const graphFindings = findings.filter((finding) =>
      ["broken-import", "circular-dependency"].includes(finding.ruleId),
    );
    assert.deepEqual(graphFindings.map((finding) => finding.ruleId).sort(), [
      "broken-import",
      "circular-dependency",
    ]);
  });
});
