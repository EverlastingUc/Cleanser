import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertCleanWorkingTree } from "../src/git-tools.js";

const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function git(args, cwd) {
  return spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
}

function runCli(args, cwd) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
}

test("clean working-tree guard detects modified and untracked files", async (t) => {
  await withGitProject(async (root) => {
    await assertCleanWorkingTree({ root });

    await fs.writeFile(path.join(root, "sample.js"), "const value = 2;\n");
    await assert.rejects(
      assertCleanWorkingTree({ root }),
      /working-tree protection stopped formatting.*1 changed or untracked/i,
    );

    await fs.writeFile(path.join(root, "sample.js"), "const value = 1;\n");
    await fs.writeFile(path.join(root, "new.js"), "export {};\n");
    await assert.rejects(
      assertCleanWorkingTree({ root }),
      /working-tree protection stopped formatting.*1 changed or untracked/i,
    );
  }).then((result) => {
    if (result) t.skip(result);
  });
});

async function withGitProject(callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cleanser-git-"));
  try {
    const initialized = git(["init"], root);
    if (initialized.error?.code === "ENOENT") return "Git is unavailable.";
    assert.equal(initialized.status, 0, initialized.stderr);
    for (const [key, value] of [
      ["user.name", "Cleanser Tests"],
      ["user.email", "cleanser@example.invalid"],
    ]) {
      const configured = git(["config", key, value], root);
      assert.equal(configured.status, 0, configured.stderr);
    }
    await fs.writeFile(path.join(root, "sample.js"), "const value = 1;\n");
    assert.equal(git(["add", "sample.js"], root).status, 0);
    assert.equal(git(["commit", "-m", "initial"], root).status, 0);
    return await callback(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("Git inspection reports changed and staged files, diffs, comparisons, history, and blame", async (t) => {
  await withGitProject(async (root) => {
    git(["branch", "baseline"], root);
    await fs.writeFile(path.join(root, "sample.js"), "const value = 2;\n");
    const workingFile = path.join(root, "working.txt");
    await fs.writeFile(workingFile, "untracked\n");

    const changed = runCli(["git", "changed"], root);
    assert.equal(changed.status, 0, changed.stderr);
    assert.deepEqual(changed.stdout.trim().split(/\r?\n/), [
      "sample.js",
      "working.txt",
    ]);

    const diff = runCli(["git", "diff"], root);
    assert.equal(diff.status, 0, diff.stderr);
    assert.match(diff.stdout, /-const value = 1;/);
    assert.match(diff.stdout, /\+const value = 2;/);

    const lines = runCli(["git", "lines"], root);
    assert.equal(lines.status, 0, lines.stderr);
    assert.equal(lines.stdout.trim(), "sample.js:1 (1 changed line)");
    const conflicts = runCli(["git", "conflicts"], root);
    assert.equal(conflicts.status, 0, conflicts.stderr);
    assert.match(conflicts.stdout, /No unresolved Git conflicts/);

    assert.equal(git(["add", "sample.js"], root).status, 0);
    const staged = runCli(["git", "changed", "--staged"], root);
    assert.equal(staged.status, 0, staged.stderr);
    assert.equal(staged.stdout.trim(), "sample.js");
    const allChanged = runCli(["git", "changed"], root);
    assert.equal(allChanged.status, 0, allChanged.stderr);
    assert.deepEqual(allChanged.stdout.trim().split(/\r?\n/), [
      "sample.js",
      "working.txt",
    ]);
    const stagedLines = runCli(["git", "lines", "--staged"], root);
    assert.equal(stagedLines.status, 0, stagedLines.stderr);
    assert.equal(stagedLines.stdout.trim(), "sample.js:1 (1 changed line)");

    assert.equal(git(["commit", "-m", "change value"], root).status, 0);
    const comparison = runCli(["git", "compare", "baseline"], root);
    assert.equal(comparison.status, 0, comparison.stderr);
    assert.match(comparison.stdout, /\+const value = 2;/);

    const history = runCli(["git", "history", "sample.js"], root);
    assert.equal(history.status, 0, history.stderr);
    assert.match(history.stdout, /change value/);

    const blame = runCli(["git", "blame", "sample.js"], root);
    assert.equal(blame.status, 0, blame.stderr);
    assert.match(blame.stdout, /const value = 2;/);
  }).then((unavailable) => {
    if (unavailable) t.skip(unavailable);
  });
});

test("Git inspection rejects path traversal and option-like revisions", async (t) => {
  await withGitProject(async (root) => {
    const outside = runCli(["git", "history", "../secret.txt"], root);
    assert.equal(outside.status, 1);
    assert.match(outside.stderr, /must stay inside the project/);

    const revision = runCli(["git", "compare", "--upload-pack=bad"], root);
    assert.equal(revision.status, 1);
    assert.match(revision.stderr, /simple name/);
  }).then((unavailable) => {
    if (unavailable) t.skip(unavailable);
  });
});

test("PR report summarizes committed changes since a safe base revision", async (t) => {
  await withGitProject(async (root) => {
    const initialized = runCli(["init"], root);
    assert.equal(initialized.status, 0, initialized.stderr);
    assert.equal(git(["add", ".cleanser.clns"], root).status, 0);
    assert.equal(git(["commit", "-m", "add Cleanser config"], root).status, 0);
    const base = git(["rev-parse", "--short", "HEAD"], root).stdout.trim();

    await fs.writeFile(path.join(root, "sample.js"), "const value=2");
    assert.equal(git(["add", "sample.js"], root).status, 0);
    assert.equal(git(["commit", "-m", "change source"], root).status, 0);

    const report = runCli(
      ["pr-report", `--base=${base}`, "--format=json"],
      root,
    );
    assert.equal(report.status, 0, report.stderr);
    const result = JSON.parse(report.stdout);
    assert.deepEqual(result.changedFiles, ["sample.js"]);
    assert.equal(result.summary.formattingFilesScanned, 1);
    assert.equal(result.summary.filesNeedingFormatting, 1);
    assert.match(result.markdown, /Cleanser pull request report/);

    const help = runCli(["pr-report", "--help"], root);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /--base=<branch-or-revision>/);
  }).then((unavailable) => {
    if (unavailable) t.skip(unavailable);
  });
});

test("check --changed limits formatting checks to Git modified and untracked files", async (t) => {
  await withGitProject(async (root) => {
    const initialized = runCli(["init"], root);
    assert.equal(initialized.status, 0, initialized.stderr);
    await fs.writeFile(path.join(root, "other.js"), "const untouched=3");
    assert.equal(git(["add", ".cleanser.clns", "other.js"], root).status, 0);
    assert.equal(git(["commit", "-m", "add project config"], root).status, 0);
    await fs.writeFile(path.join(root, "sample.js"), "const changed=2");

    const changed = runCli(["check", "--changed"], root);
    assert.equal(changed.status, 1);
    assert.match(changed.stdout, /NEEDS  sample\.js/);
    assert.doesNotMatch(changed.stdout, /other\.js/);
    assert.equal(
      await fs.readFile(path.join(root, "sample.js"), "utf8"),
      "const changed=2",
    );

    const complete = runCli(["check"], root);
    assert.equal(complete.status, 1);
    assert.match(complete.stdout, /NEEDS  other\.js/);
  }).then((unavailable) => {
    if (unavailable) t.skip(unavailable);
  });
});

test("analyze --changed supports combined report options and filters findings", async (t) => {
  await withGitProject(async (root) => {
    assert.equal(runCli(["init"], root).status, 0);
    await fs.writeFile(
      path.join(root, "other.js"),
      "export {};\nconst otherUnused = 1;",
    );
    assert.equal(git(["add", ".cleanser.clns", "other.js"], root).status, 0);
    assert.equal(git(["commit", "-m", "add analyzer config"], root).status, 0);
    await fs.writeFile(
      path.join(root, "sample.js"),
      "export {};\nconst changedUnused = 1;",
    );

    const all = runCli(["report", "--format=json"], root);
    assert.equal(all.status, 1);
    const allFindings = JSON.parse(all.stdout);
    assert.ok(allFindings.some((finding) => finding.filePath === "other.js"));

    const changed = runCli(["report", "--format=json", "--changed"], root);
    assert.equal(changed.status, 1);
    const changedFindings = JSON.parse(changed.stdout);
    assert.ok(changedFindings.length > 0);
    assert.ok(
      changedFindings.every((finding) => finding.filePath === "sample.js"),
    );
  }).then((unavailable) => {
    if (unavailable) t.skip(unavailable);
  });
});
