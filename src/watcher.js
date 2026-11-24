import fs from "node:fs/promises";
import path from "node:path";
import { CONFIG_FILE, getConfigFile, loadConfig } from "./config.js";
import { cleanProject, collectProjectFiles } from "./cleaner.js";

function emit(onEvent, event) {
  try {
    onEvent(event);
  } catch {
    // Observer errors must not stop project monitoring.
  }
}

async function fileStamp(filePath) {
  try {
    const stats = await fs.lstat(filePath);
    if (stats.isSymbolicLink() || !stats.isFile()) return "invalid";
    return `${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
  } catch (error) {
    if (error.code === "ENOENT") return "missing";
    throw error;
  }
}

function editorConfigPaths(root) {
  const paths = [];
  let current = path.resolve(root);
  for (;;) {
    paths.push(path.join(current, ".editorconfig"));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return paths;
}

export function startWatcher({
  root = process.cwd(),
  config,
  checkOnly = false,
  pollIntervalMs = 1000,
  onEvent = () => {},
} = {}) {
  if (!config || typeof config !== "object") {
    throw new TypeError("A Cleanser configuration object is required.");
  }
  if (typeof checkOnly !== "boolean") {
    throw new TypeError('The "checkOnly" option must be a boolean.');
  }
  if (
    !Number.isInteger(pollIntervalMs) ||
    pollIntervalMs < 50 ||
    pollIntervalMs > 60_000
  ) {
    throw new RangeError(
      '"pollIntervalMs" must be a whole number from 50 to 60000.',
    );
  }

  const absoluteRoot = path.resolve(root);
  let activeConfig = config;
  let disposed = false;
  let initialized = false;
  let configReady = true;
  let previousConfigFile;
  let previousConfigStamp;
  let previousEditorConfigStamps = new Map();
  let previousFiles = new Map();
  let pollTimer;
  let activePoll;
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  const controller = new AbortController();

  async function poll() {
    if (disposed) return;
    try {
      const firstPoll = !initialized;
      let currentConfigFile;
      try {
        currentConfigFile = await getConfigFile(absoluteRoot);
      } catch (error) {
        if (!error.message.startsWith(`Missing ${CONFIG_FILE}`)) throw error;
      }
      const currentConfigStamp = currentConfigFile
        ? await fileStamp(path.join(absoluteRoot, currentConfigFile))
        : "missing";
      const currentEditorConfigStamps = new Map();
      for (const editorConfigPath of editorConfigPaths(absoluteRoot)) {
        currentEditorConfigStamps.set(
          editorConfigPath,
          await fileStamp(editorConfigPath),
        );
      }
      const mainConfigChanged =
        currentConfigFile !== previousConfigFile ||
        currentConfigStamp !== previousConfigStamp;
      const editorConfigChanged =
        Boolean(currentConfigFile) &&
        [...currentEditorConfigStamps].some(
          ([filePath, stamp]) =>
            previousEditorConfigStamps.get(filePath) !== stamp,
        );
      if (initialized && (mainConfigChanged || editorConfigChanged)) {
        try {
          activeConfig = await loadConfig(absoluteRoot);
          configReady = true;
          emit(onEvent, {
            type: "config-reloaded",
            configFile: mainConfigChanged ? currentConfigFile : ".editorconfig",
          });
        } catch (error) {
          configReady = false;
          emit(onEvent, { type: "error", message: error.message });
        }
      }

      const files = await collectProjectFiles(absoluteRoot, activeConfig, {
        signal: controller.signal,
      });
      if (disposed) return;
      const currentFiles = new Map();
      for (const filePath of files) {
        const stamp = await fileStamp(filePath);
        if (stamp !== "missing" && stamp !== "invalid") {
          currentFiles.set(
            path.relative(absoluteRoot, filePath).split(path.sep).join("/"),
            stamp,
          );
        }
      }

      const changedFiles = initialized
        ? [...currentFiles]
            .filter(
              ([filePath, stamp]) => previousFiles.get(filePath) !== stamp,
            )
            .map(([filePath]) => filePath)
        : [];
      previousFiles = currentFiles;
      previousConfigFile = currentConfigFile;
      previousConfigStamp = currentConfigStamp;
      previousEditorConfigStamps = currentEditorConfigStamps;
      initialized = true;
      if (firstPoll) emit(onEvent, { type: "ready" });

      if (configReady && changedFiles.length > 0) {
        if (disposed) return;
        const results = await cleanProject({
          root: absoluteRoot,
          config: activeConfig,
          write: !checkOnly,
          changedFiles,
          signal: controller.signal,
        });
        if (!disposed) {
          for (const result of results) {
            if (
              result.status === "cleaned" ||
              result.status === "would-clean"
            ) {
              emit(onEvent, {
                type: checkOnly ? "needs-formatting" : "formatted",
                filePath: path
                  .relative(absoluteRoot, result.filePath)
                  .split(path.sep)
                  .join("/"),
              });
            } else if (result.status === "skipped") {
              emit(onEvent, {
                type: "skipped",
                filePath: path
                  .relative(absoluteRoot, result.filePath)
                  .split(path.sep)
                  .join("/"),
                message: result.reason.split("\n")[0],
              });
            }
          }
        }
      }
    } catch (error) {
      if (!disposed) emit(onEvent, { type: "error", message: error.message });
    } finally {
      if (!disposed) {
        pollTimer = setTimeout(() => {
          activePoll = poll();
        }, pollIntervalMs);
      }
    }
  }

  activePoll = poll();
  return {
    closed,
    close() {
      if (disposed) return;
      disposed = true;
      controller.abort();
      clearTimeout(pollTimer);
      if (activePoll) {
        void activePoll.then(resolveClosed, resolveClosed);
      } else {
        resolveClosed();
      }
    },
  };
}
