import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runEslint } from "../src/eslint.js";

async function withProject(callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cleanser-eslint-"));
  try {
    await fs.writeFile(path.join(root, "package.json"), "{}\n");
    await callback(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("ESLint integration normalizes findings and excludes outside paths", async () => {
  await withProject(async (root) => {
    const packageRoot = path.join(root, "node_modules", "eslint");
    await fs.mkdir(packageRoot, { recursive: true });
    await fs.writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ main: "index.cjs" }),
    );
    await fs.writeFile(
      path.join(packageRoot, "index.cjs"),
      [
        "class ESLint {",
        "  constructor(options) { this.options = options; }",
        "  async lintFiles(patterns) {",
        "    if (patterns[0] !== '.') throw new Error('unexpected pattern');",
        "    return [{",
        "      filePath: `${this.options.cwd}/src/app.js`,",
        "      errorCount: 1, warningCount: 1,",
        "      messages: [",
        "        { ruleId: 'z-rule', severity: 1, line: 2, column: 1, message: 'warning' },",
        "        { ruleId: 'a-rule', severity: 2, line: 1, column: 3, message: 'error', fix: { range: [0, 1], text: 'x' } },",
        "      ],",
        "    }, { filePath: '/outside/file.js', errorCount: 0, warningCount: 0, messages: [] }];",
        "  }",
        "}",
        "module.exports = { ESLint };",
        "",
      ].join("\n"),
    );

    const result = await runEslint({ root });
    assert.deepEqual(result.summary, {
      filesScanned: 1,
      errorCount: 1,
      warningCount: 1,
      findings: 2,
    });
    assert.equal(result.files[0].filePath, "src/app.js");
    assert.deepEqual(
      result.files[0].messages.map(({ ruleId, severity }) => ({
        ruleId,
        severity,
      })),
      [
        { ruleId: "a-rule", severity: "error" },
        { ruleId: "z-rule", severity: "warning" },
      ],
    );
    assert.equal(result.files[0].messages[0].fixable, true);
  });
});

test("ESLint integration gives a clear error when the dependency is absent", async () => {
  await withProject(async (root) => {
    await assert.rejects(runEslint({ root }), /ESLint is not installed/);
  });
});
