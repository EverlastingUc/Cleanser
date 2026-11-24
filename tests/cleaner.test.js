import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  cleanProject,
  compareAstEquivalence,
  createUnifiedDiff,
  formatSource,
  isIncludedPath,
  matchesPattern,
  isSafeProjectFile,
  previewProject,
} from "../src/cleaner.js";

const config = {
  files: {
    include: [
      "**/*.js",
      "**/*.jsx",
      "**/*.ts",
      "**/*.tsx",
      "**/*.html",
      "**/*.css",
      "**/*.scss",
      "**/*.json",
      "**/*.jsonc",
      "**/*.yaml",
      "**/*.yml",
      "**/*.md",
      "**/*.vue",
      "**/*.toml",
      "**/*.xml",
      "**/*.svg",
      "**/*.sql",
      "**/*.svelte",
      "**/*.astro",
      "**/*.sh",
      "**/*.bash",
      "**/*.zsh",
      "**/*.ksh",
      "**/*.bats",
      "**/*.ps1",
      "**/*.psm1",
      "**/*.psd1",
      "**/*.java",
      "**/*.php",
    ],
    exclude: ["dist/**", "node_modules/**"],
  },
  formatting: {
    indentation: 2,
    normalize_line_endings: "preserve",
    quote_style: "double",
    semicolons: "always",
  },
  safety: {
    create_backup: true,
    skip_on_syntax_error: true,
  },
};

test("matches root and nested source files", () => {
  assert.equal(matchesPattern("index.js", "**/*.js"), true);
  assert.equal(matchesPattern("src/app.js", "**/*.js"), true);
  assert.equal(matchesPattern("src/app.ts", "**/*.js"), false);
});

test("normalizes Windows separators in paths and glob patterns", () => {
  assert.equal(
    matchesPattern("src\\components\\Button.tsx", "**\\*.tsx"),
    true,
  );
  assert.equal(matchesPattern(".\\src\\app.js", "src/**/*.js"), true);
});

test("supports glob wildcards without crossing directory boundaries", () => {
  assert.equal(matchesPattern("src/app.js", "src/*.js"), true);
  assert.equal(matchesPattern("src/nested/app.js", "src/*.js"), false);
  assert.equal(matchesPattern("src/nested/app.js", "src/**/*.js"), true);
  assert.equal(matchesPattern("src/app.jsx", "src/app.?sx"), true);
});

