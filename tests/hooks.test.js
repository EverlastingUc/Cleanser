import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { manageGitHook } from "../src/hooks.js";

async function withGitProject(callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cleanser-hooks-"));
  try {
    const initialized = spawnSync("git", ["init"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    });
    if (initialized.error?.code === "ENOENT") return false;
    assert.equal(initialized.status, 0, initialized.stderr);
    await callback(root);
    return true;
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("Git hooks install and remove only Cleanser-managed read-only checks", async (t) => {
  const available = await withGitProject(async (root) => {
    const installed = await manageGitHook({
      root,
      action: "install",
      name: "pre-commit",
    });
    assert.equal(installed.status, "installed");
    const script = await fs.readFile(installed.hookPath, "utf8");
    assert.match(script, /cleanser-managed-hook:v1/);
    assert.match(script, /cleanser check --changed/);

    await assert.rejects(
      manageGitHook({ root, action: "install", name: "pre-commit" }),
      /already exists.*left it unchanged/,
    );
    assert.equal(await fs.readFile(installed.hookPath, "utf8"), script);

    assert.equal(
      (
        await manageGitHook({
          root,
          action: "uninstall",
          name: "pre-commit",
        })
      ).status,
      "uninstalled",
    );
    assert.equal(
      (
        await manageGitHook({
          root,
          action: "uninstall",
          name: "pre-commit",
        })
      ).status,
      "absent",
    );
  });
  if (!available) t.skip("Git is unavailable on this platform.");
});

test("Git hook installation refuses to replace an existing user hook", async (t) => {
  const available = await withGitProject(async (root) => {
    const hooks = path.join(root, ".git", "hooks");
    await fs.mkdir(hooks, { recursive: true });
    const hookPath = path.join(hooks, "pre-push");
    const original = "#!/bin/sh\necho user hook\n";
    await fs.writeFile(hookPath, original);

    await assert.rejects(
      manageGitHook({ root, action: "install", name: "pre-push" }),
      /already exists.*left it unchanged/,
    );
    await assert.rejects(
      manageGitHook({ root, action: "uninstall", name: "pre-push" }),
      /not managed by Cleanser/,
    );
    assert.equal(await fs.readFile(hookPath, "utf8"), original);
  });
  if (!available) t.skip("Git is unavailable on this platform.");
});
