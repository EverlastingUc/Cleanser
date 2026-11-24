import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const MAX_BUFFER = 16 * 1024 * 1024;
const SAFE_REVISION = /^[A-Za-z0-9][A-Za-z0-9._/-]*(?:[~^][0-9]*)?$/;
const splitGitPaths = (output) => output.split("\0").filter(Boolean);

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function safeProjectPath(root, value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("A project-relative file path is required.");
  }
  const normalizedInput = value.replace(/[\\/]/g, path.sep);
  const absolute = path.resolve(root, normalizedInput);
  const relative = path.relative(path.resolve(root), absolute);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Git file paths must stay inside the project directory.");
  }
  return relative.split(path.sep).join("/");
}

function parsePorcelainPaths(output) {
  const records = output.split("\0").filter(Boolean);
  const paths = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    const status = record.slice(0, 2);
    const filePath = record.slice(3).replaceAll("\\", "/");
    if (filePath) paths.push(filePath);
    if (/[RC]/.test(status) && records[index + 1]) {
      paths.push(records[++index].replaceAll("\\", "/"));
    }
  }
  return paths;
}

async function runGit(root, args) {
  try {
    const { stdout } = await executeFile(
      "git",
      ["--no-pager", "-C", path.resolve(root), ...args],
      {
        encoding: "utf8",
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        env: { ...process.env, GIT_PAGER: "cat", PAGER: "cat" },
      },
    );
    return stdout;
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error("Git is required for this command but was not found.", {
        cause: error,
      });
    }
    const detail = error.stderr?.trim();
    throw new Error(
      detail || `Git command failed with exit code ${error.code ?? "unknown"}.`,
      { cause: error },
    );
  }
}

export async function assertCleanGitWorkingTree({ root = process.cwd() } = {}) {
  const output = await runGit(root, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  if (output.length > 0) {
    throw new Error(
      "A dedicated Cleanser commit requires a clean Git working tree before formatting.",
    );
  }
}

export async function commitCleanFiles({
  root = process.cwd(),
  files,
  message = "chore: apply Cleanser formatting",
} = {}) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new TypeError("At least one cleaned file is required for a commit.");
  }
  if (
    typeof message !== "string" ||
    message.trim() === "" ||
    message.length > 200 ||
    /[\r\n\0]/u.test(message)
  ) {
    throw new TypeError(
      "A one-line cleanup commit message of 1 to 200 characters is required.",
    );
  }
  const filePaths = [
    ...new Set(files.map((filePath) => safeProjectPath(root, filePath))),
  ].sort();
  const tracked = await runGit(root, [
    "ls-files",
    "--error-unmatch",
    "--",
    ...filePaths,
  ]);
  const trackedPaths = new Set(
    tracked
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((filePath) => filePath.replaceAll("\\", "/")),
  );
  if (filePaths.some((filePath) => !trackedPaths.has(filePath))) {
    throw new Error("Cleanup commits can include tracked files only.");
  }

  const status = await runGit(root, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  const dirtyPaths = parsePorcelainPaths(status);
  const unexpected = dirtyPaths.filter(
    (filePath) =>
      !filePaths.includes(filePath) &&
      filePath !== ".cleanser-backups" &&
      !filePath.startsWith(".cleanser-backups/"),
  );
  if (unexpected.length > 0) {
    throw new Error(
      `Refusing to commit because other Git paths changed during formatting: ${unexpected.slice(0, 5).join(", ")}.`,
    );
  }
  const dirtySet = new Set(dirtyPaths);
  const missing = filePaths.filter((filePath) => !dirtySet.has(filePath));
  if (missing.length > 0) {
    throw new Error(
      `Refusing to commit because these cleaned files are no longer modified: ${missing.slice(0, 5).join(", ")}.`,
    );
  }

  await runGit(root, [
    "commit",
    "--only",
    "-m",
    message.trim(),
    "--",
    ...filePaths,
  ]);
  const commit = await runGit(root, ["rev-parse", "--short", "HEAD"]);
  return { files: filePaths, commit: commit.trim(), message: message.trim() };
}

export async function getGitHooksDirectory({ root = process.cwd() } = {}) {
  const gitPath = await runGit(root, ["rev-parse", "--git-path", "hooks"]);
  return path.resolve(root, gitPath.trim());
}

