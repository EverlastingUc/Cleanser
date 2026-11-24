import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { migrateConfigFormat } from "../src/config-migration.js";

const templatePath = new URL("../templates/cleanser.clns", import.meta.url);

async function withProject(callback) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "cleanser-config-migrate-"),
  );
  try {
    await fs.writeFile(
      path.join(root, ".cleanser.clns"),
      await fs.readFile(templatePath, "utf8"),
    );
    await callback(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("configuration migration round-trips settings between YAML and JSON", async () => {
  await withProject(async (root) => {
    const before = JSON.stringify(await loadConfig(root));
    assert.deepEqual(await migrateConfigFormat({ root, to: "json" }), {
      from: ".cleanser.clns",
      to: ".cleanser.json",
    });
    await assert.rejects(fs.access(path.join(root, ".cleanser.clns")));
    assert.equal(JSON.stringify(await loadConfig(root)), before);

    assert.deepEqual(await migrateConfigFormat({ root, to: "clns" }), {
      from: ".cleanser.json",
      to: ".cleanser.clns",
    });
    await assert.rejects(fs.access(path.join(root, ".cleanser.json")));
    assert.equal(JSON.stringify(await loadConfig(root)), before);
  });
});

test("configuration migration refuses to replace an existing target", async () => {
  await withProject(async (root) => {
    const sourcePath = path.join(root, ".cleanser.clns");
    const targetPath = path.join(root, ".cleanser.json");
    const source = await fs.readFile(sourcePath, "utf8");
    const target = "keep this file\n";
    await fs.writeFile(targetPath, target);

    await assert.rejects(
      migrateConfigFormat({ root, to: "json" }),
      /already exists; Cleanser left it unchanged/,
    );
    assert.equal(await fs.readFile(sourcePath, "utf8"), source);
    assert.equal(await fs.readFile(targetPath, "utf8"), target);
  });
});


test("configuration migration respects the project write lock", async () => {
  await withProject(async (root) => {
    const sourcePath = path.join(root, ".cleanser.clns");
    const source = await fs.readFile(sourcePath, "utf8");
    await fs.writeFile(
      path.join(root, ".cleanser.lock"),
      JSON.stringify({ pid: 12345, startedAt: "test" }),
    );

    await assert.rejects(
      migrateConfigFormat({ root, to: "json" }),
      /Another Cleanser write operation holds \.cleanser\.lock/,
    );
    assert.equal(await fs.readFile(sourcePath, "utf8"), source);
    await assert.rejects(fs.access(path.join(root, ".cleanser.json")));
  });
});
