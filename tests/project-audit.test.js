import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { auditProject } from "../src/project-audit.js";

async function withProject(callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cleanser-audit-"));
  try {
    await callback(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("project audit deterministically reports file, directory, and config candidates", async () => {
  await withProject(async (root) => {
    await fs.writeFile(
      path.join(root, ".gitignore"),
      [
        "node_modules/",
        "dist/",
        "build/",
        "coverage/",
        ".cleanser-backups/",
      ].join("\n"),
    );
    await fs.writeFile(path.join(root, "empty.txt"), "");
    await fs.writeFile(path.join(root, "scratch.tmp"), "temporary");
    await fs.writeFile(path.join(root, "old.bak"), "backup");
    await fs.writeFile(path.join(root, "run.log"), "log");
    await fs.writeFile(path.join(root, ".prettierrc"), '{"semi":true}');
    await fs.mkdir(path.join(root, "nested"), { recursive: true });
    await fs.writeFile(
      path.join(root, "nested", ".prettierrc"),
      '{"semi":true}',
    );
    await fs.mkdir(path.join(root, "empty-directory"));
    await fs.mkdir(path.join(root, "dist"));
    await fs.mkdir(path.join(root, "node_modules"));

    const first = await auditProject({ root });
    const second = await auditProject({ root });
    const ruleIds = new Set(first.findings.map((item) => item.ruleId));
    for (const ruleId of [
      "empty-file",
      "empty-directory",
      "temporary-file",
      "backup-file",
      "log-file",
      "build-artifact",
      "duplicate-configuration",
    ]) {
      assert.ok(ruleIds.has(ruleId), `Expected audit finding ${ruleId}.`);
    }
    assert.equal(ruleIds.has("missing-gitignore-entry"), false);
    assert.deepEqual(first, second);
    assert.equal(
      await fs.readFile(path.join(root, "old.bak"), "utf8"),
      "backup",
    );
    assert.equal(first.summary.fileCount, 7);
  });
});

test("audit reports missing ignore entries only for existing generated directories", async () => {
  await withProject(async (root) => {
    await fs.mkdir(path.join(root, "dist"));
    await fs.writeFile(path.join(root, "app.js"), "const value = 1;");

    const result = await auditProject({ root });
    const missing = result.findings.filter(
      (item) => item.ruleId === "missing-gitignore-entry",
    );
    assert.deepEqual(
      missing.map((item) => item.message),
      ["Add an ignore pattern for the existing dist/ directory."],
    );
  });
});

test("audit flags likely empty JavaScript and TypeScript test files", async () => {
  await withProject(async (root) => {
    await fs.mkdir(path.join(root, "src", "__tests__"), { recursive: true });
    await fs.writeFile(
      path.join(root, "src", "empty.test.js"),
      "export const helper = true;\n",
    );
    await fs.writeFile(
      path.join(root, "src", "valid.spec.ts"),
      'import { test } from "node:test";\ntest("works", () => {});\n',
    );
    await fs.writeFile(
      path.join(root, "src", "__tests__", "syntax-error.js"),
      "const = ;\n",
    );

    const result = await auditProject({ root });
    const candidates = result.findings.filter(
      (item) => item.ruleId === "test-file-without-tests",
    );
    assert.deepEqual(
      candidates.map((item) => item.filePath),
      ["src/empty.test.js"],
    );
    assert.ok(candidates.every((item) => item.severity === "info"));
    assert.match(
      candidates[0].message,
      /dynamic registration may not be detected/,
    );
  });
});

test("project audit identifies framework and build metadata without claiming deep analysis", async () => {
  await withProject(async (root) => {
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        engines: { node: ">=20" },
        dependencies: {
          react: "^19.0.0",
          next: "^15.0.0",
          vue: "^3.0.0",
          "@angular/core": "^19.0.0",
          svelte: "^5.0.0",
          express: "^5.0.0",
          "@nestjs/core": "^11.0.0",
        },
      }),
    );
    await fs.writeFile(
      path.join(root, "requirements.txt"),
      "Django>=5.0\nFlask[async]>=3.0\n",
    );
    await fs.writeFile(
      path.join(root, "composer.json"),
      JSON.stringify({ require: { "laravel/framework": "^12.0" } }),
    );
    await fs.writeFile(
      path.join(root, "pom.xml"),
      "<dependency>org.springframework.boot</dependency>",
    );
    await fs.writeFile(path.join(root, "App.csproj"), "<Project />");
    await fs.writeFile(
      path.join(root, "Cargo.toml"),
      "[package]\nname='app'\n",
    );
    await fs.writeFile(
      path.join(root, "go.mod"),
      "module example.invalid/app\n",
    );
    await fs.writeFile(path.join(root, "CMakeLists.txt"), "project(app)\n");

    const result = await auditProject({ root });
    const detections = result.findings.filter(
      (item) => item.ruleId === "framework-detected",
    );
    assert.equal(result.summary.frameworkCount, 16);
    assert.deepEqual(
      [
        ...new Set(
          detections.map(
            (item) => item.message.match(/Detected likely (.*?) project/)[1],
          ),
        ),
      ].sort(),
      [
        ".NET",
        "CMake",
        "Cargo",
        "Django",
        "Express",
        "Flask",
        "Go module",
        "Angular",
        "NestJS",
        "Next.js",
        "Node.js",
        "React",
        "Laravel",
        "Spring",
        "Svelte",
        "Vue",
      ].sort(),
    );
    assert.ok(
      detections.every((item) =>
        /does not validate framework-specific/.test(item.message),
      ),
    );
  });
});

