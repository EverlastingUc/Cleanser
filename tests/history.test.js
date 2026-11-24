import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { listBackups, restoreBackup } from "../src/history.js";

const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));

async function withProject(callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cleanser-history-"));
  try {
    await callback(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function runCli(args, cwd) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
}

test("lists backups deterministically and restores the saved original atomically", async () => {
  await withProject(async (root) => {
    assert.deepEqual(await listBackups({ root }), []);
    await fs.mkdir(path.join(root, ".cleanser-backups", "src"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(root, ".cleanser-backups", "src", "sample.js"),
      "const value=1",
    );
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(
      path.join(root, "src", "sample.js"),
      "const value = 1;\n",
    );

    assert.deepEqual(await listBackups({ root }), ["src/sample.js"]);
    const restored = await restoreBackup({ root, filePath: "src/sample.js" });
    assert.equal(restored.filePath, "src/sample.js");
    assert.equal(restored.bytes, Buffer.byteLength("const value=1"));
    assert.equal(
      await fs.readFile(path.join(root, "src", "sample.js"), "utf8"),
      "const value=1",
    );
    const leftovers = await fs.readdir(path.join(root, "src"));
    assert.deepEqual(leftovers, ["sample.js"]);
  });
});

test("restore rejects traversal, missing backups, and symlink backup roots", async (t) => {
  await withProject(async (root) => {
    await assert.rejects(
      restoreBackup({ root, filePath: "../outside.js" }),
      /must stay inside/,
    );
    await fs.writeFile(path.join(root, "sample.js"), "current");
    await fs.mkdir(path.join(root, ".cleanser-backups"));
    await assert.rejects(
      restoreBackup({ root, filePath: "sample.js" }),
      /Original backup does not exist/,
    );

    const target = path.join(root, "symlink-target");
    try {
      await fs.mkdir(target);
      await fs.rmdir(path.join(root, ".cleanser-backups"));
      await fs.symlink(target, path.join(root, ".cleanser-backups"), "dir");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP", "UNKNOWN"].includes(error.code)) {
        t.skip("Directory symlinks are not available on this platform.");
        return;
      }
      throw error;
    }
    await assert.rejects(listBackups({ root }), /non-symlink directory/);
  });
});

test("restore CLI requires explicit confirmation before replacing a file", async () => {
  await withProject(async (root) => {
    await fs.mkdir(path.join(root, ".cleanser-backups"));
    await fs.writeFile(
      path.join(root, ".cleanser-backups", "sample.js"),
      "old",
    );
    await fs.writeFile(path.join(root, "sample.js"), "new");

    const preview = runCli(["restore", "sample.js"], root);
    assert.equal(preview.status, 1);
    assert.match(preview.stderr, /Re-run with "--yes"/);
    assert.equal(
      await fs.readFile(path.join(root, "sample.js"), "utf8"),
      "new",
    );

    const restored = runCli(["restore", "sample.js", "--yes"], root);
    assert.equal(restored.status, 0, restored.stderr);
    assert.equal(
      await fs.readFile(path.join(root, "sample.js"), "utf8"),
      "old",
    );
  });
});


test("restore refuses to race an active Cleanser write operation", async () => {
  await withProject(async (root) => {
    await fs.mkdir(path.join(root, ".cleanser-backups"));
    await fs.writeFile(
      path.join(root, ".cleanser-backups", "sample.js"),
      "original",
    );
    await fs.writeFile(path.join(root, "sample.js"), "current");
    await fs.writeFile(
      path.join(root, ".cleanser.lock"),
      JSON.stringify({ pid: 12345, startedAt: "test" }),
    );

    await assert.rejects(
      restoreBackup({ root, filePath: "sample.js" }),
      /Another Cleanser write operation holds \.cleanser\.lock/,
    );
    assert.equal(
      await fs.readFile(path.join(root, "sample.js"), "utf8"),
      "current",
    );
  });
});
