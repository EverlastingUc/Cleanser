import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { typecheckProject } from "../src/typecheck.js";

const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));

async function withProject(callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cleanser-typecheck-"));
  try {
    await callback(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("skips type checking clearly when tsconfig.json is absent", async () => {
  await withProject(async (root) => {
    const result = await typecheckProject({ root });
    assert.deepEqual(result, {
      configured: false,
      fileCount: 0,
      diagnostics: [],
    });
  });
});

test("reports TypeScript errors deterministically without emitting files", async () => {
  await withProject(async (root) => {
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(
      path.join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: false,
          outDir: "dist",
          target: "ES2022",
        },
        include: ["src/**/*.ts"],
      }),
    );
    await fs.writeFile(
      path.join(root, "src", "app.ts"),
      'const value: number = "wrong";\n',
    );

    const first = await typecheckProject({ root });
    const second = await typecheckProject({ root });
    assert.deepEqual(first, second);
    assert.equal(first.configured, true);
    assert.equal(first.fileCount, 1);
    assert.ok(
      first.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === 2322 &&
          diagnostic.filePath === "src/app.ts" &&
          diagnostic.line === 1,
      ),
    );
    await assert.rejects(fs.access(path.join(root, "dist")));
  });
});

test("typecheck CLI emits JSON diagnostics and exits nonzero on type errors", async () => {
  await withProject(async (root) => {
    await fs.writeFile(
      path.join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { strict: true, noEmit: false },
        files: ["app.ts"],
      }),
    );
    await fs.writeFile(path.join(root, "app.ts"), "const value: string = 1;");

    const result = spawnSync(
      process.execPath,
      [cliPath, "typecheck", "--format=json"],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.configured, true);
    assert.ok(report.diagnostics.some((item) => item.code === 2322));
    await assert.rejects(fs.access(path.join(root, "app.js")));
  });
});

test("rejects linked or non-file TypeScript project configs", async () => {
  await withProject(async (root) => {
    await fs.mkdir(path.join(root, "tsconfig.json"));
    await assert.rejects(typecheckProject({ root }), /regular project file/);
  });
});
