import fs from "node:fs/promises";
import path from "node:path";
import { withProjectWriteLock, writeAtomically } from "./cleaner.js";

const BACKUP_DIRECTORY = ".cleanser-backups";

function normalizeRelativePath(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("A project-relative file path is required.");
  }
  const normalized = value.replace(/\\/g, "/");
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split("/").some((segment) => segment === ".." || segment === "")
  ) {
    throw new Error("Backup paths must stay inside the project directory.");
  }
  return normalized;
}

async function assertRegularNonSymlink(filePath, label) {
  let stats;
  try {
    stats = await fs.lstat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`${label} does not exist: ${filePath}`);
    }
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`${label} must be a regular, non-symlink file.`);
  }
  return stats;
}

async function assertSafeDirectories(root, relativeDirectory) {
  let current = root;
  for (const segment of relativeDirectory.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stats;
    try {
      stats = await fs.lstat(current);
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new Error(`Backup directory does not exist: ${current}`);
      }
      throw error;
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error("Backup path contains a symlink or non-directory entry.");
    }
  }
}

export async function listBackups({ root = process.cwd() } = {}) {
  const absoluteRoot = path.resolve(root);
  const backupRoot = path.join(absoluteRoot, BACKUP_DIRECTORY);
  let rootStats;
  try {
    rootStats = await fs.lstat(backupRoot);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error("Backup root must be a regular, non-symlink directory.");
  }

  const backups = [];
  async function visit(directory, relativeDirectory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        backups.push(relativePath);
      }
    }
  }

  await visit(backupRoot, "");
  return backups;
}

async function restoreBackupOperation({ root = process.cwd(), filePath } = {}) {
  const absoluteRoot = path.resolve(root);
  const relativePath = normalizeRelativePath(filePath);
  const segments = relativePath.split("/");
  if (
    segments.includes(BACKUP_DIRECTORY) ||
    segments.includes(".git") ||
    segments.includes("node_modules")
  ) {
    throw new Error("This file path is reserved and cannot be restored.");
  }

  const targetPath = path.join(absoluteRoot, ...segments);
  const targetRelativeDirectory = path.dirname(targetPath);
  const relativeDirectory = path.relative(
    absoluteRoot,
    targetRelativeDirectory,
  );
  if (
    relativeDirectory === ".." ||
    relativeDirectory.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeDirectory)
  ) {
    throw new Error("Restore target must stay inside the project directory.");
  }
  await assertSafeDirectories(absoluteRoot, relativeDirectory);
  const targetStats = await assertRegularNonSymlink(
    targetPath,
    "Restore target",
  );

  const backupRoot = path.join(absoluteRoot, BACKUP_DIRECTORY);
  const backupRelativeDirectory = path.dirname(path.join(...segments));
  await assertSafeDirectories(absoluteRoot, BACKUP_DIRECTORY);
  if (backupRelativeDirectory !== ".") {
    await assertSafeDirectories(
      backupRoot,
      backupRelativeDirectory === "."
        ? ""
        : backupRelativeDirectory.split(path.sep).join(path.sep),
    );
  }
  const backupPath = path.join(backupRoot, ...segments);
  const backupStats = await assertRegularNonSymlink(
    backupPath,
    "Original backup",
  );
  const contents = await fs.readFile(backupPath, "utf8");
  await writeAtomically(targetPath, contents, targetStats.mode);

  return {
    filePath: relativePath,
    bytes: backupStats.size,
  };
}

export async function restoreBackup(options = {}) {
  const { root = process.cwd() } = options;
  return withProjectWriteLock(root, () => restoreBackupOperation(options));
}
