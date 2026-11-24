import test from "node:test";
import assert from "node:assert/strict";
import {
  definePlugin,
  defineRule,
  getMissingPluginDependencies,
  runPlugin,
} from "cleanser/plugin-api";

test("public plugin API reports stable source-only custom findings", () => {
  const todoRule = defineRule({
    id: "no-todo",
    severity: "warning",
    description: "Flag TODO markers for review.",
    check(source) {
      const start = source.indexOf("TODO");
      return start < 0
        ? []
        : [{ start, end: start + 4, message: "Remove or track this TODO." }];
    },
  });
  const plugin = definePlugin({ name: "team-style", rules: [todoRule] });
  const source = "const value = 1;\n// TODO: review\n";
  const result = runPlugin(plugin, { source, filePath: "src/example.js" });

  assert.deepEqual(result, [
    {
      filePath: "src/example.js",
      ruleId: "custom/team-style/no-todo",
      severity: "warning",
      message: "Remove or track this TODO.",
      start: source.indexOf("TODO"),
      end: source.indexOf("TODO") + 4,
      line: 2,
      column: 4,
    },
  ]);
  assert.equal(Object.isFrozen(plugin), true);
  assert.equal(Object.isFrozen(plugin.rules), true);
});

test("public plugin API rejects invalid descriptors and findings", () => {
  assert.throws(
    () => defineRule({ id: "Bad Name", description: "bad", check: () => [] }),
    /Custom rule IDs/,
  );
  assert.throws(
    () => definePlugin({ name: "empty", rules: [] }),
    /at least one rule/,
  );

  const plugin = definePlugin({
    name: "bad-finding",
    rules: [
      defineRule({
        id: "broken",
        description: "Returns an invalid span.",
        check: () => [{ start: 4, end: 2, message: "invalid" }],
      }),
    ],
  });
  assert.throws(
    () => runPlugin(plugin, { source: "abc", filePath: "src/file.js" }),
    /returned an invalid finding/,
  );
});

test("plugin dependencies are checked across package manifest sections", () => {
  const rule = defineRule({
    id: "example",
    description: "Example rule",
    check: () => [],
  });
  const plugin = definePlugin({
    name: "dependency-check",
    rules: [rule],
    dependencies: ["prettier", "@types/node"],
  });
  assert.deepEqual(
    getMissingPluginDependencies(plugin, {
      devDependencies: { prettier: "^3.0.0" },
      peerDependencies: { "@types/node": "^22.0.0" },
    }),
    [],
  );
  assert.deepEqual(
    getMissingPluginDependencies(plugin, { dependencies: { prettier: "^3" } }),
    ["@types/node"],
  );
  assert.throws(
    () =>
      definePlugin({
        name: "duplicate-deps",
        rules: [rule],
        dependencies: ["react", "react"],
      }),
    /unique npm package names/,
  );
  assert.throws(
    () => getMissingPluginDependencies(plugin, { dependencies: [] }),
    /must be an object/,
  );
});
