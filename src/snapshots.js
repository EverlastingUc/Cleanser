import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  collectProjectFiles,
  formatSource,
  writeAtomically,
} from "./cleaner.js";

export const SNAPSHOT_FILE = ".cleanser-snapshot.json";
const SNAPSHOT_FORMAT = "cleanser-format-snapshot";
const SNAPSHOT_VERSION = 1;

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hashSource(source) {
  return `sha256:${createHash("sha256").update(source, "utf8").digest("hex")}`;
}

function validateSnapshot(snapshot) {
  if (
    !snapshot ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot) ||
    snapshot.format !== SNAPSHOT_FORMAT ||
    snapshot.version !== SNAPSHOT_VERSION ||
    !snapshot.files ||
    typeof snapshot.files !== "object" ||
    Array.isArray(snapshot.files)
  ) {
    throw new Error(
      `Invalid ${SNAPSHOT_FILE}: expected a Cleanser format snapshot version ${SNAPSHOT_VERSION}.`,
    );
  }
  for (const [filePath, digest] of Object.entries(snapshot.files)) {
    if (
      filePath.length === 0 ||
      path.posix.isAbsolute(filePath) ||
      filePath.includes("\\") ||
      filePath
        .split("/")
        .some((segment) => segment === ".." || segment === "") ||
      !/^sha256:[a-f\d]{64}$/.test(digest)
    ) {
      throw new Error(`Invalid entry in ${SNAPSHOT_FILE}: ${filePath}.`);
    }
  }
  return snapshot;
}

async function readExistingSnapshot(snapshotPath) {
  try {
    const stats = await fs.lstat(snapshotPath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`${SNAPSHOT_FILE} must be a regular file.`);
    }
    const contents = await fs.readFile(snapshotPath, "utf8");
    let parsed;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      throw new Error(`Could not parse ${SNAPSHOT_FILE}: ${error.message}`);
    }
    return { snapshot: validateSnapshot(parsed), mode: stats.mode & 0o777 };
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function runFormatSnapshot({
  config,
  root = process.cwd(),
  update = false,
} = {}) {
  if (typeof update !== "boolean") {
    throw new TypeError("Snapshot update must be a boolean.");
  }
  const absoluteRoot = path.resolve(root);
  const snapshotPath = path.join(absoluteRoot, SNAPSHOT_FILE);
  const existing = await readExistingSnapshot(snapshotPath);
  const actualFiles = {};
  for (const absolutePath of await collectProjectFiles(absoluteRoot, config)) {
    const filePath = path
      .relative(absoluteRoot, absolutePath)
      .split(path.sep)
      .join("/");
    const source = await fs.readFile(absolutePath, "utf8");
    actualFiles[filePath] = hashSource(
      await formatSource(source, absolutePath, config),
    );
  }
  const sortedFiles = Object.fromEntries(
    Object.entries(actualFiles).sort(([left], [right]) =>
      compareText(left, right),
    ),
  );
  const snapshot = {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    files: sortedFiles,
  };

  if (update) {
    await writeAtomically(
      snapshotPath,
      `${JSON.stringify(snapshot, null, 2)}\n`,
      existing?.mode ?? 0o600,
    );
    return {
      status: "updated",
      snapshotFile: SNAPSHOT_FILE,
      summary: { files: Object.keys(sortedFiles).length, differences: 0 },
      differences: [],
    };
  }

  if (!existing) {
    return {
      status: "missing",
      snapshotFile: SNAPSHOT_FILE,
      summary: { files: Object.keys(sortedFiles).length, differences: 0 },
      differences: [],
    };
  }

  const expectedFiles = existing.snapshot.files;
  const filePaths = [
    ...new Set([...Object.keys(expectedFiles), ...Object.keys(sortedFiles)]),
  ].sort(compareText);
  const differences = filePaths.flatMap((filePath) => {
    if (!Object.hasOwn(expectedFiles, filePath)) {
      return [{ filePath, status: "added" }];
    }
    if (!Object.hasOwn(sortedFiles, filePath)) {
      return [{ filePath, status: "removed" }];
    }
    return expectedFiles[filePath] === sortedFiles[filePath]
      ? []
      : [{ filePath, status: "changed" }];
  });

  return {
    status: differences.length === 0 ? "matched" : "mismatch",
    snapshotFile: SNAPSHOT_FILE,
    summary: {
      files: Object.keys(sortedFiles).length,
      differences: differences.length,
    },
    differences,
  };
}