test("detects byte-identical files with the same extension", async () => {
  await withProject(async (root) => {
    const original = Buffer.from("same useful content\n", "utf8");
    await fs.writeFile(path.join(root, "first.ts"), original);
    await fs.writeFile(path.join(root, "copy.ts"), original);
    await fs.writeFile(path.join(root, "different.js"), original);

    const result = await auditProject({ root });
    const duplicates = result.findings.filter(
      (finding) => finding.ruleId === "duplicate-file",
    );

    assert.deepEqual(
      duplicates.map(({ filePath, message }) => ({ filePath, message })),
      [
        {
          filePath: "first.ts",
          message: "File content exactly matches copy.ts.",
        },
      ],
    );
    assert.deepEqual(await fs.readFile(path.join(root, "copy.ts")), original);
  });
});

test("audits JavaScript imports against declared npm dependencies", async () => {
  await withProject(async (root) => {
    const manifest = {
      name: "sample-app",
      version: "1.0.0",
      engines: { vscode: "^1.90.0" },
      dependencies: { "known-package": "^1.0.0", repeated: "^2.0.0" },
      devDependencies: {
        "known-package": "^2.0.0",
        repeated: "^2.0.0",
        "unused-tool": "^3.0.0",
      },
    };
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify(manifest),
    );
    await fs.writeFile(
      path.join(root, "package-lock.json"),
      JSON.stringify({
        name: manifest.name,
        version: manifest.version,
        lockfileVersion: 3,
        packages: {
          "": {
            name: manifest.name,
            version: manifest.version,
            dependencies: manifest.dependencies,
            devDependencies: manifest.devDependencies,
          },
        },
      }),
    );
    await fs.writeFile(
      path.join(root, "sample.js"),
      [
        'import "node:fs";',
        'import * as vscode from "vscode";',
        'import "known-package/subpath";',
        'import "repeated";',
        'import("@scope/missing/subpath");',
        'require("missing-commonjs-package");',
        'import "@/local-alias";',
        'import("https://example.invalid/remote-module.js");',
        'import "./local-module.js";',
      ].join("\n"),
    );

    const result = await auditProject({ root });
    const byRule = (ruleId) =>
      result.findings.filter((item) => item.ruleId === ruleId);

    assert.deepEqual(
      byRule("missing-dependency").map(({ message }) => message),
      [
        'External package "@scope/missing" is imported but is not listed in package.json.',
        'External package "missing-commonjs-package" is imported but is not listed in package.json.',
      ],
    );
    assert.equal(byRule("dependency-version-conflict").length, 1);
    assert.equal(byRule("duplicate-dependency").length, 1);
    assert.equal(byRule("unused-dependency").length, 1);
    assert.equal(byRule("lockfile-mismatch").length, 0);
    assert.equal(
      byRule("missing-dependency").some((item) =>
        item.message.includes('"vscode"'),
      ),
      false,
    );
  });
});

test("reports unreachable package modules only from resolvable declared entrypoints", async () => {
  await withProject(async (root) => {
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "audit-sample", main: "src/index.js" }),
    );
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.mkdir(path.join(root, "tests"), { recursive: true });
    await fs.writeFile(
      path.join(root, "src", "index.js"),
      'import "./used.js";\n',
    );
    await fs.writeFile(
      path.join(root, "src", "used.js"),
      "export const value = 1;\n",
    );
    await fs.writeFile(
      path.join(root, "src", "orphan.js"),
      "export const unused = 2;\n",
    );
    await fs.writeFile(
      path.join(root, "tests", "orphan.test.js"),
      "export const testEntry = 3;\n",
    );

    const report = await auditProject({ root });
    const unused = report.findings.filter(
      (item) => item.ruleId === "unused-module-candidate",
    );
    assert.deepEqual(
      unused.map((item) => item.filePath),
      ["src/orphan.js"],
    );
    assert.match(unused[0].message, /Dynamic imports, framework conventions/);
    assert.equal(
      await fs.readFile(path.join(root, "src", "orphan.js"), "utf8"),
      "export const unused = 2;\n",
    );
  });

  await withProject(async (root) => {
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "no-entrypoint" }),
    );
    await fs.writeFile(path.join(root, "app.js"), "export const app = true;\n");
    await fs.writeFile(
      path.join(root, "helper.js"),
      "export const helper = true;\n",
    );

    const report = await auditProject({ root });
    assert.equal(
      report.findings.some((item) => item.ruleId === "unused-module-candidate"),
      false,
    );
  });
});

