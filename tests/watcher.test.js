import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CONFIG_JSON_FILE, DEFAULT_CONFIG, loadConfig } from "../src/config.js";
import { startWatcher } from "../src/watcher.js";

async function withProject(callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cleanser-watch-"));
  try {
    await callback(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function waitForEvent(events, expectedType) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out waiting for ${expectedType}.`)),
      15000,
    );
    events.onEvent = (event) => {
      events.values.push(event);
      if (event.type === "error") {
        clearTimeout(timeout);
        reject(new Error(event.message));
      } else if (event.type === expectedType) {
        clearTimeout(timeout);
        resolve(event);
      }
    };
  });
}

test("watcher formats changed files safely and supports read-only check mode", async (t) => {
  await withProject(async (root) => {
    const events = { values: [], onEvent: () => {} };
    let watcher;
    try {
      watcher = startWatcher({
        root,
        config: DEFAULT_CONFIG,
        pollIntervalMs: 100,
        onEvent: (event) => events.onEvent(event),
      });
    } catch (error) {
      if (error.code === "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM") {
        t.skip(
          "Recursive filesystem watching is unavailable on this platform.",
        );
        return;
      }
      throw error;
    }

    const checkWatchers = new Set();
    try {
      const ready = waitForEvent(events, "ready");
      await ready;
      const formattedEvent = waitForEvent(events, "formatted");
      const file = path.join(root, "sample.js");
      await fs.writeFile(file, "const value=1");
      assert.equal((await formattedEvent).filePath, "sample.js");
      assert.notEqual(await fs.readFile(file, "utf8"), "const value=1");
      watcher.close();
      await watcher.closed;

      const checkEvents = { values: [], onEvent: () => {} };
      const checkWatcher = startWatcher({
        root,
        config: DEFAULT_CONFIG,
        checkOnly: true,
        pollIntervalMs: 100,
        onEvent: (event) => checkEvents.onEvent(event),
      });
      checkWatchers.add(checkWatcher);
      await waitForEvent(checkEvents, "ready");
      const needsFormattingEvent = waitForEvent(
        checkEvents,
        "needs-formatting",
      );
      await fs.writeFile(file, "const nextValue=2");
      assert.equal((await needsFormattingEvent).filePath, "sample.js");
      assert.equal(await fs.readFile(file, "utf8"), "const nextValue=2");
      checkWatcher.close();
      await checkWatcher.closed;
      checkWatchers.delete(checkWatcher);
    } finally {
      watcher.close();
      await watcher.closed;
      for (const checkWatcher of checkWatchers) {
        checkWatcher.close();
        await checkWatcher.closed;
      }
    }
  });
});

test("watcher loads and monitors a JSON project config", async () => {
  await withProject(async (root) => {
    await fs.writeFile(
      path.join(root, CONFIG_JSON_FILE),
      JSON.stringify({
        cleanser: { version: 1, enabled: true, formatting: { indentation: 4 } },
      }),
    );
    const events = { values: [], onEvent: () => {} };
    const watcher = startWatcher({
      root,
      config: await loadConfig(root),
      pollIntervalMs: 100,
      onEvent: (event) => events.onEvent(event),
    });

    try {
      await waitForEvent(events, "ready");
      assert.equal(
        events.values.some((event) => event.type === "error"),
        false,
      );
      const reloaded = waitForEvent(events, "config-reloaded");
      await fs.writeFile(
        path.join(root, ".editorconfig"),
        "root = true\n[*]\nindent_size = 4\n",
      );
      assert.equal((await reloaded).configFile, ".editorconfig");
    } finally {
      watcher.close();
      await watcher.closed;
    }
  });
});

test("closing the watcher aborts and awaits an active write rollback", async (t) => {
  await withProject(async (root) => {
    const events = { values: [], onEvent: () => {} };
    let watcher;
    try {
      watcher = startWatcher({
        root,
        config: DEFAULT_CONFIG,
        pollIntervalMs: 50,
        onEvent: (event) => events.onEvent(event),
      });
    } catch (error) {
      if (error.code === "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM") {
        t.skip(
          "Recursive filesystem watching is unavailable on this platform.",
        );
        return;
      }
      throw error;
    }

    const file = path.join(root, "cancel.js");
    const original = "const value=1";
    const originalRename = fs.rename;
    try {
      await waitForEvent(events, "ready");
      fs.rename = async (source, target) => {
        const result = await originalRename(source, target);
        if (target === file) watcher.close();
        return result;
      };
      await fs.writeFile(file, original);

      let timeout;
      await Promise.race([
        watcher.closed,
        new Promise((_, reject) => {
          timeout = setTimeout(
            () =>
              reject(new Error("Timed out waiting for the watcher to stop.")),
            15_000,
          );
        }),
      ]);
      clearTimeout(timeout);

      assert.equal(await fs.readFile(file, "utf8"), original);
      assert.equal(
        await fs.readFile(
          path.join(root, ".cleanser-backups", "cancel.js"),
          "utf8",
        ),
        original,
      );
      await assert.rejects(fs.access(path.join(root, ".cleanser.lock")));
    } finally {
      fs.rename = originalRename;
      watcher.close();
      await watcher.closed;
    }
  });
});
