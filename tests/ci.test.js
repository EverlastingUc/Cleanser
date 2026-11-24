import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCiConfig } from "../src/ci.js";

test("CI starters cover GitLab and Bitbucket without overwriting files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cleanser-ci-"));
  try {
    for (const [provider, filePath] of [
      ["gitlab", ".gitlab-ci.yml"],
      ["bitbucket", "bitbucket-pipelines.yml"],
    ]) {
      const result = await createCiConfig({ root, provider });
      assert.equal(result.filePath, filePath);
      const source = await fs.readFile(path.join(root, filePath), "utf8");
      assert.match(source, /npm ci/);
      assert.match(source, /npm test/);
      assert.match(source, /npm run check/);
      await assert.rejects(
        createCiConfig({ root, provider }),
        /already exists; Cleanser left it unchanged/,
      );
      assert.equal(
        await fs.readFile(path.join(root, filePath), "utf8"),
        source,
      );
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});


test("CI starter generation respects the project write lock", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cleanser-ci-lock-"));
  try {
    await fs.writeFile(
      path.join(root, ".cleanser.lock"),
      JSON.stringify({ pid: process.pid, startedAt: "test" }),
    );
    await assert.rejects(
      createCiConfig({ root, provider: "gitlab" }),
      /Another Cleanser write operation holds \.cleanser\.lock/,
    );
    await assert.rejects(fs.access(path.join(root, ".gitlab-ci.yml")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
