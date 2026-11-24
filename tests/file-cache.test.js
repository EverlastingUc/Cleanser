import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readCachedText } from "../src/file-cache.js";

test("cached text reads return current content after a file changes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cleanser-cache-"));
  const filePath = path.join(root, "sample.txt");
  try {
    await fs.writeFile(filePath, "one");
    assert.equal(await readCachedText(filePath), "one");
    await fs.writeFile(filePath, "two");
    assert.equal(await readCachedText(filePath), "two");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("cached text reads bypass caching for large files and reject directories", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cleanser-cache-"));
  const filePath = path.join(root, "large.txt");
  try {
    const source = "x".repeat(300 * 1024);
    await fs.writeFile(filePath, source);
    assert.equal((await readCachedText(filePath)).length, source.length);
    await assert.rejects(readCachedText(root), /regular, non-symbolic file/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