test("applies formatting overrides only to matching project files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cleanser-overrides-"));
  try {
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    const nested = path.join(root, "src", "nested.js");
    const topLevel = path.join(root, "index.js");
    await fs.writeFile(nested, 'const value = "nested";');
    await fs.writeFile(topLevel, 'const value = "root";');

    const result = await previewProject({
      root,
      config: {
        ...config,
        overrides: [
          {
            files: ["src/**/*.js"],
            formatting: { quote_style: "single", semicolons: "never" },
          },
        ],
      },
    });
    const byFile = new Map(result.map((item) => [item.filePath, item.diff]));
    assert.match(byFile.get("src/nested.js"), /^\+const value = 'nested'$/m);
    assert.doesNotMatch(byFile.get("src/nested.js"), /^\+.*"nested"/m);
    assert.match(byFile.get("index.js"), /^ const value = "root";$/m);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("shares file and parent-directory exclusion rules with editor integrations", () => {
  const directoryConfig = {
    ...config,
    files: {
      include: ["**/*.js"],
      exclude: ["dist", "src/vendor/**"],
    },
  };

  assert.equal(isIncludedPath("index.js", directoryConfig), true);
  assert.equal(isIncludedPath("dist/index.js", directoryConfig), false);
  assert.equal(isIncludedPath("src/vendor/index.js", directoryConfig), false);
  assert.equal(isIncludedPath("src/index.js", directoryConfig), true);
});

test("rejects paths outside the project and reserved directories", () => {
  for (const filePath of [
    "../outside.js",
    "src/../../outside.js",
    "/outside.js",
    "C:/outside.js",
    "node_modules/package/index.js",
    "src/node_modules/package/index.js",
    ".git/hooks/pre-commit.js",
    ".cleanser-backups/src/index.js",
  ]) {
    assert.equal(isIncludedPath(filePath, config), false, filePath);
  }

  assert.equal(isIncludedPath("src/index.js", config), true);
});

test("rejects symbolic links and files outside the project", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cleanser-safe-path-"));
  const outside = await fs.mkdtemp(
    path.join(os.tmpdir(), "cleanser-safe-path-outside-"),
  );
  try {
    const regularFile = path.join(root, "regular.js");
    const outsideFile = path.join(outside, "outside.js");
    await fs.writeFile(regularFile, "const value=1");
    await fs.writeFile(outsideFile, "const outside=1");

    assert.equal(await isSafeProjectFile(root, regularFile), true);
    assert.equal(await isSafeProjectFile(root, "regular.js"), true);
    assert.equal(await isSafeProjectFile(root, outsideFile), false);

    try {
      await fs.symlink(outsideFile, path.join(root, "linked.js"), "file");
      await fs.symlink(outside, path.join(root, "linked-dir"), "dir");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
        t.skip("Symbolic links are not available on this platform.");
        return;
      }
      throw error;
    }

    assert.equal(
      await isSafeProjectFile(root, path.join(root, "linked.js")),
      false,
    );
    assert.equal(
      await isSafeProjectFile(
        root,
        path.join(root, "linked-dir", "outside.js"),
      ),
      false,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("matches literal glob metacharacters safely", () => {
  assert.equal(matchesPattern("src/file(1).js", "src/file(1).js"), true);
  assert.equal(matchesPattern("src/file[1].js", "src/file[1].js"), true);
  assert.equal(matchesPattern("src/fileX1.js", "src/file[1].js"), false);
});

test("rejects invalid pattern inputs without throwing", () => {
  assert.equal(matchesPattern(null, "*.js"), false);
  assert.equal(matchesPattern("index.js", ""), false);
  assert.equal(matchesPattern("index.js", null), false);
});

test("formats JavaScript while retaining identifiers and expressions", async () => {
  const input = "const answer= 40+2\nconsole.log(answer)";
  const output = await formatSource(input, "sample.js", config);
  assert.match(output, /const answer = 40 \+ 2;/);
  assert.match(output, /console\.log\(answer\);/);
  assert.match(output, /answer/);
});

test("formats TypeScript with its parser", async () => {
  const input = "const greet=(name:string)=>'Hello '+name";
  const output = await formatSource(input, "sample.ts", config);
  assert.match(output, /const greet = \(name: string\) =>/);
});

test("AST equivalence accepts formatting and rejects changed code or comments", async () => {
  const formattingOnly = await compareAstEquivalence(
    "const value=1",
    "const value = 1;\n",
    "sample.js",
    config,
  );
  assert.deepEqual(formattingOnly, {
    equivalent: true,
    difference: null,
    method: "prettier-ast",
  });

  const changedCode = await compareAstEquivalence(
    "const value=1",
    "const value = 2;\n",
    "sample.js",
    config,
  );
  assert.equal(changedCode.equivalent, false);

  const changedComment = await compareAstEquivalence(
    "// original note\nconst value=1",
    "// changed note\nconst value = 1;\n",
    "sample.js",
    config,
  );
  assert.equal(changedComment.equivalent, false);

  const jsxBefore = "export const App=()=> <main>Hello</main>";
  const jsxAfter = await formatSource(jsxBefore, "App.tsx", config);
  const jsxComparison = await compareAstEquivalence(
    jsxBefore,
    jsxAfter,
    "App.tsx",
    config,
  );
  assert.equal(jsxComparison.equivalent, true, jsxComparison.difference);
});

test("verifies SQL formatting with AST and exact token preservation", async () => {
  const source = "select id,name from users where active=true order by id";
  const formatted = await formatSource(source, "query.sql", config);
  const comparison = await compareAstEquivalence(
    source,
    formatted,
    "query.sql",
    config,
  );
  assert.deepEqual(comparison, {
    equivalent: true,
    difference: null,
    method: "sql-ast+token-stream",
  });

  const changedLiteral = await compareAstEquivalence(
    "select 'a  b' as value",
    "select 'a b' as value",
    "query.sql",
    config,
  );
  assert.equal(changedLiteral.equivalent, false);
  assert.match(changedLiteral.difference, /SQL token/);

  const changedComment = await compareAstEquivalence(
    "select 1 -- original note",
    "select 1 -- changed note",
    "query.sql",
    config,
  );
  assert.equal(changedComment.equivalent, false);
  assert.match(changedComment.difference, /SQL token/);
});

test("formats bundled TOML, XML, SQL, Svelte, Astro, shell, PowerShell, Java, and PHP", async () => {
  const samples = [
    ["settings.toml", "[app]\nname='Cleanser'\ncount=1\n"],
    ["feed.xml", "<root><item id='1'>value</item></root>"],
    ["query.sql", "select id,name from users where active=true order by id"],
    [
      "Component.svelte",
      "<script>let count=0;</script><button on:click={()=>count++}>{count}</button>",
    ],
    ["Page.astro", "---\nconst name='Cleanser'\n---\n<h1>Hello {name}</h1>"],
    [
      "script.sh",
      '#!/bin/sh\nvalue=1\nif [ "$value" -eq 1 ];then echo ok;fi\n',
    ],
    [
      "script.ps1",
      "function Get-Widget{param([string]$Name)$items=Get-Item|Where-Object{$_.Name -eq $Name};$items}",
    ],
    [
      "Main.java",
      'class Main{public static void main(String[]args){System.out.println("hi");}}',
    ],
    [
      "sample.php",
      '<?php function greet($name){echo "Hello, ".$name;} greet("Ada");',
    ],
  ];

  for (const [filePath, source] of samples) {
    const formatted = await formatSource(source, filePath, config);
    assert.notEqual(formatted, source, `${filePath} should be formatted`);
    assert.equal(
      await formatSource(formatted, filePath, config),
      formatted,
      `${filePath} should format idempotently`,
    );

    const comparison = await compareAstEquivalence(
      source,
      formatted,
      filePath,
      config,
    );
    assert.equal(
      comparison.equivalent,
      true,
      `${filePath}: ${comparison.difference}`,
    );
  }
});

test("does not normalize meaningful Svelte or Astro whitespace", async () => {
  const svelte = await compareAstEquivalence(
    "<p>\n\n</p>",
    "<p></p>",
    "component.svelte",
    config,
  );
  assert.equal(svelte.equivalent, false);

  const astro = await compareAstEquivalence(
    "<pre>\n\n</pre>",
    "<pre></pre>",
    "component.astro",
    config,
  );
  assert.equal(astro.equivalent, false);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cleanser-astro-"));
  try {
    await fs.writeFile(
      path.join(root, "astro.config.mjs"),
      "export default { compressHTML: false };\n",
    );
    const configuredAstro = await compareAstEquivalence(
      "<h1>Hello</h1>",
      "<h1>Hello</h1>\n",
      path.join(root, "page.astro"),
      config,
    );
    assert.equal(configuredAstro.equivalent, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("PowerShell formatting preserves aliases, commands, and hashtable order", async () => {
  const source = "$map=@{b=2;a=1}\nls\nWrite-Host 'x'";
  const formatted = await formatSource(source, "sample.ps1", config);
  assert.match(formatted, /\bls\b/);
  assert.match(formatted, /Write-Host/);
  assert.ok(formatted.indexOf("b = 2") < formatted.indexOf("a = 1"));

  const comparison = await compareAstEquivalence(
    source,
    formatted,
    "sample.ps1",
    config,
  );
  assert.equal(comparison.equivalent, true, comparison.difference);
});

test("creates deterministic line diffs with unchanged context", () => {
  const diff = createUnifiedDiff(
    "src/sample.js",
    "alpha\nold\nomega\n",
    "alpha\nnew\nomega\n",
  );
  assert.equal(
    diff,
    [
      "--- a/src/sample.js",
      "+++ b/src/sample.js",
      "@@ -1,3 +1,3 @@",
      " alpha",
      "-old",
      "+new",
      " omega",
    ].join("\n"),
  );
  assert.equal(createUnifiedDiff("sample.js", "same", "same"), "");
});

test("formats supported web and configuration files deterministically", async () => {
  const samples = [
    ["module.mjs", "export const value=1"],
    ["script.cjs", "const value=1;module.exports=value"],
    ["module.mts", "export const value:number=1"],
    ["module.cts", "export const value:number=1"],
    [
      "page.html",
      "<!doctype html><html><body><main><p>Hello</p></main></body></html>",
    ],
    ["styles.css", "a{color:red;background:#fff}"],
    ["styles.scss", "$main:red;.box{color:$main;&:hover{color:blue}}"],
    ["settings.json", '{"name":"cleanser","nested":{"enabled":true}}'],
    [
      "settings.jsonc",
      '{// project settings\n"name":"cleanser","enabled":true}',
    ],
    ["settings.yaml", "name: cleanser\nitems: [one,two]\n"],
    ["guide.md", "# Cleanser\n\nClean   code.\n"],
    [
      "Component.vue",
      '<template><main><p>Hello</p></main></template><script>export default { name: "App" }</script>',
    ],
    ["settings.toml", "[app]\nname='Cleanser'\ncount=1\n"],
    ["feed.xml", "<root>\n<item id='1'>value</item>\n</root>"],
    [
      "icon.svg",
      '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>',
    ],
    ["query.sql", "select id,name from users where active=true order by id"],
    [
      "Component.svelte",
      "<script>let count=0;</script><button on:click={()=>count++}>{count}</button>",
    ],
    ["Page.astro", "---\nconst name='Cleanser'\n---\n<h1>Hello {name}</h1>"],
    [
      "script.sh",
      '#!/bin/sh\nvalue=1\nif [ "$value" -eq 1 ];then echo ok;fi\n',
    ],
    [
      "script.ps1",
      "function Get-Widget{param([string]$Name)$items=Get-Item|Where-Object{$_.Name -eq $Name};$items}",
    ],
    [
      "Main.java",
      'class Main{public static void main(String[]args){System.out.println("hi");}}',
    ],
    [
      "sample.php",
      '<?php function greet($name){echo "Hello, ".$name;} greet("Ada");',
    ],
  ];

  for (const [filePath, input] of samples) {
    const formatted = await formatSource(input, filePath, config);
    assert.equal(await formatSource(formatted, filePath, config), formatted);
  }
});

test("Java and PHP AST checks reject changed literals", async () => {
  const javaComparison = await compareAstEquivalence(
    'class Main { void run() { System.out.println("before"); } }',
    'class Main { void run() { System.out.println("after"); } }',
    "Main.java",
    config,
  );
  assert.equal(javaComparison.equivalent, false);

  const phpComparison = await compareAstEquivalence(
    '<?php echo "before";',
    '<?php echo "after";',
    "sample.php",
    config,
  );
  assert.equal(phpComparison.equivalent, false);
});

test("check mode previews changes without writing files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cleanser-check-"));
  try {
    const file = path.join(root, "index.js");
    const original = "const x=1";
    await fs.writeFile(file, original);
    const results = await cleanProject({ root, config, write: false });
    assert.equal(results[0].status, "would-clean");
    assert.equal(await fs.readFile(file, "utf8"), original);
    await assert.rejects(fs.access(path.join(root, ".cleanser-backups")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("protected paths are excluded from project cleanup", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cleanser-protected-"));
  const custom = {
    ...config,
    safety: {
      ...config.safety,
      protected_paths: ["vendor/**", "src/never-clean.js"],
    },
  };
  try {
    const protectedFile = path.join(root, "vendor", "library.js");
    const sourceFile = path.join(root, "src", "app.js");
    const protectedSourceFile = path.join(root, "src", "never-clean.js");
    await fs.mkdir(path.dirname(protectedFile), { recursive: true });
    await fs.mkdir(path.dirname(sourceFile), { recursive: true });
    await fs.writeFile(protectedFile, "const vendor=1");
    await fs.writeFile(sourceFile, "const app=1");
    await fs.writeFile(protectedSourceFile, "const protectedValue=1");

    const results = await cleanProject({ root, config: custom, write: true });

    assert.deepEqual(
      results.map((result) => result.filePath),
      [sourceFile],
    );
    assert.equal(await fs.readFile(protectedFile, "utf8"), "const vendor=1");
    assert.equal(
      await fs.readFile(protectedSourceFile, "utf8"),
      "const protectedValue=1",
    );
    assert.equal(await fs.readFile(sourceFile, "utf8"), "const app = 1;\n");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("reports deterministic per-file progress for terminal integrations", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cleanser-progress-"));
  const progress = [];
  try {
    await fs.writeFile(path.join(root, "a.js"), "const first=1");
    await fs.writeFile(path.join(root, "b.js"), "const second = 2;\n");

    const results = await cleanProject({
      root,
      config,
      write: false,
      onProgress: (event) => progress.push(event),
    });

    assert.equal(results.length, 2);
    assert.deepEqual(
      progress.map(({ completed, total, status }) => ({
        completed,
        total,
        status,
      })),
      [
        { completed: 1, total: 2, status: "changed" },
        { completed: 2, total: 2, status: "unchanged" },
      ],
    );
    assert.deepEqual(
      progress.map((event) => event.filePath),
      [path.join(root, "a.js"), path.join(root, "b.js")],
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("cancellation before writes preserves files and releases the project lock", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cleanser-cancel-"));
  const files = [path.join(root, "a.js"), path.join(root, "b.js")];
  const originals = ["const first=1", "const second=2"];
  const controller = new AbortController();
  try {
    await Promise.all(
      files.map((file, index) => fs.writeFile(file, originals[index])),
    );

    await assert.rejects(
      cleanProject({
        root,
        config,
        write: true,
        signal: controller.signal,
        onProgress({ completed }) {
          if (completed === 1) controller.abort();
        },
      }),
      /operation was cancelled/,
    );

    assert.deepEqual(
      await Promise.all(files.map((file) => fs.readFile(file, "utf8"))),
      originals,
    );
    await assert.rejects(fs.access(path.join(root, ".cleanser-backups")));
    await assert.rejects(fs.access(path.join(root, ".cleanser.lock")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("cancellation during a write rolls back earlier replacements", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "cleanser-cancel-rollback-"),
  );
  const firstFile = path.join(root, "a.js");
  const secondFile = path.join(root, "b.js");
  const originals = ["const first=1", "const second=2"];
  const controller = new AbortController();
  const originalRename = fs.rename;
  try {
    await fs.writeFile(firstFile, originals[0]);
    await fs.writeFile(secondFile, originals[1]);
    fs.rename = async (source, target) => {
      const result = await originalRename(source, target);
      if (target === firstFile) controller.abort();
      return result;
    };

    await assert.rejects(
      cleanProject({ root, config, write: true, signal: controller.signal }),
      /operation was cancelled.*restored to their original contents/,
    );

    assert.deepEqual(
      await Promise.all([
        fs.readFile(firstFile, "utf8"),
        fs.readFile(secondFile, "utf8"),
      ]),
      originals,
    );
    assert.equal(
      await fs.readFile(path.join(root, ".cleanser-backups", "a.js"), "utf8"),
      originals[0],
    );
    await assert.rejects(fs.access(path.join(root, ".cleanser.lock")));
  } finally {
    fs.rename = originalRename;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("change limits reject a batch before writing or backing up files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cleanser-limits-"));
  const originals = ["const first=1", "const second=2"];
  try {
    await fs.writeFile(path.join(root, "first.js"), originals[0]);
    await fs.writeFile(path.join(root, "second.js"), originals[1]);

    await assert.rejects(
      cleanProject({ root, config, write: true, limits: { maxFiles: 1 } }),
      /Change limits exceeded.*No files were changed/,
    );
    await assert.rejects(
      cleanProject({ root, config, write: true, limits: { maxBytes: 1 } }),
      /Change limits exceeded.*No files were changed/,
    );

    assert.deepEqual(
      await Promise.all([
        fs.readFile(path.join(root, "first.js"), "utf8"),
        fs.readFile(path.join(root, "second.js"), "utf8"),
      ]),
      originals,
    );
    await assert.rejects(fs.access(path.join(root, ".cleanser-backups")));
    await assert.rejects(fs.access(path.join(root, ".cleanser.lock")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("write runs refuse an existing project lock", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cleanser-lock-"));
  try {
    const file = path.join(root, "index.js");
    const original = "const value=1";
    await fs.writeFile(file, original);
    await fs.writeFile(
      path.join(root, ".cleanser.lock"),
      JSON.stringify({ pid: 123, startedAt: "2026-01-01T00:00:00.000Z" }),
    );

    await assert.rejects(
      cleanProject({ root, config, write: true }),
      /holds .cleanser.lock/,
    );
    assert.equal(await fs.readFile(file, "utf8"), original);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("clean mode creates a backup before formatting", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cleanser-write-"));
  try {
    const file = path.join(root, "index.js");
    const original = "const x=1";
    await fs.writeFile(file, original);
    const results = await cleanProject({ root, config, write: true });
    assert.equal(results[0].status, "cleaned");
    assert.notEqual(await fs.readFile(file, "utf8"), original);
    assert.equal(
      await fs.readFile(
        path.join(root, ".cleanser-backups", "index.js"),
        "utf8",
      ),
      original,
    );
    await assert.rejects(fs.access(path.join(root, ".cleanser.lock")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("skips malformed source without changing it", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cleanser-invalid-"));
  try {
    const file = path.join(root, "broken.js");
    const original = "const = ;";
    await fs.writeFile(file, original);
    const results = await cleanProject({ root, config, write: true });
    assert.equal(results[0].status, "skipped");
    assert.equal(await fs.readFile(file, "utf8"), original);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("preserves CRLF line endings when configured to preserve", async () => {
  const input = "const value=1;\r\nconsole.log(value);\r\n";
  const output = await formatSource(input, "sample.js", config);
  assert.equal(output.includes("\r\n"), true);
  assert.equal(output.replace(/\r\n/g, "").includes("\n"), false);
});

test("rejects unsupported source extensions", async () => {
  await assert.rejects(
    formatSource("print('hello')", "script.py", config),
    /Unsupported file type/,
  );
});

test("rejects malformed engine configuration before scanning", async () => {
  await assert.rejects(
    cleanProject({ config: { files: {}, formatting: {}, safety: {} } }),
    /files.include/,
  );
});

test("does not scan excluded directories or symbolic links", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cleanser-boundaries-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "cleanser-outside-"));
  try {
    await fs.mkdir(path.join(root, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(root, "dist", "ignored.js"),
      "const ignored=1",
    );
    await fs.writeFile(path.join(root, "kept.js"), "const kept=1");
    await fs.writeFile(path.join(outside, "external.js"), "const external=1");
    try {
      await fs.symlink(outside, path.join(root, "linked"), "dir");
    } catch (error) {
      if (!["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) throw error;
    }

    const results = await cleanProject({ root, config, write: false });
    assert.deepEqual(
      results.map((result) => path.basename(result.filePath)),
      ["kept.js"],
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("reports an invalid project root clearly", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cleanser-file-root-"));
  const file = path.join(root, "not-a-directory");
  try {
    await fs.writeFile(file, "x");
    await assert.rejects(
      cleanProject({ root: file, config }),
      /not a directory/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("formats JSX and TSX with the correct parsers", async () => {
  const jsx = await formatSource(
    "const App=()=> <main><h1>Hello</h1></main>",
    "App.jsx",
    config,
  );
  const tsx = await formatSource(
    "type Props={name:string}; const App=({name}:Props)=><h1>{name}</h1>",
    "App.tsx",
    config,
  );
  assert.match(jsx, /<main>/);
  assert.match(tsx, /type Props/);
  assert.match(tsx, /name: string/);
});

test("honours single quotes, no semicolons, and configured indentation", async () => {
  const custom = {
    ...config,
    formatting: {
      ...config.formatting,
      indentation: 4,
      quote_style: "single",
      semicolons: "never",
    },
  };
  const input = [
    "const value={",
    'message:"hello",',
    "nested:{count:1,enabled:true}",
    "}",
  ].join("\n");
  const output = await formatSource(input, "sample.js", custom);
  assert.match(output, /message: 'hello'/);
  assert.equal(output.includes(";"), false);
  assert.match(output, /^ {4}message:/m);
});

test("normalizes line endings when an explicit style is configured", async () => {
  const custom = {
    ...config,
    formatting: { ...config.formatting, normalize_line_endings: "lf" },
  };
  const output = await formatSource(
    "const a=1;\r\nconst b=2;\r\n",
    "sample.js",
    custom,
  );
  assert.equal(output.includes("\r"), false);
});

test("does not rewrite whitespace inside template literal content", async () => {
  const tick = String.fromCharCode(96);
  const slashN = String.fromCharCode(92) + "n";
  const input =
    "const message=" + tick + "first   line" + slashN + "second  line" + tick;
  const output = await formatSource(input, "sample.js", config);
  assert.equal(output.includes("first   line" + slashN + "second  line"), true);
});

test("does not create backups when backup safety is disabled", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cleanser-no-backup-"));
  const custom = {
    ...config,
    safety: { ...config.safety, create_backup: false },
  };
  try {
    await fs.writeFile(path.join(root, "index.js"), "const x=1");
    const results = await cleanProject({ root, config: custom, write: true });
    assert.equal(results[0].status, "cleaned");
    await assert.rejects(fs.access(path.join(root, ".cleanser-backups")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("fails safely on malformed syntax when skip mode is disabled", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "cleanser-fail-syntax-"),
  );
  const custom = {
    ...config,
    safety: { ...config.safety, skip_on_syntax_error: false },
  };
  try {
    await fs.writeFile(path.join(root, "broken.js"), "const = ;");
    await assert.rejects(
      cleanProject({ root, config: custom, write: true }),
      /Could not format broken.js/,
    );
    assert.equal(
      await fs.readFile(path.join(root, "broken.js"), "utf8"),
      "const = ;",
    );
    await assert.rejects(fs.access(path.join(root, ".cleanser-backups")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("creates backups for files inside nested directories", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "cleanser-nested-backup-"),
  );
  try {
    const nestedDirectory = path.join(root, "src", "components");
    const file = path.join(nestedDirectory, "App.tsx");
    const original = "export const App=()=> <main>Hello</main>";
    await fs.mkdir(nestedDirectory, { recursive: true });
    await fs.writeFile(file, original);

    const results = await cleanProject({ root, config, write: true });

    assert.equal(results[0].status, "cleaned");
    assert.equal(
      await fs.readFile(
        path.join(root, ".cleanser-backups", "src", "components", "App.tsx"),
        "utf8",
      ),
      original,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("preserves the first original backup across subsequent clean runs", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "cleanser-first-backup-"),
  );
  try {
    const file = path.join(root, "index.js");
    const backup = path.join(root, ".cleanser-backups", "index.js");
    const firstOriginal = "const value=1";
    await fs.writeFile(file, firstOriginal);

    await cleanProject({ root, config, write: true });
    await fs.writeFile(file, "const value=2");
    await cleanProject({ root, config, write: true });

    assert.equal(await fs.readFile(backup, "utf8"), firstOriginal);
    assert.match(await fs.readFile(file, "utf8"), /value = 2/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("does not overwrite an existing backup", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "cleanser-existing-backup-"),
  );
  try {
    const file = path.join(root, "index.js");
    const backup = path.join(root, ".cleanser-backups", "index.js");
    const protectedBackup = "manually preserved backup";
    await fs.writeFile(file, "const value=1");
    await fs.mkdir(path.dirname(backup), { recursive: true });
    await fs.writeFile(backup, protectedBackup);

    await cleanProject({ root, config, write: true });

    assert.equal(await fs.readFile(backup, "utf8"), protectedBackup);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("refuses a symlinked backup root", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "cleanser-backup-symlink-root-"),
  );
  const outside = await fs.mkdtemp(
    path.join(os.tmpdir(), "cleanser-backup-outside-"),
  );
  try {
    try {
      await fs.symlink(outside, path.join(root, ".cleanser-backups"), "dir");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
        t.skip("Directory symlinks are not available on this platform.");
        return;
      }
      throw error;
    }

    const file = path.join(root, "index.js");
    const original = "const value=1";
    await fs.writeFile(file, original);

    await assert.rejects(
      cleanProject({ root, config, write: true }),
      /not a safe directory/,
    );
    assert.equal(await fs.readFile(file, "utf8"), original);
    await assert.rejects(fs.access(path.join(outside, "index.js")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("refuses a symlinked directory inside the backup tree", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "cleanser-backup-symlink-nested-"),
  );
  const outside = await fs.mkdtemp(
    path.join(os.tmpdir(), "cleanser-backup-nested-outside-"),
  );
  try {
    const backupRoot = path.join(root, ".cleanser-backups");
    await fs.mkdir(backupRoot);
    try {
      await fs.symlink(outside, path.join(backupRoot, "src"), "dir");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
        t.skip("Directory symlinks are not available on this platform.");
        return;
      }
      throw error;
    }

    const sourceDirectory = path.join(root, "src");
    await fs.mkdir(sourceDirectory);
    const file = path.join(sourceDirectory, "index.js");
    const original = "const value=1";
    await fs.writeFile(file, original);

    await assert.rejects(
      cleanProject({ root, config, write: true }),
      /not a safe directory/,
    );
    assert.equal(await fs.readFile(file, "utf8"), original);
    await assert.rejects(fs.access(path.join(outside, "index.js")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("aborts formatting when a backup cannot be created", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "cleanser-backup-failure-"),
  );
  try {
    const file = path.join(root, "index.js");
    const original = "const value=1";
    await fs.writeFile(file, original);
    await fs.mkdir(path.join(root, ".cleanser-backups", "index.js"), {
      recursive: true,
    });

    await assert.rejects(cleanProject({ root, config, write: true }));
    assert.equal(await fs.readFile(file, "utf8"), original);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("skips malformed files while still formatting valid files", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "cleanser-mixed-syntax-"),
  );
  try {
    const valid = path.join(root, "a-valid.js");
    const broken = path.join(root, "z-broken.js");
    const brokenSource = "const = ;";
    await fs.writeFile(valid, "const value=1");
    await fs.writeFile(broken, brokenSource);

    const results = await cleanProject({ root, config, write: true });

    assert.deepEqual(
      results.map((result) => result.status),
      ["cleaned", "skipped"],
    );
    assert.match(await fs.readFile(valid, "utf8"), /value = 1/);
    assert.equal(await fs.readFile(broken, "utf8"), brokenSource);
    assert.equal(
      await fs.readFile(
        path.join(root, ".cleanser-backups", "a-valid.js"),
        "utf8",
      ),
      "const value=1",
    );
    await assert.rejects(
      fs.access(path.join(root, ".cleanser-backups", "z-broken.js")),
    );
    assert.match(results[1].reason, /./);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("strict syntax handling validates all files before writing any of them", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "cleanser-strict-preflight-"),
  );
  const custom = {
    ...config,
    safety: { ...config.safety, skip_on_syntax_error: false },
  };
  try {
    const valid = path.join(root, "a-valid.js");
    const broken = path.join(root, "z-broken.js");
    const validSource = "const value=1";
    const brokenSource = "const = ;";
    await fs.writeFile(valid, validSource);
    await fs.writeFile(broken, brokenSource);

    await assert.rejects(
      cleanProject({ root, config: custom, write: true }),
      /Could not format z-broken.js/,
    );

    assert.equal(await fs.readFile(valid, "utf8"), validSource);
    assert.equal(await fs.readFile(broken, "utf8"), brokenSource);
    await assert.rejects(fs.access(path.join(root, ".cleanser-backups")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("atomic replacement preserves the original file permissions", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX permission-bit assertions are not portable to Windows.");
    return;
  }

  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "cleanser-atomic-mode-"),
  );
  try {
    const file = path.join(root, "index.js");
    await fs.writeFile(file, "const value=1", { mode: 0o640 });
    await fs.chmod(file, 0o640);

    await cleanProject({ root, config, write: true });

    const stats = await fs.stat(file);
    assert.equal(stats.mode & 0o777, 0o640);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("successful atomic replacement leaves no temporary files behind", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "cleanser-atomic-temp-"),
  );
  try {
    await fs.writeFile(path.join(root, "index.js"), "const value=1");

    await cleanProject({ root, config, write: true });

    const entries = await fs.readdir(root);
    assert.equal(
      entries.some((name) => name.includes(".cleanser-tmp-")),
      false,
    );
    assert.match(
      await fs.readFile(path.join(root, "index.js"), "utf8"),
      /value = 1/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
