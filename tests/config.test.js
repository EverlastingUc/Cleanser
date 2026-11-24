import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CONFIG_FILE,
  CONFIG_JSON_FILE,
  CONFIG_VERSION,
  DEFAULT_CONFIG,
  getConfigFile,
  loadConfig,
} from "../src/config.js";
import { resolveFileConfig } from "../src/cleaner.js";

async function withConfig(source, callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cleanser-config-"));
  try {
    await fs.writeFile(path.join(root, CONFIG_FILE), source);
    await callback(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("loads a minimal config and fills every safe default", async () => {
  await withConfig(
    "cleanser:\n  enabled: true\n  mode: safe\n",
    async (root) => {
      const config = await loadConfig(root);
      assert.equal(config.version, CONFIG_VERSION);
      assert.equal(config.enabled, true);
      assert.equal(config.trigger, "manual");
      assert.deepEqual(config.files, DEFAULT_CONFIG.files);
      assert.deepEqual(config.analysis, DEFAULT_CONFIG.analysis);
      assert.deepEqual(config.formatting, DEFAULT_CONFIG.formatting);
      assert.deepEqual(config.preservation, DEFAULT_CONFIG.preservation);
      assert.deepEqual(config.cleanup, DEFAULT_CONFIG.cleanup);
      assert.deepEqual(config.safety, DEFAULT_CONFIG.safety);
    },
  );
});

test("loads strict JSON configuration and reports the selected config file", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "cleanser-json-config-"),
  );
  try {
    await fs.writeFile(
      path.join(root, CONFIG_JSON_FILE),
      JSON.stringify(
        {
          cleanser: {
            version: CONFIG_VERSION,
            enabled: true,
            formatting: { indentation: 4 },
          },
        },
        null,
        2,
      ),
    );

    const config = await loadConfig(root);
    assert.equal(config.formatting.indentation, 4);
    assert.deepEqual(config.files, DEFAULT_CONFIG.files);
    assert.equal(await getConfigFile(root), CONFIG_JSON_FILE);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("rejects ambiguous and malformed JSON configuration", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "cleanser-json-config-"),
  );
  try {
    await fs.writeFile(
      path.join(root, CONFIG_FILE),
      "cleanser:\n  enabled: true\n",
    );
    await fs.writeFile(
      path.join(root, CONFIG_JSON_FILE),
      '{"cleanser":{"enabled":true}}',
    );
    await assert.rejects(loadConfig(root), /keep only one Cleanser config/);

    await fs.rm(path.join(root, CONFIG_FILE));
    await fs.writeFile(
      path.join(root, CONFIG_JSON_FILE),
      '{"cleanser":{"enabled":true,"enabled":false}}',
    );
    await assert.rejects(loadConfig(root), /Invalid JSON in .cleanser.json/);

    await fs.writeFile(path.join(root, CONFIG_JSON_FILE), "cleanser: true");
    await assert.rejects(loadConfig(root), /Invalid JSON in .cleanser.json/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("inherits shared configuration and applies file-pattern overrides", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cleanser-inherit-"));
  try {
    await fs.writeFile(
      path.join(root, ".cleanser.base.clns"),
      [
        "cleanser:",
        "  version: 1",
        "  enabled: true",
        "  analysis:",
        "    rules:",
        "      unused-constant: off",
        "  formatting:",
        "    quote_style: single",
      ].join("\n"),
    );
    await fs.writeFile(
      path.join(root, CONFIG_FILE),
      [
        "cleanser:",
        "  extends: .cleanser.base.clns",
        "  overrides:",
        '    - files: ["src/**/*.js"]',
        "      formatting:",
        "        indentation: 4",
        "      rules:",
        "        unused-variable: error",
      ].join("\n"),
    );

    const config = await loadConfig(root);
    assert.equal(config.formatting.quote_style, "single");
    assert.equal(config.analysis.rules["unused-constant"], "off");
    assert.equal(config.overrides.length, 1);

    const nested = resolveFileConfig(config, "src/components/app.js");
    assert.equal(nested.formatting.quote_style, "single");
    assert.equal(nested.formatting.indentation, 4);
    assert.equal(nested.analysis.rules["unused-variable"], "error");
    assert.equal(
      resolveFileConfig(config, "tests/app.js").formatting.indentation,
      DEFAULT_CONFIG.formatting.indentation,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("rejects unsafe, circular, and invalid configuration inheritance", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cleanser-inherit-"));
  try {
    await fs.writeFile(
      path.join(root, CONFIG_FILE),
      "cleanser:\n  extends: ../outside.clns\n",
    );
    await assert.rejects(loadConfig(root), /must be a relative config path/);

    await fs.writeFile(
      path.join(root, ".cleanser.a.clns"),
      "cleanser:\n  extends: .cleanser.b.clns\n",
    );
    await fs.writeFile(
      path.join(root, ".cleanser.b.clns"),
      "cleanser:\n  extends: .cleanser.a.clns\n",
    );
    await fs.writeFile(
      path.join(root, CONFIG_FILE),
      "cleanser:\n  extends: .cleanser.a.clns\n",
    );
    await assert.rejects(loadConfig(root), /inheritance cycle detected/);

    await fs.writeFile(
      path.join(root, CONFIG_FILE),
      [
        "cleanser:",
        "  overrides:",
        '    - files: ["../outside/**/*.js"]',
        "      rules:",
        "        not-a-rule: warning",
      ].join("\n"),
    );
    await assert.rejects(
      loadConfig(root),
      /must contain relative glob patterns/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("freezes defaults and isolates arrays between loaded configurations", async () => {
  assert.equal(Object.isFrozen(DEFAULT_CONFIG), true);
  assert.equal(Object.isFrozen(DEFAULT_CONFIG.files), true);
  assert.equal(Object.isFrozen(DEFAULT_CONFIG.files.include), true);
  assert.equal(Object.isFrozen(DEFAULT_CONFIG.formatting), true);

  await withConfig("cleanser:\n  enabled: true\n", async (root) => {
    const first = await loadConfig(root);
    const second = await loadConfig(root);

    assert.notEqual(first.files.include, second.files.include);
    assert.notEqual(first.files.include, DEFAULT_CONFIG.files.include);
    first.files.include.push("custom/**/*.js");

    assert.equal(second.files.include.includes("custom/**/*.js"), false);
    assert.equal(
      DEFAULT_CONFIG.files.include.includes("custom/**/*.js"),
      false,
    );
  });
});

test("loads the complete project configuration", async () => {
  await withConfig(
    `cleanser:
  version: 1
  enabled: true
  mode: safe
  trigger: onSave
  files:
    include: ["src/**/*.js"]
    exclude: ["src/vendor/**"]
  formatting:
    indentation: 4
    quote_style: single
    semicolons: never
    normalize_line_endings: crlf
`,
    async (root) => {
      const config = await loadConfig(root);
      assert.equal(config.trigger, "onSave");
      assert.deepEqual(config.files.include, ["src/**/*.js"]);
      assert.deepEqual(config.files.exclude, ["src/vendor/**"]);
      assert.equal(config.formatting.indentation, 4);
      assert.equal(config.formatting.quote_style, "single");
      assert.equal(config.formatting.semicolons, "never");
      assert.equal(config.formatting.normalize_line_endings, "crlf");
    },
  );
});

test("rejects unsupported config versions", async () => {
  await withConfig("cleanser:\n  version: 99\n", async (root) => {
    await assert.rejects(loadConfig(root), /supports version 1/);
  });
});

test("rejects unsupported indentation values", async () => {
  await withConfig(
    "cleanser:\n  formatting:\n    indentation: 99\n",
    async (root) => {
      await assert.rejects(loadConfig(root), /indentation.*1 to 8/);
    },
  );
});

test("rejects malformed configuration sections", async () => {
  await withConfig("cleanser:\n  files: invalid\n", async (root) => {
    await assert.rejects(
      loadConfig(root),
      /cleanser.files.*configuration object/,
    );
  });
});

test("rejects an unknown activation trigger", async () => {
  await withConfig("cleanser:\n  trigger: whenever\n", async (root) => {
    await assert.rejects(loadConfig(root), /trigger.*manual.*onSave/);
  });
});

test("validates per-rule severity and enable settings", async () => {
  await withConfig(
    "cleanser:\n  analysis:\n    rules:\n      unused-variable: off\n      private-key: error\n",
    async (root) => {
      const config = await loadConfig(root);
      assert.deepEqual(config.analysis.rules, {
        "unused-variable": "off",
        "private-key": "error",
      });
    },
  );

  await withConfig(
    "cleanser:\n  analysis:\n    rules:\n      not-a-rule: warning\n",
    async (root) => {
      await assert.rejects(loadConfig(root), /Unknown analysis rule/);
    },
  );
  await withConfig(
    "cleanser:\n  analysis:\n    rules:\n      unused-variable: urgent\n",
    async (root) => {
      await assert.rejects(
        loadConfig(root),
        /must be off, info, warning, or error/,
      );
    },
  );
});

test("resolves built-in analysis presets before applying per-rule overrides", async () => {
  await withConfig(
    "cleanser:\n  analysis:\n    preset: security\n",
    async (root) => {
      const config = await loadConfig(root);
      assert.equal(config.analysis.rules["unused-variable"], "off");
      assert.equal(config.analysis.rules["unsafe-eval"], undefined);
      assert.equal(config.analysis.rules["syntax-error"], undefined);
    },
  );

  await withConfig(
    "cleanser:\n  analysis:\n    preset: strict\n    rules:\n      redundant-return: info\n",
    async (root) => {
      const config = await loadConfig(root);
      assert.equal(config.analysis.rules["redundant-return"], "info");
      assert.equal(config.analysis.rules["empty-function"], "warning");
    },
  );

  await withConfig(
    "cleanser:\n  analysis:\n    preset: aggressive\n",
    async (root) => {
      await assert.rejects(
        loadConfig(root),
        /must be "recommended", "strict", or "security"/,
      );
    },
  );
});

test("rejects misspelled root and nested options", async () => {
  await withConfig("cleanser:\n  enabeld: true\n", async (root) => {
    await assert.rejects(loadConfig(root), /Unknown option.*enabeld/);
  });
  await withConfig(
    "cleanser:\n  formatting:\n    indentaion: 2\n",
    async (root) => {
      await assert.rejects(loadConfig(root), /Unknown option.*indentaion/);
    },
  );
});

test("rejects duplicate YAML keys", async () => {
  await withConfig(
    "cleanser:\n  enabled: true\n  enabled: false\n",
    async (root) => {
      await assert.rejects(loadConfig(root), /Invalid YAML/);
    },
  );
});

test("rejects path traversal and empty include patterns", async () => {
  await withConfig(
    'cleanser:\n  files:\n    include: ["../outside/**/*.js"]\n',
    async (root) => {
      await assert.rejects(loadConfig(root), /stay inside the project/);
    },
  );
  await withConfig('cleanser:\n  files:\n    include: [""]\n', async (root) => {
    await assert.rejects(loadConfig(root), /non-empty glob patterns/);
  });
});

test("preservation is locked and cleanup operations remain disabled", async () => {
  await withConfig(
    "cleanser:\n  preservation:\n    variable_names: rename\n",
    async (root) => {
      await assert.rejects(loadConfig(root), /locked to.*preserve/);
    },
  );
  await withConfig(
    "cleanser:\n  cleanup:\n    remove_dead_code: true\n",
    async (root) => {
      await assert.rejects(loadConfig(root), /not available.*keep it false/);
    },
  );
});

test("mandatory safety guarantees cannot be disabled", async () => {
  await withConfig(
    "cleanser:\n  safety:\n    never_overwrite_on_error: false\n",
    async (root) => {
      await assert.rejects(loadConfig(root), /mandatory safety guarantee/);
    },
  );
});

test("validates configurable protected paths and change limits", async () => {
  await withConfig(
    'cleanser:\n  safety:\n    protected_paths: ["generated/**"]\n    maximum_changed_files: 12\n    maximum_change_bytes: 4096\n',
    async (root) => {
      const config = await loadConfig(root);
      assert.deepEqual(config.safety.protected_paths, ["generated/**"]);
      assert.equal(config.safety.maximum_changed_files, 12);
      assert.equal(config.safety.maximum_change_bytes, 4096);
    },
  );
  await withConfig(
    'cleanser:\n  safety:\n    protected_paths: ["../outside/**"]\n',
    async (root) => {
      await assert.rejects(loadConfig(root), /stay inside the project/);
    },
  );
  await withConfig(
    "cleanser:\n  safety:\n    maximum_changed_files: -1\n",
    async (root) => {
      await assert.rejects(loadConfig(root), /non-negative safe integer/);
    },
  );
});

test("disabled configuration fails with an actionable message", async () => {
  await withConfig("cleanser:\n  enabled: false\n", async (root) => {
    await assert.rejects(loadConfig(root), /Set.*enabled: true/);
  });
});

test("reports missing config clearly", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "cleanser-config-missing-"),
  );
  try {
    await assert.rejects(loadConfig(root), /Missing .cleanser.clns/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
