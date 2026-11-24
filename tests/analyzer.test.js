import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG } from "../src/config.js";
import {
  analyzeProject,
  getSafeQuickFix,
  getSafeQuickFixes,
  listRules,
} from "../src/analyzer.js";

const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));

async function withProject(callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cleanser-analysis-"));
  try {
    await callback(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("rule registry has unique, documented IDs and valid severities", () => {
  const rules = listRules();
  const ids = rules.map((rule) => rule.id);

  assert.equal(new Set(ids).size, ids.length);
  assert.ok(rules.length > 0);
  for (const rule of rules) {
    assert.match(rule.id, /^[a-z][a-z0-9-]+$/);
    assert.ok(rule.description.length > 0);
    assert.ok(["info", "warning", "error"].includes(rule.severity));
  }
});

test("rules command lists built-in IDs without needing project configuration", () => {
  const result = spawnSync(process.execPath, [cliPath, "rules"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /syntax-error\terror/);
  assert.match(result.stdout, /prefer-const\tinfo/);
});

test("uses compiler symbols to find unused declarations without flagging exports", async () => {
  await withProject(async (root) => {
    const file = path.join(root, "sample.ts");
    const source = [
      "export {};",
      "export const publicValue = 1;",
      "const unusedValue = 2;",
      "function unusedFunction(_ignored: string, used: number) { return used; }",
      "class UnusedClass {}",
    ].join("\n");
    await fs.writeFile(file, source);

    const findings = await analyzeProject({ root, config: DEFAULT_CONFIG });
    const unused = findings.filter((finding) =>
      finding.ruleId.startsWith("unused-"),
    );

    assert.deepEqual(
      unused.map((finding) => finding.ruleId),
      ["unused-constant", "unused-function", "unused-class"],
    );
    assert.ok(unused.every((finding) => finding.filePath === "sample.ts"));
    assert.equal(await fs.readFile(file, "utf8"), source);
  });
});

test("analyzer ignores configured non-code formatter files", async () => {
  await withProject(async (root) => {
    await fs.writeFile(
      path.join(root, "sample.ts"),
      "export {};\nlet unused = 1;",
    );
    await fs.writeFile(path.join(root, "notes.md"), "const alsoUnused = 2;");
    await fs.writeFile(path.join(root, "settings.json"), '{"value": 1}');

    const findings = await analyzeProject({ root, config: DEFAULT_CONFIG });
    assert.ok(findings.some((finding) => finding.filePath === "sample.ts"));
    assert.ok(findings.every((finding) => finding.filePath.endsWith(".ts")));
  });
});

test("analyzes Node ESM and CommonJS JavaScript and TypeScript extensions", async () => {
  await withProject(async (root) => {
    for (const extension of ["mjs", "cjs", "mts", "cts"]) {
      await fs.writeFile(
        path.join(root, `sample.${extension}`),
        "export {};\nconst unusedValue = 1;",
      );
    }

    const findings = await analyzeProject({ root, config: DEFAULT_CONFIG });
    const unusedFiles = new Set(
      findings
        .filter((finding) => finding.ruleId === "unused-constant")
        .map((finding) => finding.filePath),
    );
    assert.deepEqual([...unusedFiles].sort(), [
      "sample.cjs",
      "sample.cts",
      "sample.mjs",
      "sample.mts",
    ]);
  });
});

test("configuration can disable rules or override their severity", async () => {
  await withProject(async (root) => {
    await fs.writeFile(
      path.join(root, "sample.ts"),
      "export {};\nlet unused = 1;",
    );
    const config = {
      ...DEFAULT_CONFIG,
      analysis: {
        rules: {
          "unused-constant": "off",
          "unused-variable": "error",
        },
      },
    };
    const findings = await analyzeProject({ root, config });

    assert.equal(
      findings.some((finding) => finding.ruleId === "unused-constant"),
      false,
    );
    assert.equal(
      findings.find((finding) => finding.ruleId === "unused-variable")
        ?.severity,
      "error",
    );
  });
});

test("reports deterministic security patterns without printing secret values", async () => {
  await withProject(async (root) => {
    const source = [
      'import { exec as run } from "node:child_process";',
      'const apiKey = "k_live_A8hK9vZmQ2pL0xT7";',
      'const password = "correct-horse-battery-42";',
      `const signingKey = "-----BEGIN PRIVATE KEY-----\\n${"A".repeat(80)}\\n-----END PRIVATE KEY-----";`,
      'const redirect = "javascript:alert(1)";',
      'const credentialUrl = "https://alice:secret@example.com";',
      'const remote = "http://example.com/api";',
      'eval("run(" + input + ")");',
      'const dynamic = new Function("return 1");',
      'run("git status " + request.args);',
      'createHash("md5");',
      "Math.random();",
      "database.query(`SELECT * FROM users WHERE name = ${userName}`);",
      "element.innerHTML = html;",
      "path.join(__dirname, request.params.fileName);",
      "deserialize(payload);",
      'fs.writeFile("output.txt", data, { mode: 0o777 });',
      'const placeholderKey = "YOUR_API_KEY";',
      'const placeholderPassword = "changeme";',
      'const localService = "http://localhost:3000";',
    ].join("\n");
    await fs.writeFile(path.join(root, "security.ts"), source);

    const findings = await analyzeProject({ root, config: DEFAULT_CONFIG });
    const securityFindings = findings.filter((finding) =>
      finding.ruleId.match(
        /^(?:hardcoded-|private-key|suspicious-url|unsafe-|dangerous-shell|insecure-|weak-crypto|sql-injection|xss-|path-traversal)/,
      ),
    );
    const ruleIds = new Set(securityFindings.map((finding) => finding.ruleId));

    for (const ruleId of [
      "hardcoded-api-key",
      "hardcoded-password",
      "private-key",
      "suspicious-url",
      "insecure-http",
      "unsafe-eval",
      "unsafe-dynamic-code",
      "dangerous-shell-command",
      "weak-cryptography",
      "insecure-random",
      "sql-injection-risk",
      "xss-risk",
      "path-traversal-risk",
      "unsafe-deserialization",
      "insecure-file-permissions",
    ]) {
      assert.ok(ruleIds.has(ruleId), `Expected security finding ${ruleId}.`);
    }
    assert.ok(
      securityFindings.every(
        (finding) =>
          !finding.message.includes("k_live_A8hK9vZmQ2pL0xT7") &&
          !finding.message.includes("correct-horse-battery-42"),
      ),
    );
  });
});

test("analyzes dated TODOs, FIXME markers, duplicate and empty comments, and commented code", async () => {
  await withProject(async (root) => {
    const source = [
      "//",
      "// TODO [due: 2000-01-01] finish the compatibility migration.",
      "// FIXME verify the fallback behavior.",
      "// This shared explanation describes the expected behavior clearly.",
      "// This shared explanation describes the expected behavior clearly.",
      "// const disabledValue = computeValue();",
      "export {};",
    ].join("\n");
    await fs.writeFile(path.join(root, "comments.ts"), source);

    const findings = await analyzeProject({ root, config: DEFAULT_CONFIG });
    const commentFindings = findings.filter((finding) =>
      [
        "outdated-todo",
        "fixme-comment",
        "duplicate-comment",
        "empty-comment",
        "commented-out-code",
      ].includes(finding.ruleId),
    );

    assert.deepEqual(
      commentFindings.map((finding) => finding.ruleId),
      [
        "empty-comment",
        "outdated-todo",
        "fixme-comment",
        "duplicate-comment",
        "commented-out-code",
      ],
    );
    assert.ok(commentFindings.every((finding) => finding.line > 0));
  });
});

test("checks public JSDoc descriptions, parameters, return tags, and parameter names", async () => {
  await withProject(async (root) => {
    const source = [
      "/** Public helper for a value. */",
      "export function describe(value: string): string { return value; }",
      "/**",
      " * Public helper with invalid tags.",
      " * @param value the input value",
      " * @param value duplicate parameter tag",
      " * @param missing unknown parameter",
      " */",
      "export function formatValue(value: string): string { return value; }",
      "export class PublicClass {}",
      "/** Complete helper.",
      " * @param value the input value",
      " * @returns the formatted value",
      " */",
      "export function complete(value: string): string { return value; }",
    ].join("\n");
    await fs.writeFile(path.join(root, "api.ts"), source);

    const findings = await analyzeProject({ root, config: DEFAULT_CONFIG });
    const docs = findings.filter(
      (finding) =>
        finding.ruleId.includes("documentation") ||
        finding.ruleId === "invalid-jsdoc",
    );
    const ruleIds = docs.map((finding) => finding.ruleId);

    assert.ok(ruleIds.includes("missing-function-documentation"));
    assert.ok(ruleIds.includes("missing-parameter-documentation"));
    assert.ok(ruleIds.includes("missing-return-documentation"));
    assert.equal(
      ruleIds.filter((ruleId) => ruleId === "invalid-jsdoc").length,
      2,
    );
    assert.equal(
      docs.some((finding) => finding.filePath === "api.ts" && finding.line > 0),
      true,
    );
    assert.equal(
      docs.some((finding) => finding.message.includes("complete")),
      false,
    );
  });
});

test("checks JSDoc coverage for exported interfaces, types, enums, and variables", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cleanser-jsdoc-"));
  try {
    await fs.writeFile(
      path.join(root, "public.ts"),
      [
        "export interface Options { enabled: boolean }",
        "export type Result = string;",
        "export enum State { Ready }",
        "export const defaultOptions = {};",
      ].join("\n"),
    );
    const findings = await analyzeProject({ root, config: DEFAULT_CONFIG });
    assert.equal(
      findings.filter(
        (finding) => finding.ruleId === "missing-public-documentation",
      ).length,
      4,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("measures conservative function, class, dependency, and duplication thresholds", async () => {
  await withProject(async (root) => {
    const branches = Array.from(
      { length: 16 },
      (_, index) => `  if (value === ${index}) return ${index};`,
    );
    const longBody = Array.from(
      { length: 52 },
      (_, index) => `  const item${index} = ${index};`,
    );
    const imports = Array.from(
      { length: 21 },
      (_, index) => `import "package-${index}";`,
    );
    const classBody = [
      "class LargeClass {",
      ...Array.from({ length: 102 }, (_, index) => `  // line ${index}`),
      "}",
    ];
    const source = [
      ...imports,
      "export {};",
      "function branchy(value, a, b, c, d, e) {",
      ...branches,
      "}",
      "function deeplyNested(value) {",
      "  if (value) {",
      "    if (value) {",
      "      if (value) {",
      "        if (value) {",
      "          if (value) return value;",
      "        }",
      "      }",
      "    }",
      "  }",
      "}",
      "function longFunction() {",
      ...longBody,
      "}",
      "function duplicateOne() { const a = 1; const b = 2; const c = 3; return a + b + c; }",
      "function duplicateTwo() { const a = 1; const b = 2; const c = 3; return a + b + c; }",
      ...classBody,
    ].join("\n");
    await fs.writeFile(path.join(root, "metrics.ts"), source);

    const findings = await analyzeProject({ root, config: DEFAULT_CONFIG });
    const ruleIds = new Set(findings.map((finding) => finding.ruleId));
    for (const ruleId of [
      "high-cyclomatic-complexity",
      "high-cognitive-complexity",
      "long-function",
      "deep-nesting",
      "too-many-parameters",
      "large-class",
      "too-many-dependencies",
      "duplicate-code",
    ]) {
      assert.ok(ruleIds.has(ruleId), `Expected metric finding ${ruleId}.`);
    }
  });
});

test("verifies all five partial code-quality rules with isolated runtime fixtures", async () => {
  await withProject(async (root) => {
    await fs.writeFile(
      path.join(root, "duplicate-a.ts"),
      [
        "export function first(value: number) {",
        "  const one = value + 1;",
        "  const two = one + 1;",
        "  const three = two + 1;",
        "  return three;",
        "}",
      ].join("\\n"),
    );
    await fs.writeFile(
      path.join(root, "duplicate-b.ts"),
      [
        "export function second(value: number) {",
        "  const one = value + 1;",
        "  const two = one + 1;",
        "  const three = two + 1;",
        "  return three;",
        "}",
      ].join("\\n"),
    );
    await fs.writeFile(
      path.join(root, "dead.ts"),
      "export function dead() { return 1; const unreachable = 2; }",
    );
    await fs.writeFile(
      path.join(root, "redundant.ts"),
      "export function redundant() { 1 + 2; return; }",
    );
    await fs.writeFile(
      path.join(root, "conditions.ts"),
      [
        "export function conditions(flag: boolean) {",
        "  if (true) return 1;",
        "  if (flag) return 2; else if (flag) return 3;",
        "  return 4;",
        "}",
      ].join("\\n"),
    );
    await fs.writeFile(
      path.join(root, "types.ts"),
      "export let count: number = 1;",
    );

    const findings = await analyzeProject({ root, config: DEFAULT_CONFIG });
    const byRule = (ruleId) => findings.filter((finding) => finding.ruleId === ruleId);

    for (const ruleId of [
      "duplicate-code",
      "unreachable-code",
      "redundant-expression",
      "constant-condition",
      "repeated-branch-condition",
      "redundant-type-annotation",
    ]) {
      assert.ok(byRule(ruleId).length > 0, `Expected runtime evidence for ${ruleId}.`);
    }

    assert.ok(
      byRule("duplicate-code").some((finding) => finding.filePath === "duplicate-b.ts"),
      "Cross-file duplicate bodies should be reported at the later occurrence.",
    );
    assert.ok(
      byRule("unreachable-code").some((finding) => finding.filePath === "dead.ts"),
    );
    assert.ok(
      byRule("redundant-type-annotation").some((finding) => finding.filePath === "types.ts"),
    );
  });
});

test("reports duplicate imports, declarations, and unreachable statements", async () => {
  await withProject(async (root) => {
    const source = [
      'import { first } from "./module.js";',
      'import { second } from "./module.js";',
      "const duplicate = 1;",
      "const duplicate = 2;",
      "function unreachable() { return 1; const afterReturn = 2; }",
    ].join("\n");
    await fs.writeFile(path.join(root, "sample.ts"), source);

    const findings = await analyzeProject({ root, config: DEFAULT_CONFIG });
    const ruleIds = findings.map((finding) => finding.ruleId);

    assert.ok(ruleIds.includes("duplicate-import"));
    assert.ok(ruleIds.includes("unused-import"));
    assert.ok(ruleIds.includes("duplicate-declaration"));
    assert.ok(ruleIds.includes("unreachable-code"));
    assert.ok(
      findings.every((finding) => finding.line > 0 && finding.column > 0),
    );
  });
});

test("reports conservative import order, grouping, and path style candidates", async () => {
  await withProject(async (root) => {
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(
      path.join(root, "src", "imports.ts"),
      [
        'import type { Zed } from "z-package";',
        'import type { Alpha } from "a-package";',
        'import { readFile } from "node:fs";',
        'import { useThing } from "package";',
        'import { localThing } from "./local/../mod.js";',
        'import { anotherThing } from "./other";',
      ].join("\n"),
    );

    const findings = await analyzeProject({ root, config: DEFAULT_CONFIG });
    const rules = new Set(findings.map((finding) => finding.ruleId));
    for (const ruleId of [
      "import-order",
      "import-grouping",
      "import-path-normalization",
      "relative-import-consistency",
    ]) {
      assert.ok(rules.has(ruleId), `Expected import finding ${ruleId}.`);
    }
    assert.ok(
      findings
        .filter((finding) => finding.ruleId.startsWith("import-"))
        .every((finding) => finding.severity === "info"),
    );
  });
});

test("reports identity array maps as copy-allocation candidates", async () => {
  await withProject(async (root) => {
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(
      path.join(root, "src", "arrays.ts"),
      [
        "export {};",
        "const values = [1, 2].map((value) => value);",
        "const changed = [1, 2].map((value) => value + 1);",
      ].join("\n"),
    );

    const findings = await analyzeProject({ root, config: DEFAULT_CONFIG });
    const candidates = findings.filter(
      (finding) => finding.ruleId === "redundant-array-operation",
    );
    assert.equal(candidates.length, 1);
    assert.match(candidates[0].message, /map still creates a shallow copy/);
    assert.equal(candidates[0].severity, "info");
  });
});

test("reports explicit AST findings and conservative refactoring suggestions", async () => {
  await withProject(async (root) => {
    const source = [
      "function empty() {}",
      "function run(flag: boolean) {",
      "  if (1 < 2) {}",
      "  if (flag) { return; } else { console.log(flag); }",
      "  let stable = 1;",
      "  const result = flag ? true : false;",
      "  console.log(stable, result);",
      "  return;",
      "}",
      "try {} catch {}",
      "0;",
    ].join("\n");
    await fs.writeFile(path.join(root, "sample.ts"), source);

    const findings = await analyzeProject({ root, config: DEFAULT_CONFIG });
    const ruleIds = findings.map((finding) => finding.ruleId);

    for (const ruleId of [
      "empty-function",
      "empty-catch",
      "constant-condition",
      "unnecessary-else",
      "prefer-const",
      "redundant-ternary",
      "redundant-return",
      "redundant-expression",
    ]) {
      assert.ok(ruleIds.includes(ruleId), `Expected ${ruleId} to be reported.`);
    }
  });
});

test("suggests primitive template literals and guarded nullish operators", async () => {
  await withProject(async (root) => {
    const source = [
      "export function greeting(name: string) { return 'Hello, ' + name; }",
      "export function optionalName(user: { name: string } | null | undefined) {",
      "  return user != null ? user.name : undefined;",
      "}",
      "export function fallback(value: string | null | undefined, other: string) {",
      "  return value == null ? other : value;",
      "}",
      "export function strictNull(value: string | null | undefined) {",
      "  return value === null ? 'missing' : value;",
      "}",
      "export function objectString(value: { toString(): string }) {",
      "  return 'value=' + value;",
      "}",
    ].join("\n");
    await fs.writeFile(path.join(root, "suggestions.ts"), source);

    const findings = await analyzeProject({ root, config: DEFAULT_CONFIG });
    const byRule = (ruleId) =>
      findings.filter((finding) => finding.ruleId === ruleId);

    assert.equal(byRule("prefer-template-literal").length, 1);
    assert.equal(byRule("prefer-optional-chain").length, 1);
    assert.equal(byRule("prefer-nullish-coalescing").length, 1);
    assert.equal(
      await fs.readFile(path.join(root, "suggestions.ts"), "utf8"),
      source,
    );
  });
});

test("suggests object shorthand only for identical safe property names", async () => {
  await withProject(async (root) => {
    const source = [
      "const value = 1;",
      "export const object = { value: value, renamed: value, ['computed']: value };",
      "const proto = { __proto__: __proto__ };",
    ].join("\n");
    await fs.writeFile(path.join(root, "object.js"), source);

    const findings = await analyzeProject({ root, config: DEFAULT_CONFIG });
    const suggestions = findings.filter(
      (finding) => finding.ruleId === "object-shorthand",
    );
    assert.equal(suggestions.length, 1);
    assert.match(suggestions[0].message, /object shorthand/);
    assert.equal(
      await fs.readFile(path.join(root, "object.js"), "utf8"),
      source,
    );
  });
});

test("reports empty literal spreads without rewriting source", async () => {
  await withProject(async (root) => {
    const source =
      "export const values = [...[], 1];\nexport const object = { ...{}, ok: true };\n";
    const file = path.join(root, "spreads.js");
    await fs.writeFile(file, source);

    const findings = await analyzeProject({ root, config: DEFAULT_CONFIG });
    assert.equal(
      findings.filter((finding) => finding.ruleId === "empty-spread").length,
      2,
    );
    assert.equal(await fs.readFile(file, "utf8"), source);
  });
});

test("suggests var replacements and reports safe repeated conditions and return await", async () => {
  await withProject(async (root) => {
    const source = [
      "export {};",
      "function branches(first: boolean, second: boolean) {",
      "  if (first) {} else if (second) {} else if (first) {}",
      "}",
      "function sideEffectCondition() {",
      "  if (isReady()) {} else if (isReady()) {}",
      "}",
      "function variables() {",
      "  var immutable = 1;",
      "  var mutable = 1;",
      "  mutable++;",
      "  var redeclared = 1;",
      "  var redeclared = 2;",
      "  let stable = 1;",
      "  return immutable + mutable + redeclared + stable;",
      "}",
      "async function redundantAwait(value: Promise<number>) { return await value; }",
      "async function caughtAwait(value: Promise<number>) {",
      "  try { return await value; } catch { return 0; }",
      "}",
      "async function finalAwait(value: Promise<number>) {",
      "  try { return await value; } finally { console.log('finished'); }",
      "}",
      "function assertions(value: string) {",
      "  const sameType = value as string;",
      "  const nonNull = value!;",
      "  const changedType = value as unknown;",
      "  return sameType + nonNull + String(changedType);",
      "}",
    ].join("\n");
    await fs.writeFile(path.join(root, "suggestions.ts"), source);

    const findings = await analyzeProject({ root, config: DEFAULT_CONFIG });
    const byRule = (ruleId) =>
      findings.filter((finding) => finding.ruleId === ruleId);

    assert.equal(byRule("repeated-branch-condition").length, 1);
    assert.equal(byRule("prefer-let").length, 1);
    assert.equal(byRule("prefer-const").length, 2);
    assert.equal(byRule("unnecessary-return-await").length, 1);
    assert.equal(byRule("unnecessary-type-assertion").length, 2);
    assert.ok(
      byRule("repeated-branch-condition")[0].line === 3,
      "The duplicate finding should point to the repeated condition.",
    );
  });
});

test("reports only primitive annotations redundant for mutable literal bindings", async () => {
  await withProject(async (root) => {
    await fs.writeFile(
      path.join(root, "annotations.ts"),
      [
        "export let count: number = 1;",
        'export let label: string = "Cleanser";',
        "export let enabled: boolean = true;",
        'export const fixed: string = "literal type is intentionally widened";',
        'export let computed: number = Number("1");',
        "export let union: 1 | 2 = 1;",
      ].join("\n"),
    );

    const findings = await analyzeProject({ root, config: DEFAULT_CONFIG });
    const redundant = findings.filter(
      (finding) => finding.ruleId === "redundant-type-annotation",
    );
    assert.deepEqual(
      redundant.map((finding) => finding.line),
      [1, 2, 3],
    );
    assert.ok(redundant.every((finding) => finding.severity === "info"));
  });
});

test("reports redundant parentheses only around simple atomic expressions", async () => {
  await withProject(async (root) => {
    await fs.writeFile(
      path.join(root, "parentheses.ts"),
      [
        "export function render(value: string) {",
        "  const first = (value);",
        "  const second = (3);",
        "  const third = (true);",
        '  const grouped = (value + "!");',
        '  ("use strict");',
        "  return `${first}${second}${third}${grouped}`;",
        "}",
      ].join("\n"),
    );

    const findings = await analyzeProject({ root, config: DEFAULT_CONFIG });
    const redundant = findings.filter(
      (finding) => finding.ruleId === "redundant-parentheses",
    );
    assert.deepEqual(
      redundant.map((finding) => finding.line),
      [2, 3, 4],
    );
    assert.ok(redundant.every((finding) => finding.severity === "info"));
  });
});

test("applies analysis rule overrides by project-relative file pattern", async () => {
  await withProject(async (root) => {
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(
      path.join(root, "index.ts"),
      "export {}; const unused = 1;",
    );
    await fs.writeFile(
      path.join(root, "src", "nested.ts"),
      "export {}; const unused = 1;",
    );
    const config = {
      ...DEFAULT_CONFIG,
      overrides: [
        {
          files: ["src/**/*.ts"],
          rules: { "unused-constant": "off" },
        },
      ],
    };

    const findings = await analyzeProject({ root, config });
    assert.deepEqual(
      findings
        .filter((finding) => finding.ruleId === "unused-constant")
        .map((finding) => finding.filePath),
      ["index.ts"],
    );
  });
});

test("reports only outer compile-time constant expressions without rewriting", async () => {
  await withProject(async (root) => {
    const file = path.join(root, "constants.ts");
    const source = [
      "export {};",
      "const numeric = 2 * (3 + 4);",
      'const text = "clean" + "ser";',
      "const shortCircuit = false && unknownCall();",
      "const selected = true ? 7 : unknownCall();",
      "const dynamic = input + 1;",
    ].join("\n");
    await fs.writeFile(file, source);

    const findings = await analyzeProject({ root, config: DEFAULT_CONFIG });
    const constants = findings.filter(
      (finding) => finding.ruleId === "constant-expression",
    );
    assert.equal(constants.length, 4);
    assert.deepEqual(
      constants.map((finding) => finding.message),
      [
        "This expression always evaluates to 14.",
        'This expression always evaluates to "cleanser".',
        "This expression always evaluates to false.",
        "This expression always evaluates to 7.",
      ],
    );
    assert.equal(await fs.readFile(file, "utf8"), source);
  });
});

test("reports parse errors as findings instead of changing malformed files", async () => {
  await withProject(async (root) => {
    const file = path.join(root, "broken.js");
    const source = "const = ;";
    await fs.writeFile(file, source);

    const findings = await analyzeProject({ root, config: DEFAULT_CONFIG });

    assert.ok(findings.some((finding) => finding.ruleId === "syntax-error"));
    assert.equal(await fs.readFile(file, "utf8"), source);
  });
});

test("detects standalone pure array and object literals as redundant statements", async () => {
  await withProject(async (root) => {
    const source = [
      "[1, 2, , 4];",
      "({ answer: 42, enabled: true });",
      "[...values];",
      "({ [key]: 1 });",
    ].join("\n");
    await fs.writeFile(path.join(root, "redundant.ts"), source);
    const findings = await analyzeProject({ root, config: DEFAULT_CONFIG });
    assert.equal(
      findings.filter((finding) => finding.ruleId === "redundant-expression")
        .length,
      2,
    );
  });
});

test("does not call top-level script globals unused without module evidence", async () => {
  await withProject(async (root) => {
    await fs.writeFile(path.join(root, "script.js"), "const globalValue = 1;");

    const findings = await analyzeProject({ root, config: DEFAULT_CONFIG });

    assert.equal(
      findings.some((finding) => finding.ruleId === "unused-constant"),
      false,
    );
  });
});

test("tracks JavaScript imports and preserves exported module bindings", async () => {
  await withProject(async (root) => {
    await fs.writeFile(
      path.join(root, "api.js"),
      "export function usedApi() {} export function publicApi() {}",
    );
    await fs.writeFile(
      path.join(root, "consumer.js"),
      'import { usedApi, publicApi as unusedApi } from "./api.js"; usedApi();',
    );

    const findings = await analyzeProject({ root, config: DEFAULT_CONFIG });

    assert.equal(
      findings.filter((finding) => finding.ruleId === "unused-import").length,
      1,
      JSON.stringify(findings),
    );
    assert.equal(
      findings.some(
        (finding) =>
          finding.filePath === "api.js" && finding.ruleId === "unused-function",
      ),
      false,
    );
  });
});

test("analyze emits machine-readable output and never edits source files", async () => {
  await withProject(async (root) => {
    const init = spawnSync(process.execPath, [cliPath, "init"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(init.status, 0);

    const file = path.join(root, "sample.js");
    const source = "module.exports = {}; const unused = 1;";
    await fs.writeFile(file, source);

    const result = spawnSync(
      process.execPath,
      [cliPath, "analyze", "--format=json"],
      {
        cwd: root,
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 1);
    const findings = JSON.parse(result.stdout);
    assert.ok(findings.some((finding) => finding.ruleId === "unused-constant"));
    assert.equal(await fs.readFile(file, "utf8"), source);
    await assert.rejects(fs.access(path.join(root, ".cleanser-backups")));
  });
});

test("safe quick fixes cover only comment-free, low-risk source suggestions", () => {
  const source = "const value = { item: item };\nconst copy = (value);\n";
  const shorthand = getSafeQuickFix(
    source,
    "sample.ts",
    "object-shorthand",
    source.indexOf("item: item"),
    source.indexOf("item: item") + "item: item".length,
  );
  assert.deepEqual(shorthand, {
    start: source.indexOf("item: item"),
    end: source.indexOf("item: item") + "item: item".length,
    newText: "item",
    title: "Use object property shorthand",
  });

  const commented = "const value = { item /* keep */ : item };";
  assert.equal(
    getSafeQuickFix(
      commented,
      "sample.ts",
      "object-shorthand",
      commented.indexOf("item"),
      commented.indexOf("item /*") + "item /* keep */ : item".length,
    ),
    undefined,
  );

  const parenthesized = "const value = (item);";
  const parenthesesStart = parenthesized.indexOf("(item)");
  assert.equal(
    getSafeQuickFix(
      parenthesized,
      "sample.ts",
      "redundant-parentheses",
      parenthesesStart,
      parenthesesStart + "(item)".length,
    )?.newText,
    "item",
  );

  const booleanConditional = "const flag = (value ? true : false);";
  const conditionalStart = booleanConditional.indexOf("value ?");
  assert.deepEqual(
    getSafeQuickFix(
      booleanConditional,
      "sample.ts",
      "redundant-ternary",
      conditionalStart,
      booleanConditional.indexOf("false") + "false".length,
    ),
    {
      start: conditionalStart,
      end: booleanConditional.indexOf("false") + "false".length,
      newText: "!!(value)",
      title: "Simplify boolean conditional",
    },
  );

  const typeImports =
    'import type { Zebra } from "zebra";\nimport type { Alpha } from "alpha";\nexport {};';
  const importStart = typeImports.indexOf('"alpha"');
  assert.deepEqual(
    getSafeQuickFix(
      typeImports,
      "sample.ts",
      "import-order",
      importStart,
      importStart + '"alpha"'.length,
    ),
    {
      start: 0,
      end: typeImports.indexOf("\nexport"),
      newText:
        'import type { Alpha } from "alpha";\nimport type { Zebra } from "zebra";',
      title: "Sort type-only imports",
    },
  );

  const groupedImports =
    'import local from "./local.js";\nimport packageValue from "package";';
  const groupedQuickFix = getSafeQuickFix(
    groupedImports,
    "sample.ts",
    "import-grouping",
    groupedImports.indexOf('"package"'),
    groupedImports.indexOf('"package"') + '"package"'.length,
  );
  assert.equal(groupedQuickFix?.title, "Separate import groups");
  assert.equal(groupedQuickFix?.newText, "\n\n");

  const literalConcatenation = 'const label = "item: " + 3 + true;';
  const concatenationStart = literalConcatenation.indexOf('"item: "');
  assert.deepEqual(
    getSafeQuickFix(
      literalConcatenation,
      "sample.ts",
      "prefer-template-literal",
      concatenationStart,
      literalConcatenation.length - 1,
    ),
    {
      start: concatenationStart,
      end: literalConcatenation.length - 1,
      newText: "`item: ${3}${true}`",
      title: "Convert concatenation to a template literal",
    },
  );
  const arithmeticGrouping = 'const total = "total: " + (1 + 2);';
  const arithmeticStart = arithmeticGrouping.indexOf('"total: "');
  assert.equal(
    getSafeQuickFix(
      arithmeticGrouping,
      "sample.ts",
      "prefer-template-literal",
      arithmeticStart,
      arithmeticGrouping.length - 1,
    )?.newText,
    "`total: ${(1 + 2)}`",
  );
  assert.equal(
    getSafeQuickFix(
      '"value: " + value',
      "sample.ts",
      "prefer-template-literal",
      0,
      '"value: " + value'.length,
    ),
    undefined,
  );

  const repeatedBranch =
    "if (ready) start(); else if (ready) stop(); else retry();";
  const repeatedConditionStart = repeatedBranch.lastIndexOf("ready");
  assert.deepEqual(
    getSafeQuickFix(
      repeatedBranch,
      "sample.ts",
      "repeated-branch-condition",
      repeatedConditionStart,
      repeatedConditionStart + "ready".length,
    ),
    {
      start: repeatedBranch.indexOf(" else"),
      end: repeatedBranch.length,
      newText: " else retry();",
      title: "Remove repeated else-if branch",
    },
  );
  const commentedBranch =
    "if (ready) start(); /* keep */ else if (ready) stop();";
  const commentedConditionStart = commentedBranch.lastIndexOf("ready");
  assert.equal(
    getSafeQuickFix(
      commentedBranch,
      "sample.ts",
      "repeated-branch-condition",
      commentedConditionStart,
      commentedConditionStart + "ready".length,
    ),
    undefined,
  );
});

test("safe quick-fix batches deduplicate fixes and reject overlaps", () => {
  const source = "const value = { item: item };\nconst copy = (value);";
  const findings = [
    {
      ruleId: "object-shorthand",
      start: source.indexOf("item: item"),
      end: source.indexOf("item: item") + "item: item".length,
    },
    {
      ruleId: "object-shorthand",
      start: source.indexOf("item: item"),
      end: source.indexOf("item: item") + "item: item".length,
    },
    {
      ruleId: "redundant-parentheses",
      start: source.indexOf("(value)"),
      end: source.indexOf("(value)") + "(value)".length,
    },
    {
      ruleId: "redundant-parentheses",
      start: source.indexOf("value);"),
      end: source.indexOf("value);") + "value".length,
    },
  ];
  const fixes = getSafeQuickFixes(source, "sample.ts", findings);
  assert.equal(fixes.length, 2);
  assert.deepEqual(
    fixes.map(({ title }) => title),
    ["Use object property shorthand", "Remove redundant parentheses"],
  );
});

test("safe quick fixes remove unused pure literal statements", () => {
  const source = "[1, 2];\nrun();";
  assert.deepEqual(
    getSafeQuickFix(
      source,
      "sample.ts",
      "redundant-expression",
      0,
      "[1, 2]".length,
    ),
    {
      start: 0,
      end: "[1, 2];\n".length,
      newText: "",
      title: "Remove redundant expression statement",
    },
  );
  const commented = "[1 /* keep */];";
  assert.equal(
    getSafeQuickFix(
      commented,
      "sample.ts",
      "redundant-expression",
      0,
      commented.length - 1,
    ),
    undefined,
  );
});
