import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { runFormatSnapshot, SNAPSHOT_FILE } from "../src/snapshots.js";

async function withProject(callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cleanser-snapshot-"));
  try {
    await callback(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("format snapshots are read-only until explicitly updated", async () => {
  await withProject(async (root) => {
    const configSource = await fs.readFile(
      new URL("../templates/cleanser.clns", import.meta.url),
      "utf8",
    );
    await fs.writeFile(path.join(root, ".cleanser.clns"), configSource);
    const file = path.join(root, "sample.js");
    const original = "const value=1";
    await fs.writeFile(file, original);
    const config = await loadConfig(root);

    const missing = await runFormatSnapshot({ config, root });
    assert.equal(missing.status, "missing");
    await assert.rejects(fs.access(path.join(root, SNAPSHOT_FILE)));

    const created = await runFormatSnapshot({ config, root, update: true });
    assert.equal(created.status, "updated");
    assert.equal(created.summary.files, 1);
    const savedSnapshot = await fs.readFile(
      path.join(root, SNAPSHOT_FILE),
      "utf8",
    );
    assert.doesNotMatch(savedSnapshot, /const value/);
    assert.equal(await fs.readFile(file, "utf8"), original);

    assert.equal((await runFormatSnapshot({ config, root })).status, "matched");
    await fs.writeFile(file, "const value=2");
    const mismatch = await runFormatSnapshot({ config, root });
    assert.equal(mismatch.status, "mismatch");
    assert.deepEqual(mismatch.differences, [
      { filePath: "sample.js", status: "changed" },
    ]);
    assert.equal(await fs.readFile(file, "utf8"), "const value=2");

    await runFormatSnapshot({ config, root, update: true });
    assert.equal((await runFormatSnapshot({ config, root })).status, "matched");
  });
});

test("snapshot update refuses to overwrite unrecognized files", async () => {
  await withProject(async (root) => {
    const configSource = await fs.readFile(
      new URL("../templates/cleanser.clns", import.meta.url),
      "utf8",
    );
    await fs.writeFile(path.join(root, ".cleanser.clns"), configSource);
    const snapshotPath = path.join(root, SNAPSHOT_FILE);
    const original = "{}";
    await fs.writeFile(snapshotPath, original);

    await assert.rejects(
      runFormatSnapshot({ config: await loadConfig(root), root, update: true }),
      /expected a Cleanser format snapshot/,
    );
    assert.equal(await fs.readFile(snapshotPath, "utf8"), original);
  });
});
