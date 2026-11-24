import fs from "node:fs/promises";
import path from "node:path";
import { getGitHooksDirectory } from "./git-tools.js";

const MANAGED_MARKER = "# cleanser-managed-hook:v1";
const HOOK_COMMANDS = Object.freeze({
  "pre-commit": "check --changed",
  "pre-push": "check",
});

function hookSource(name) {
  const command = HOOK_COMMANDS[name];
  return [
    "#!/bin/sh",
    MANAGED_MARKER,
    "if command -v cleanser >/dev/null 2>&1; then",
    `  exec cleanser ${command}`,
    "fi",
    'if [ -x "./node_modules/.bin/cleanser" ]; then',
    `  exec "./node_modules/.bin/cleanser" ${command}`,
    "fi",
    "echo 'Cleanser is not on PATH and no local executable was found.' >&2",
    "exit 127",
    "",
  ].join("\n");
}

export async function manageGitHook({
  root = process.cwd(),
  action,
  name,
} = {}) {
  if (!Object.hasOwn(HOOK_COMMANDS, name)) {
    throw new Error('Hook name must be "pre-commit" or "pre-push".');
  }
  if (action !== "install" && action !== "uninstall") {
    throw new Error('Hook action must be "install" or "uninstall".');
  }

  const hooksDirectory = await getGitHooksDirectory({ root });
  await fs.mkdir(hooksDirectory, { recursive: true });
  const hookPath = path.join(hooksDirectory, name);

  if (action === "install") {
    let handle;
    try {
      handle = await fs.open(hookPath, "wx", 0o755);
    } catch (error) {
      if (error.code === "EEXIST") {
        throw new Error(
          `Git ${name} hook already exists; Cleanser left it unchanged.`,
        );
      }
      throw error;
    }
    try {
      await handle.writeFile(hookSource(name), "utf8");
      await handle.chmod(0o755);
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => {});
      await fs.rm(hookPath, { force: true }).catch(() => {});
      throw error;
    }
    await handle.close();
    return { action, name, status: "installed", hookPath };
  }

  let contents;
  try {
    const stats = await fs.lstat(hookPath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`Git ${name} hook is not a regular managed file.`);
    }
    contents = await fs.readFile(hookPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return { action, name, status: "absent", hookPath };
    }
    throw error;
  }
  if (!contents.startsWith(`#!/bin/sh\n${MANAGED_MARKER}\n`)) {
    throw new Error(`Git ${name} hook is not managed by Cleanser.`);
  }
  await fs.rm(hookPath);
  return { action, name, status: "uninstalled", hookPath };
}
