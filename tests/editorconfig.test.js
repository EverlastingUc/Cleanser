import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { previewProject } from "../src/cleaner.js";
import {
  loadEditorConfigs,
  parseEditorConfig,
  resolveEditorConfig,
  resolveEditorConfigs,
} from "../src/editorconfig.js";

test("parses EditorConfig sections, globs, braces, and unset values", () => {
  const config = parseEditorConfig(
    [
      "root = true",
      "indent_style = space",
      "indent_size = 4",
      "end_of_line = lf",
      "[*.{js,ts}]",
      "indent_size = 2",
      "[src/**/test?.js]",
      "indent_size = unset",
    ].join("\n"),
  );

  assert.deepEqual(resolveEditorConfig(config, "app.js").formatting, {
    use_tabs: false,
    indentation: 2,
    normalize_line_endings: "lf",
  });
  assert.equal(
    resolveEditorConfig(config, "src/deep/test1.js").formatting.indentation,
    undefined,
  );
  assert.equal(
    resolveEditorConfig(config, "app.json").formatting.indentation,
    4,
  );
});

test("validates EditorConfig values and section syntax", () => {
  assert.throws(
    () => parseEditorConfig("indent_style = tabs"),
    /Invalid EditorConfig value/,
  );
  assert.throws(
    () => parseEditorConfig("[*.js]\nroot = true"),
    /only before sections/,
  );
  assert.throws(
    () => parseEditorConfig("[ ]\nindent_size = 2"),
    /section.*empty/,
  );
  assert.throws(
    () => parseEditorConfig("[file[z-a].js]"),
    /Invalid EditorConfig section/,
  );
});

test("cascades parent EditorConfig settings until a root boundary", async () => {
  const base = await fs.mkdtemp(
    path.join(os.tmpdir(), "cleanser-editorconfig-"),
  );
  const project = path.join(base, "project");
  try {
    await fs.mkdir(project);
    await fs.writeFile(
      path.join(base, ".editorconfig"),
      "[*]\nindent_size = 4\nend_of_line = crlf\n",
    );
    await fs.writeFile(
      path.join(project, ".editorconfig"),
      "[*.js]\nindent_size = 2\n",
    );

    let configs = await loadEditorConfigs(project);
    let formatting = resolveEditorConfigs(configs, project, "app.js");
    assert.equal(formatting.formatting.indentation, 2);
    assert.equal(formatting.formatting.normalize_line_endings, "crlf");

    await fs.writeFile(
      path.join(project, ".editorconfig"),
      "root = true\n[*.js]\nindent_size = 2\n",
    );
    configs = await loadEditorConfigs(project);
    formatting = resolveEditorConfigs(configs, project, "app.js");
    assert.equal(formatting.formatting.indentation, 2);
    assert.equal(formatting.formatting.normalize_line_endings, undefined);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("project formatting honors EditorConfig settings and scoped sections", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "cleanser-editorconfig-"),
  );
  try {
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".cleanser.clns"),
      "cleanser:\n  version: 1\n  enabled: true\n",
    );
    await fs.writeFile(
      path.join(root, ".editorconfig"),
      [
        "root = true",
        "[*]",
        "indent_style = space",
        "indent_size = 4",
        "end_of_line = lf",
        "insert_final_newline = false",
        "max_line_length = 60",
        "trim_trailing_whitespace = true",
        "[src/**/*.js]",
        "indent_style = tab",
        "tab_width = 3",
        "indent_size = tab",
      ].join("\n"),
    );
    await fs.writeFile(
      path.join(root, "src", "app.js"),
      "function greet(){\nreturn 1\n}\n",
    );
    await fs.writeFile(
      path.join(root, "src", "template.js"),
      "const value=`kept `;\n",
    );

    const config = await loadConfig(root);
    const results = await previewProject({ root, config });
    const result = results.find((item) => item.filePath === "src/app.js");
    const templateResult = results.find(
      (item) => item.filePath === "src/template.js",
    );
    assert.equal(result.status, "changed");
    assert.match(result.diff, /^\+\treturn 1;$/m);
    assert.doesNotMatch(result.diff, /\r/);
    assert.doesNotMatch(result.diff, /^\+\s*$/m);
    assert.match(templateResult.diff, /^\+const value = `kept `;$/m);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