test("reports unreferenced assets as informational candidates without deleting files", async () => {
  await withProject(async (root) => {
    await fs.mkdir(path.join(root, "public"), { recursive: true });
    await fs.mkdir(path.join(root, "src", "assets", "a"), {
      recursive: true,
    });
    await fs.mkdir(path.join(root, "src", "assets", "b"), {
      recursive: true,
    });
    await fs.writeFile(path.join(root, "public", "logo.png"), "logo");
    await fs.writeFile(
      path.join(root, "src", "assets", "a", "icon.svg"),
      "<svg></svg>",
    );
    await fs.writeFile(
      path.join(root, "src", "assets", "b", "icon.svg"),
      "<svg></svg>",
    );
    await fs.writeFile(path.join(root, "src", "assets", "orphan.jpg"), "image");
    await fs.writeFile(path.join(root, "index.html"), '<img src="/logo.png">');
    await fs.writeFile(
      path.join(root, "src", "app.css"),
      'header { background: url("./assets/a/icon.svg"); }',
    );

    const report = await auditProject({ root });
    const candidates = report.findings.filter(
      (item) => item.ruleId === "unused-asset-candidate",
    );
    assert.deepEqual(
      candidates.map((item) => item.filePath),
      ["src/assets/b/icon.svg", "src/assets/orphan.jpg"],
    );
    assert.ok(candidates.every((item) => item.severity === "info"));
    assert.match(candidates[1].message, /dynamic paths/);
    assert.equal(
      await fs.readFile(path.join(root, "src", "assets", "orphan.jpg"), "utf8"),
      "image",
    );
  });
});

test("reports only obvious orphaned root TypeScript and JavaScript configs", async () => {
  await withProject(async (root) => {
    await fs.writeFile(
      path.join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true } }),
    );
    await fs.writeFile(
      path.join(root, "jsconfig.json"),
      JSON.stringify({ compilerOptions: { checkJs: true } }),
    );

    const report = await auditProject({ root });
    const candidates = report.findings.filter(
      (item) => item.ruleId === "orphaned-configuration-candidate",
    );
    assert.deepEqual(
      candidates.map((item) => item.filePath),
      ["jsconfig.json", "tsconfig.json"],
    );
    assert.ok(candidates.every((item) => item.severity === "info"));
    assert.equal(
      await fs.readFile(path.join(root, "tsconfig.json"), "utf8"),
      JSON.stringify({ compilerOptions: { strict: true } }),
    );
  });

  await withProject(async (root) => {
    await fs.writeFile(
      path.join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true } }),
    );
    await fs.writeFile(
      path.join(root, "jsconfig.json"),
      JSON.stringify({ compilerOptions: { checkJs: true } }),
    );
    await fs.writeFile(path.join(root, "app.ts"), "export {};");
    await fs.writeFile(path.join(root, "app.js"), "export {};");

    const report = await auditProject({ root });
    assert.equal(
      report.findings.some(
        (item) => item.ruleId === "orphaned-configuration-candidate",
      ),
      false,
    );
  });
});

test("detects package-lock drift and malformed dependency manifests", async () => {
  await withProject(async (root) => {
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "sample-app",
        version: "2.0.0",
        dependencies: { runtime: "^1.0.0" },
      }),
    );
    await fs.writeFile(
      path.join(root, "package-lock.json"),
      JSON.stringify({
        name: "old-app-name",
        version: "1.0.0",
        lockfileVersion: 3,
        packages: {
          "": {
            name: "old-app-name",
            version: "1.0.0",
            dependencies: { runtime: "^2.0.0" },
          },
        },
      }),
    );

    const result = await auditProject({ root });
    const lockFinding = result.findings.find(
      (item) => item.ruleId === "lockfile-mismatch",
    );
    assert.match(lockFinding.message, /package name, the package version/);
    assert.match(lockFinding.message, /dependencies/);
    assert.equal(lockFinding.severity, "warning");

    await fs.writeFile(path.join(root, "package.json"), "{ invalid json");
    const malformed = await auditProject({ root });
    assert.ok(
      malformed.findings.some(
        (item) => item.ruleId === "invalid-package-manifest",
      ),
    );

    await fs.writeFile(
      path.join(root, "package.json"),
      '{"name":"first","name":"second","version":"1.0.0"}',
    );
    const duplicateKeys = await auditProject({ root });
    assert.ok(
      duplicateKeys.findings.some(
        (item) => item.ruleId === "invalid-package-manifest",
      ),
    );

    await fs.rm(path.join(root, "package.json"));
    const orphanedLockfile = await auditProject({ root });
    assert.ok(
      orphanedLockfile.findings.some(
        (item) =>
          item.ruleId === "lockfile-mismatch" &&
          item.message.includes("without a root package.json"),
      ),
    );
  });
});