export async function listChangedFiles({
  root = process.cwd(),
  staged = false,
} = {}) {
  if (typeof staged !== "boolean") {
    throw new TypeError('The "staged" option must be a boolean.');
  }
  if (staged) {
    const output = await runGit(root, [
      "diff",
      "--cached",
      "--name-only",
      "--relative",
      "-z",
      "--",
    ]);
    return splitGitPaths(output).sort();
  }

  const outputs = await Promise.all([
    runGit(root, ["diff", "--name-only", "--relative", "-z", "--"]),
    runGit(root, ["diff", "--cached", "--name-only", "--relative", "-z", "--"]),
    runGit(root, ["ls-files", "--others", "--exclude-standard", "-z", "--"]),
  ]);
  return [...new Set(outputs.flatMap(splitGitPaths))].sort();
}

export async function listFilesComparedWith({
  root = process.cwd(),
  base,
} = {}) {
  if (typeof base !== "string" || !SAFE_REVISION.test(base)) {
    throw new Error(
      "Base revision must be a simple branch name, commit hash, or HEAD~N reference.",
    );
  }
  const output = await runGit(root, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--name-only",
    "-z",
    `${base}...HEAD`,
    "--",
  ]);
  return [
    ...new Set(
      splitGitPaths(output).map((filePath) => safeProjectPath(root, filePath)),
    ),
  ].sort(compareText);
}

export async function assertCleanWorkingTree({ root = process.cwd() } = {}) {
  const status = await runGit(root, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (status.trim().length > 0) {
    const changedCount = status.trimEnd().split(/\r?\n/u).length;
    throw new Error(
      `Working-tree protection stopped formatting because Git reports ${changedCount} changed or untracked path(s). Commit, stash, or use --allow-dirty to continue.`,
    );
  }
}

export async function inspectGit({ root = process.cwd(), action, value } = {}) {
  if (typeof action !== "string") {
    throw new TypeError("A Git inspection action is required.");
  }

  if (action === "status") {
    const output = await runGit(root, [
      "status",
      "--short",
      "--branch",
      "--untracked-files=all",
    ]);
    return output.trimEnd() || "Working tree is clean.";
  }

  if (action === "changed") {
    const unique = await listChangedFiles({
      root,
      staged: value === "--staged",
    });
    return unique.length > 0 ? unique.join("\n") : "No changed files.";
  }

  if (action === "diff") {
    const output = await runGit(root, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--",
    ]);
    return output || "No unstaged changes.";
  }

  if (action === "lines") {
    const diffArguments = [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--no-renames",
      "--unified=0",
      ...(value === "--staged" ? ["--cached"] : []),
      "--",
    ];
    const diff = await runGit(root, diffArguments);
    const changedLines = [];
    let filePath;
    for (const line of diff.split(/\r?\n/)) {
      if (line.startsWith("+++ ")) {
        filePath = line.startsWith("+++ b/")
          ? line.slice("+++ b/".length)
          : undefined;
        continue;
      }
      const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      if (!hunk || !filePath || filePath === "/dev/null") continue;
      changedLines.push({
        filePath,
        line: Number(hunk[1]),
        count: hunk[2] === undefined ? 1 : Number(hunk[2]),
      });
    }
    return changedLines.length > 0
      ? changedLines
          .map(
            ({ filePath: changedPath, line, count }) =>
              `${changedPath}:${line} (${count} changed line${count === 1 ? "" : "s"})`,
          )
          .join("\n")
      : "No changed lines.";
  }

  if (action === "conflicts") {
    const output = await runGit(root, [
      "diff",
      "--name-only",
      "--diff-filter=U",
      "--",
    ]);
    return output.trimEnd() || "No unresolved Git conflicts.";
  }

  if (action === "compare") {
    if (typeof value !== "string" || !SAFE_REVISION.test(value)) {
      throw new Error(
        "Branch or revision must be a simple name, commit hash, or HEAD~N reference.",
      );
    }
    const output = await runGit(root, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      `${value}...HEAD`,
      "--",
    ]);
    return output || `No changes between ${value} and HEAD.`;
  }

  if (action === "history" || action === "blame") {
    if (typeof value !== "string") {
      throw new Error(`Usage: cleanser git ${action} <file>`);
    }
    const filePath = safeProjectPath(root, value);
    if (action === "history") {
      const output = await runGit(root, [
        "log",
        "-n",
        "20",
        "--date=short",
        "--format=%h%x09%ad%x09%s",
        "--",
        filePath,
      ]);
      return output || `No tracked history for ${filePath}.`;
    }
    const output = await runGit(root, [
      "blame",
      "--date=short",
      "--",
      filePath,
    ]);
    return output || `No blame information for ${filePath}.`;
  }

  throw new Error(`Unknown Git action: ${action}.`);
}
