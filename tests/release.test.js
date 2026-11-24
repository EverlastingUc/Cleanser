import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const readJson = async (relative) =>
  JSON.parse(
    await fs.readFile(new URL(`../${relative}`, import.meta.url), "utf8"),
  );

test("package and lockfile versions match for reproducible installs", async () => {
  const [manifest, lock] = await Promise.all([
    readJson("package.json"),
    readJson("package-lock.json"),
  ]);
  assert.equal(lock.name, manifest.name);
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[""].version, manifest.version);
  assert.deepEqual(lock.packages[""].dependencies, manifest.dependencies);
  assert.deepEqual(lock.packages[""].devDependencies, manifest.devDependencies);
  assert.deepEqual(lock.packages[""].engines, manifest.engines);
});

test("VS Code extension manifest points at packaged implementation files", async () => {
  const manifest = await readJson("package.json");
  const ignored = (
    await fs.readFile(new URL("../.vscodeignore", import.meta.url), "utf8")
  )
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  assert.equal(manifest.main, "./vscode/extension.cjs");
  const contributedCommands = new Set(
    manifest.contributes.commands.map((command) => command.command),
  );
  for (const command of [
    "cleanser.formatCurrentFile",
    "cleanser.previewCurrentFile",
    "cleanser.applySafeFixesCurrentFile",
    "cleanser.cleanWorkspace",
    "cleanser.explainRule",
  ]) {
    assert.ok(contributedCommands.has(command), `Missing ${command} command`);
  }
  for (const required of ["package.json", "src/**", "vscode/extension.cjs"]) {
    assert.ok(
      !ignored.includes(required),
      `.vscodeignore must not list ${required}`,
    );
  }
});
