import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import {
  CONFIG_FILE,
  CONFIG_JSON_FILE,
  getConfigFile,
  loadConfig,
} from "./config.js";

export async function migrateConfigFormat({ root = process.cwd(), to } = {}) {
  if (to !== "clns" && to !== "json") {
    throw new Error('Target format must be "clns" or "json".');
  }
  const absoluteRoot = path.resolve(root);
  const targetName = to === "json" ? CONFIG_JSON_FILE : CONFIG_FILE;
  const targetPath = path.join(absoluteRoot, targetName);
  try {
    await fs.lstat(targetPath);
    throw new Error(
      `${targetName} already exists; Cleanser left it unchanged.`,
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  await loadConfig(absoluteRoot);
  const sourceName = await getConfigFile(absoluteRoot);
  if (sourceName === targetName) {
    throw new Error(`Configuration is already in ${to} format.`);
  }

  const sourcePath = path.join(absoluteRoot, sourceName);
  const sourceStats = await fs.stat(sourcePath);
  const sourceText = await fs.readFile(sourcePath, "utf8");
  let rawConfig;
  try {
    rawConfig = YAML.parse(sourceText, { uniqueKeys: true });
  } catch (error) {
    throw new Error(`Could not parse ${sourceName}: ${error.message}`, {
      cause: error,
    });
  }
  const targetText =
    to === "json"
      ? `${JSON.stringify(rawConfig, null, 2)}\n`
      : YAML.stringify(rawConfig);
  try {
    await fs.writeFile(targetPath, targetText, {
      encoding: "utf8",
      flag: "wx",
      mode: sourceStats.mode & 0o777,
    });
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(
        `${targetName} already exists; Cleanser left it unchanged.`,
      );
    }
    throw error;
  }

  const backupPath = path.join(
    absoluteRoot,
    `.cleanser-migration-${randomUUID()}.bak`,
  );
  let sourceMoved = false;
  try {
    await fs.rename(sourcePath, backupPath);
    sourceMoved = true;
    await loadConfig(absoluteRoot);
    await fs.rm(backupPath);
  } catch (error) {
    await fs.rm(targetPath, { force: true }).catch(() => {});
    if (sourceMoved) {
      try {
        await fs.rename(backupPath, sourcePath);
      } catch (restoreError) {
        throw new Error(
          `Configuration migration failed and rollback could not restore ${sourceName}; original data remains at ${path.basename(backupPath)}.`,
          { cause: restoreError },
        );
      }
    }
    throw error;
  }

  return { from: sourceName, to: targetName };
}
