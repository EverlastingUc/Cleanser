import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CONFIG_FILE, CONFIG_JSON_FILE, loadConfig } from "../src/config.js";

const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const configTemplatePath = fileURLToPath(
  new URL("../templates/cleanser.clns", import.meta.url),
);

function runCli(args, cwd, input, env = {}) {
  const childEnv = { ...process.env };
  for (const [name, value] of Object.entries(env)) {
    if (value === null) delete childEnv[name];
    else childEnv[name] = value;
  }
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
    env: childEnv,
    ...(input === undefined ? {} : { input }),
  });
}

function runGit(args, cwd) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function initializeGitProject(root, files) {
  runGit(["init", "--quiet"], root);
  runGit(["config", "user.name", "Cleanser Tests"], root);
  runGit(["config", "user.email", "cleanser-tests@example.invalid"], root);
  runGit(["add", "--", ...files], root);
  runGit(["commit", "--quiet", "-m", "initial"], root);
}

async function withTempProject(callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cleanser-cli-"));
  try {
    await callback(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("repository config matches the starter template", async () => {
  const projectConfigPath = fileURLToPath(
    new URL("../.cleanser.clns", import.meta.url),
  );
  const [projectConfig, template] = await Promise.all([
    fs.readFile(projectConfigPath, "utf8"),
    fs.readFile(configTemplatePath, "utf8"),
  ]);

  assert.equal(projectConfig, template);
});

test("shows general help when no command is supplied", () => {
  const result = runCli([], process.cwd());
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /cleanser init/);
});

test("prints the package version", async () => {
  const manifest = JSON.parse(
    await fs.readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const result = runCli(["--version"], process.cwd());
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), manifest.version);
});

test("shows command-specific help without running the command", async () => {
  await withTempProject(async (root) => {
    const result = runCli(["check", "--help"], root);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /without modifying/);
    await assert.rejects(fs.access(path.join(root, CONFIG_FILE)));
  });

  const watchHelp = runCli(["watch", "--help"], process.cwd());
  assert.equal(watchHelp.status, 0);
  assert.match(watchHelp.stdout, /watch \[--check\]/);

  const typecheckHelp = runCli(["typecheck", "--help"], process.cwd());
  assert.equal(typecheckHelp.status, 0);
  assert.match(typecheckHelp.stdout, /without emitting files/);
});

test("rejects unknown commands and unexpected arguments", () => {
  const unknown = runCli(["unknown"], process.cwd());
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown command: unknown/);

  const extra = runCli(["clean", "--force"], process.cwd());
  assert.equal(extra.status, 1);
  assert.match(extra.stderr, /Unexpected argument/);
});

test("graph command renders dependency, call, and control-flow views", async () => {
  await withTempProject(async (root) => {
    assert.equal(runCli(["init"], root).status, 0);
    await fs.writeFile(
      path.join(root, "index.ts"),
      [
        'import { value } from "./value.js"; console.log(value);',
        "export function showValue(flag) { if (flag) return readValue(); return value; }",
        "function readValue() { return value; }",
      ].join("\n"),
    );
    await fs.writeFile(path.join(root, "value.ts"), "export const value = 1;");

    const json = runCli(["graph", "--format=json"], root);
    assert.equal(json.status, 0);
    assert.deepEqual(JSON.parse(json.stdout).nodes, ["index.ts", "value.ts"]);
    assert.match(JSON.parse(json.stdout).edges[0].targetPath, /value\.ts$/);

    const mermaid = runCli(["graph", "--format=mermaid"], root);
    assert.equal(mermaid.status, 0);
    assert.match(mermaid.stdout, /^graph TD/);
    assert.match(mermaid.stdout, /file0 --> file1/);

    const tree = runCli(["graph"], root);
    assert.equal(tree.status, 0);
    assert.match(tree.stdout, /index\.ts\n  value\.ts/);

    const callgraph = runCli(["graph", "--format=callgraph"], root);
    assert.equal(callgraph.status, 0, callgraph.stderr);
    assert.match(callgraph.stdout, /^flowchart TD/);
    assert.match(callgraph.stdout, /showValue/);
    assert.match(callgraph.stdout, /readValue/);

    const controlFlow = runCli(["graph", "--format=cfg"], root);
    assert.equal(controlFlow.status, 0, controlFlow.stderr);
    assert.match(controlFlow.stdout, /^flowchart TD/);
    assert.match(controlFlow.stdout, /condition: flag/);
    assert.match(controlFlow.stdout, /\|true\|/);
    assert.match(controlFlow.stdout, /\|false\|/);
  });
});

test("explain command prints rule rationale without loading a project", () => {
  const result = runCli(["explain", "hardcoded-api-key"], process.cwd());
  assert.equal(result.status, 0);
  assert.match(result.stdout, /hardcoded-api-key \(warning\)/);
  assert.match(result.stdout, /credential-like value/);

  const unknown = runCli(["explain", "not-a-rule"], process.cwd());
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown rule/);
});

test("rules and explain commands show effective preset and rule severities", async () => {
  await withTempProject(async (root) => {
    assert.equal(runCli(["init"], root).status, 0);
    const configPath = path.join(root, CONFIG_FILE);
    const template = await fs.readFile(configPath, "utf8");
    const configured = template
      .replace(/\r\n/g, "\n")
      .replace(
        "preset: recommended\n    rules: {}",
        "preset: strict\n    rules:\n      redundant-return: info",
      );
    assert.notEqual(configured, template);
    await fs.writeFile(configPath, configured);

    const rules = runCli(["rules"], root);
    assert.equal(rules.status, 0);
    assert.match(rules.stdout, /empty-function\twarning/);
    assert.match(rules.stdout, /redundant-return\tinfo/);

    const explanation = runCli(["explain", "redundant-return"], root);
    assert.equal(explanation.status, 0);
    assert.match(explanation.stdout, /redundant-return \(info\)/);
  });
});

test("report command exports deterministic Markdown and CSV findings", async () => {
  await withTempProject(async (root) => {
    assert.equal(runCli(["init"], root).status, 0);
    await fs.writeFile(
      path.join(root, "sample.ts"),
      "export {};\nconst unused = 1;",
    );

    const markdown = runCli(["report"], root);
    assert.equal(markdown.status, 1);
    assert.match(markdown.stdout, /# Cleanser analysis report/);
    assert.match(markdown.stdout, /unused-constant/);

    const csv = runCli(["report", "--format=csv"], root);
    assert.equal(csv.status, 1);
    assert.match(
      csv.stdout,
      /"file","line","column","severity","rule","message"/,
    );
    assert.match(csv.stdout, /unused-constant/);
  });
});

test("report command exports SARIF 2.1.0 with stable rule and source locations", async () => {
  await withTempProject(async (root) => {
    assert.equal(runCli(["init"], root).status, 0);
    await fs.writeFile(
      path.join(root, "sample.ts"),
      "export {};\nconst unused = 1;",
    );

    const sarif = runCli(["report", "--format=sarif"], root);
    assert.equal(sarif.status, 1);
    const report = JSON.parse(sarif.stdout);
    assert.equal(report.version, "2.1.0");
    assert.match(report.$schema, /sarif-2\.1\.0\.json$/);
    assert.equal(report.runs.length, 1);
    assert.equal(report.runs[0].tool.driver.name, "Cleanser");
    const result = report.runs[0].results.find(
      (item) => item.ruleId === "unused-constant",
    );
    assert.ok(result);
    assert.equal(result.level, "warning");
    assert.equal(result.locations[0].physicalLocation.region.startLine, 2);
    assert.equal(
      result.locations[0].physicalLocation.artifactLocation.uri,
      "sample.ts",
    );
    assert.equal(
      report.runs[0].tool.driver.rules[result.ruleIndex].id,
      result.ruleId,
    );
  });
});

test("HTML reports escape source-controlled finding text", async () => {
  await withTempProject(async (root) => {
    assert.equal(runCli(["init"], root).status, 0);
    await fs.writeFile(
      path.join(root, "sample.ts"),
      'import first from "</td><script>alert(1)</script>";\n' +
        'import second from "</td><script>alert(1)</script>";\n' +
        "void first; void second;",
    );

    const html = runCli(["report", "--format=html"], root);
    assert.equal(html.status, 1);
    assert.match(html.stdout, /^<!doctype html>/);
    assert.match(html.stdout, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(html.stdout, /<script>alert\(1\)<\/script>/);
  });
});

test("security report contains only security rule findings", async () => {
  await withTempProject(async (root) => {
    assert.equal(runCli(["init"], root).status, 0);
    await fs.writeFile(
      path.join(root, "security.ts"),
      'export {};\neval("untrusted");\nconst unusedValue = 1;',
    );

    const result = runCli(["security", "--format=json"], root);
    assert.equal(result.status, 1);
    const findings = JSON.parse(result.stdout);
    assert.ok(findings.length > 0);
    assert.ok(
      findings.every((finding) =>
        /^(?:hardcoded-|private-key|suspicious-url|unsafe-|dangerous-shell|insecure-|weak-cryptography|sql-injection|xss-|path-traversal)/.test(
          finding.ruleId,
        ),
      ),
    );
    assert.ok(findings.some((finding) => finding.ruleId === "unsafe-eval"));
    assert.equal(
      findings.some((finding) => finding.ruleId === "unused-constant"),
      false,
    );
  });
});

test("format, doctor, and config commands provide safe project operations", async () => {
  await withTempProject(async (root) => {
    assert.equal(runCli(["init"], root).status, 0);
    const file = path.join(root, "sample.js");
    await fs.writeFile(file, "const value=1");

    const formatted = runCli(["format"], root);
    assert.equal(formatted.status, 0);
    assert.match(formatted.stdout, /CLEAN  sample\.js/);
    assert.notEqual(await fs.readFile(file, "utf8"), "const value=1");

    await fs.writeFile(file, "const nextValue=2");
    const fixed = runCli(["fix"], root);
    assert.equal(fixed.status, 0);
    assert.match(fixed.stdout, /CLEAN  sample\.js/);
    assert.notEqual(await fs.readFile(file, "utf8"), "const nextValue=2");

    const configuration = runCli(["config"], root);
    assert.equal(configuration.status, 0);
    assert.equal(
      JSON.parse(configuration.stdout).analysis.preset,
      "recommended",
    );

    const diagnosis = runCli(["doctor"], root);
    assert.equal(diagnosis.status, 0);
    assert.match(diagnosis.stdout, /Node\.js/);
    assert.match(diagnosis.stdout, /\.cleanser\.clns is valid/);
    assert.match(diagnosis.stdout, /0 file-specific override/);
    assert.match(diagnosis.stdout, /No \.editorconfig files found/);
  });
});

test("preview shows a unified formatting diff without writing or backing up files", async () => {
  await withTempProject(async (root) => {
    assert.equal(runCli(["init"], root).status, 0);
    const file = path.join(root, "sample.js");
    const original = "const value=1";
    await fs.writeFile(file, original);

    const result = runCli(["preview"], root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /--- a\/sample\.js/);
    assert.match(result.stdout, /-const value=1/);
    assert.match(result.stdout, /\+const value = 1;/);
    assert.equal(await fs.readFile(file, "utf8"), original);
    await assert.rejects(fs.access(path.join(root, ".cleanser-backups")));
  });
});

test("quiet clean and check keep their behavior and exit codes without success output", async () => {
  await withTempProject(async (root) => {
    assert.equal(runCli(["init"], root).status, 0);
    const file = path.join(root, "sample.js");
    const original = "const value=1";
    await fs.writeFile(file, original);

    const check = runCli(["check", "--quiet"], root);
    assert.equal(check.status, 1);
    assert.equal(check.stdout, "");
    assert.equal(await fs.readFile(file, "utf8"), original);

    const clean = runCli(["clean", "--quiet"], root);
    assert.equal(clean.status, 0);
    assert.equal(clean.stdout, "");
    assert.notEqual(await fs.readFile(file, "utf8"), original);
  });
});

test("verbose output explains verification and color output respects environment", async () => {
  await withTempProject(async (root) => {
    assert.equal(runCli(["init"], root).status, 0);
    const file = path.join(root, "sample.js");
    await fs.writeFile(file, "const value=1");

    const verbose = runCli(["clean", "--verbose"], root);
    assert.equal(verbose.status, 0, verbose.stderr);
    assert.match(verbose.stdout, /CLEAN  sample\.js/);
    assert.match(verbose.stdout, /risk=SAFE confidence=HIGH verification=/);

    await fs.writeFile(file, "const next=2");
    const colored = runCli(["clean"], root, undefined, {
      FORCE_COLOR: "1",
      NO_COLOR: null,
    });
    assert.equal(colored.status, 0, colored.stderr);
    assert.match(colored.stdout, /\u001b\[32mCLEAN\u001b\[0m/);

    await fs.writeFile(file, "const final=3");
    const plain = runCli(["clean"], root, undefined, {
      FORCE_COLOR: "1",
      NO_COLOR: "1",
    });
    assert.equal(plain.status, 0, plain.stderr);
    assert.doesNotMatch(plain.stdout, /\u001b\[/);

    const conflict = runCli(["clean", "--quiet", "--verbose"], root);
    assert.equal(conflict.status, 1);
    assert.match(conflict.stderr, /Unexpected argument/);
  });
});

test("audit command returns a read-only JSON cleanup report", async () => {
  await withTempProject(async (root) => {
    const file = path.join(root, "empty.txt");
    await fs.writeFile(file, "");

    const result = runCli(["audit", "--format=json"], root);
    assert.equal(result.status, 0);
    const report = JSON.parse(result.stdout);
    assert.equal(report.summary.fileCount, 1);
    assert.equal(report.findings[0].ruleId, "empty-file");
    assert.equal(await fs.readFile(file, "utf8"), "");
  });
});

test("metrics command reports deterministic JSON without editing source", async () => {
  await withTempProject(async (root) => {
    assert.equal(runCli(["init"], root).status, 0);
    const file = path.join(root, "src", "example.ts");
    await fs.mkdir(path.dirname(file), { recursive: true });
    const source =
      "export function branch(flag: boolean) { if (flag) return 1; return 0; }";
    await fs.writeFile(file, source);

    const result = runCli(["metrics", "--format=json"], root);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.summary.fileCount, 1);
    assert.equal(report.summary.functionCount, 1);
    assert.equal(report.files[0].metrics.functions[0].cyclomaticComplexity, 2);
    assert.equal(await fs.readFile(file, "utf8"), source);
  });
});

test("score command reports deterministic cleanup status without editing files", async () => {
  await withTempProject(async (root) => {
    assert.equal(runCli(["init"], root).status, 0);
    const file = path.join(root, "sample.js");
    const source = "export const answer=42";
    await fs.writeFile(file, source);

    const first = runCli(["score", "--format=json"], root);
    const second = runCli(["score", "--format=json"], root);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(JSON.parse(first.stdout), JSON.parse(second.stdout));
    assert.equal(JSON.parse(first.stdout).summary.filesNeedingFormatting, 1);
    assert.equal(await fs.readFile(file, "utf8"), source);
  });
});

test("verify command checks repeated formatter output without editing files", async () => {
  await withTempProject(async (root) => {
    assert.equal(runCli(["init"], root).status, 0);
    const file = path.join(root, "sample.js");
    const source = "const value=1";
    await fs.writeFile(file, source);

    const result = runCli(["verify", "--format=json"], root);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.summary, {
      filesScanned: 1,
      deterministic: 1,
      nondeterministic: 0,
      errors: 0,
    });
    assert.deepEqual(report.files, [
      { filePath: "sample.js", status: "deterministic" },
    ]);

    const compiler = runCli(["verify", "--compiler", "--format=json"], root);
    assert.equal(compiler.status, 0, compiler.stderr);
    const compilerReport = JSON.parse(compiler.stdout);
    assert.equal(compilerReport.summary.compilerFilesScanned, 1);
    assert.equal(compilerReport.summary.compilerMismatches, 0);
    assert.equal(compilerReport.files[0].compilerOutputEquivalent, true);
    assert.equal(await fs.readFile(file, "utf8"), source);
  });
});

test("clean --commit creates a dedicated commit containing only formatted tracked files", async () => {
  await withTempProject(async (root) => {
    assert.equal(runCli(["init"], root).status, 0);
    const samplePath = path.join(root, "sample.js");
    const otherPath = path.join(root, "other.js");
    await fs.writeFile(samplePath, "const value=1");
    await fs.writeFile(otherPath, "const other = 2;\n");
    initializeGitProject(root, [CONFIG_FILE, "sample.js", "other.js"]);

    const result = runCli(
      ["clean", "--commit", "--message=chore: cleanse"],
      root,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /COMMIT.*formatted file/);
    assert.equal(await fs.readFile(samplePath, "utf8"), "const value = 1;\n");
    assert.deepEqual(
      runGit(["show", "--pretty=format:", "--name-only", "HEAD"], root)
        .trim()
        .split(/\r?\n/u),
      ["sample.js"],
    );
    assert.equal(
      runGit(["show", "-s", "--format=%s", "HEAD"], root).trim(),
      "chore: cleanse",
    );
  });
});

test("clean --commit refuses a dirty Git tree before formatting", async () => {
  await withTempProject(async (root) => {
    assert.equal(runCli(["init"], root).status, 0);
    const samplePath = path.join(root, "sample.js");
    const source = "const value=1";
    await fs.writeFile(samplePath, source);
    initializeGitProject(root, [CONFIG_FILE, "sample.js"]);
    await fs.writeFile(samplePath, source + "\n// local change");
    const changedSource = await fs.readFile(samplePath, "utf8");

    const result = runCli(["clean", "--commit"], root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /requires a clean Git working tree/);
    assert.equal(await fs.readFile(samplePath, "utf8"), changedSource);
  });
});

test("snapshot command updates explicitly and detects formatted output changes", async () => {
  await withTempProject(async (root) => {
    assert.equal(runCli(["init"], root).status, 0);
    const file = path.join(root, "sample.js");
    await fs.writeFile(file, "const value=1");

    const updated = runCli(["snapshot", "--update"], root);
    assert.equal(updated.status, 0, updated.stderr);
    assert.match(updated.stdout, /Updated \.cleanser-snapshot\.json/);

    const matched = runCli(["snapshot", "--format=json"], root);
    assert.equal(matched.status, 0, matched.stderr);
    assert.equal(JSON.parse(matched.stdout).status, "matched");

    await fs.writeFile(file, "const value=2");
    const mismatch = runCli(["snapshot", "--format=json"], root);
    assert.equal(mismatch.status, 1);
    assert.equal(JSON.parse(mismatch.stdout).differences[0].status, "changed");
    assert.equal(await fs.readFile(file, "utf8"), "const value=2");
  });
});

test("configured Git working-tree protection blocks writes unless explicitly overridden", async () => {
  await withTempProject(async (root) => {
    const configPath = path.join(root, ".cleanser.clns");
    const projectConfig = (
      await fs.readFile(configTemplatePath, "utf8")
    ).replace(
      "require_clean_working_tree: false",
      "require_clean_working_tree: true",
    );
    await fs.writeFile(configPath, projectConfig);
    const initialized = spawnSync("git", ["init"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    });
    if (initialized.error?.code === "ENOENT") return;
    assert.equal(initialized.status, 0, initialized.stderr);
    await fs.writeFile(path.join(root, "sample.js"), "const value=1");

    const blocked = runCli(["clean"], root);
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /working-tree protection stopped formatting/i);
    assert.equal(
      await fs.readFile(path.join(root, "sample.js"), "utf8"),
      "const value=1",
    );

    const overridden = runCli(["clean", "--allow-dirty"], root);
    assert.equal(overridden.status, 0, overridden.stderr);
    assert.notEqual(
      await fs.readFile(path.join(root, "sample.js"), "utf8"),
      "const value=1",
    );
  });
});

test("hooks CLI installs and removes a managed Git hook", async (t) => {
  await withTempProject(async (root) => {
    const initialized = spawnSync("git", ["init"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    });
    if (initialized.error?.code === "ENOENT") {
      t.skip("Git is unavailable on this platform.");
      return;
    }
    assert.equal(initialized.status, 0, initialized.stderr);

    const installed = runCli(["hooks", "install", "pre-push"], root);
    assert.equal(installed.status, 0, installed.stderr);
    assert.match(installed.stdout, /Installed Cleanser pre-push hook/);

    const removed = runCli(["hooks", "uninstall", "pre-push"], root);
    assert.equal(removed.status, 0, removed.stderr);
    assert.match(removed.stdout, /Removed Cleanser pre-push hook/);
  });
});

test("CI CLI creates a Bitbucket starter without requiring a Cleanser config", async () => {
  await withTempProject(async (root) => {
    const created = runCli(["ci", "init", "bitbucket"], root);
    assert.equal(created.status, 0, created.stderr);
    assert.match(created.stdout, /Created bitbucket-pipelines\.yml/);
    assert.match(
      await fs.readFile(path.join(root, "bitbucket-pipelines.yml"), "utf8"),
      /npm test/,
    );
  });
});

test("ESLint CLI emits the installed project's JSON findings", async () => {
  await withTempProject(async (root) => {
    await fs.writeFile(path.join(root, "package.json"), "{}\n");
    const packageRoot = path.join(root, "node_modules", "eslint");
    await fs.mkdir(packageRoot, { recursive: true });
    await fs.writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ main: "index.cjs" }),
    );
    await fs.writeFile(
      path.join(packageRoot, "index.cjs"),
      [
        "class ESLint {",
        "  async lintFiles() { return [{ filePath: `${process.cwd()}/app.js`, errorCount: 0, warningCount: 1, messages: [{ ruleId: 'example-rule', severity: 1, line: 1, column: 1, message: 'example warning' }] }]; }",
        "}",
        "module.exports = { ESLint };",
        "",
      ].join("\n"),
    );

    const result = runCli(["eslint", "--format=json"], root);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.summary.warningCount, 1);
    assert.equal(report.files[0].filePath, "app.js");
  });
});

test("ast command inspects an included source file without executing or changing it", async () => {
  await withTempProject(async (root) => {
    assert.equal(runCli(["init"], root).status, 0);
    const file = path.join(root, "sample.ts");
    const source = "const answer = 42;";
    await fs.writeFile(file, source);

    const result = runCli(["ast", "sample.ts"], root);
    assert.equal(result.status, 0);
    const ast = JSON.parse(result.stdout);
    assert.equal(ast.filePath, "sample.ts");
    assert.equal(ast.tree.kind, "SourceFile");
    assert.deepEqual(ast.diagnostics, []);
    assert.equal(await fs.readFile(file, "utf8"), source);
  });
});

test("init creates a valid config and never overwrites it", async () => {
  await withTempProject(async (root) => {
    const first = runCli(["init"], root);
    assert.equal(first.status, 0);
    assert.match(first.stdout, /Created .cleanser.clns/);
    await loadConfig(root);

    const configPath = path.join(root, CONFIG_FILE);
    const original = await fs.readFile(configPath, "utf8");
    const template = await fs.readFile(configTemplatePath, "utf8");
    assert.equal(original, template);
    const second = runCli(["init"], root);
    assert.equal(second.status, 1);
    assert.match(second.stderr, /already exists/);
    assert.equal(await fs.readFile(configPath, "utf8"), original);
  });
});

test("init does not create a second config beside a JSON config", async () => {
  await withTempProject(async (root) => {
    const jsonPath = path.join(root, CONFIG_JSON_FILE);
    const original = '{"cleanser":{"enabled":true}}';
    await fs.writeFile(jsonPath, original);

    const result = runCli(["init"], root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /\.cleanser\.json already exists/);
    assert.equal(await fs.readFile(jsonPath, "utf8"), original);
    await assert.rejects(fs.access(path.join(root, CONFIG_FILE)));
  });
});

test("config migrate changes format without dropping validated settings", async () => {
  await withTempProject(async (root) => {
    assert.equal(runCli(["init"], root).status, 0);
    const before = JSON.parse(runCli(["config"], root).stdout);
    const migrated = runCli(["config", "migrate", "--to=json"], root);
    assert.equal(migrated.status, 0, migrated.stderr);
    assert.match(
      migrated.stdout,
      /Migrated \.cleanser\.clns to \.cleanser\.json/,
    );
    await assert.rejects(fs.access(path.join(root, ".cleanser.clns")));
    const after = JSON.parse(runCli(["config"], root).stdout);
    assert.deepEqual(after, before);
  });
});

test("check reports pending formatting and exits non-zero without editing", async () => {
  await withTempProject(async (root) => {
    assert.equal(runCli(["init"], root).status, 0);
    const file = path.join(root, "sample.js");
    const original = "const value=1";
    await fs.writeFile(file, original);

    const result = runCli(["check"], root);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /NEEDS  sample.js/);
    assert.match(result.stdout, /1 need formatting/);
    assert.equal(await fs.readFile(file, "utf8"), original);
    await assert.rejects(fs.access(path.join(root, ".cleanser-backups")));
  });
});

test("check exits non-zero when malformed source is skipped", async () => {
  await withTempProject(async (root) => {
    assert.equal(runCli(["init"], root).status, 0);
    const file = path.join(root, "broken.js");
    const original = "const = ;";
    await fs.writeFile(file, original);

    const result = runCli(["check"], root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /SKIP  broken.js/);
    assert.equal(await fs.readFile(file, "utf8"), original);
    await assert.rejects(fs.access(path.join(root, ".cleanser-backups")));
  });
});

test("strict CLI clean leaves every source file untouched on a syntax error", async () => {
  await withTempProject(async (root) => {
    assert.equal(runCli(["init"], root).status, 0);
    const configPath = path.join(root, CONFIG_FILE);
    const sourceConfig = await fs.readFile(configPath, "utf8");
    await fs.writeFile(
      configPath,
      sourceConfig.replace(
        "skip_on_syntax_error: true",
        "skip_on_syntax_error: false",
      ),
    );

    const valid = path.join(root, "a-valid.js");
    const broken = path.join(root, "z-broken.js");
    const validSource = "const value=1";
    const brokenSource = "const = ;";
    await fs.writeFile(valid, validSource);
    await fs.writeFile(broken, brokenSource);

    const result = runCli(["clean"], root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Could not format z-broken.js/);
    assert.equal(await fs.readFile(valid, "utf8"), validSource);
    assert.equal(await fs.readFile(broken, "utf8"), brokenSource);
    await assert.rejects(fs.access(path.join(root, ".cleanser-backups")));
  });
});

test("clean formats files and creates the original backup", async () => {
  await withTempProject(async (root) => {
    assert.equal(runCli(["init"], root).status, 0);
    const file = path.join(root, "sample.js");
    const original = "const value=1";
    await fs.writeFile(file, original);

    const result = runCli(["clean"], root);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /CLEAN  sample.js/);
    assert.notEqual(await fs.readFile(file, "utf8"), original);
    assert.equal(
      await fs.readFile(
        path.join(root, ".cleanser-backups", "sample.js"),
        "utf8",
      ),
      original,
    );
  });
});

test("interactive clean defaults to decline and writes only approved files", async () => {
  await withTempProject(async (root) => {
    assert.equal(runCli(["init"], root).status, 0);
    const first = path.join(root, "a.js");
    const second = path.join(root, "b.js");
    const originals = ["const first=1", "const second=2"];
    await fs.writeFile(first, originals[0]);
    await fs.writeFile(second, originals[1]);

    const result = runCli(["clean", "--interactive"], root, "yes\nno\n");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Approve \[SAFE\/HIGH\] a\.js\? \[y\/N\] yes/);
    assert.match(result.stdout, /Approve \[SAFE\/HIGH\] b\.js\? \[y\/N\] no/);
    assert.match(result.stdout, /CLEAN  a\.js/);
    assert.match(result.stdout, /NOPE  b\.js: change declined/);
    assert.notEqual(await fs.readFile(first, "utf8"), originals[0]);
    assert.equal(await fs.readFile(second, "utf8"), originals[1]);
    assert.equal(
      await fs.readFile(path.join(root, ".cleanser-backups", "a.js"), "utf8"),
      originals[0],
    );
    await assert.rejects(
      fs.access(path.join(root, ".cleanser-backups", "b.js")),
    );
  });
});

test("interactive clean with closed input safely declines every change", async () => {
  await withTempProject(async (root) => {
    assert.equal(runCli(["init"], root).status, 0);
    const file = path.join(root, "sample.js");
    const original = "const value=1";
    await fs.writeFile(file, original);

    const result = runCli(["clean", "--interactive"], root, "");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /NOPE  sample\.js: change declined/);
    assert.equal(await fs.readFile(file, "utf8"), original);
    await assert.rejects(fs.access(path.join(root, ".cleanser-backups")));
  });
});

test("clean change limit prevents the CLI from writing any file", async () => {
  await withTempProject(async (root) => {
    assert.equal(runCli(["init"], root).status, 0);
    const files = [path.join(root, "a.js"), path.join(root, "b.js")];
    const originals = ["const first=1", "const second=2"];
    await Promise.all(
      files.map((file, index) => fs.writeFile(file, originals[index])),
    );

    const result = runCli(["clean", "--max-files=1"], root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Change limits exceeded/);
    assert.deepEqual(
      await Promise.all(files.map((file) => fs.readFile(file, "utf8"))),
      originals,
    );
    await assert.rejects(fs.access(path.join(root, ".cleanser-backups")));
    await assert.rejects(fs.access(path.join(root, ".cleanser.lock")));
  });
});


test("init respects an active Cleanser project write lock", async () => {
  await withTempProject(async (root) => {
    await fs.writeFile(
      path.join(root, ".cleanser.lock"),
      JSON.stringify({ pid: 12345, startedAt: "test" }),
    );
    const result = runCli(["init"], root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Another Cleanser write operation holds/);
    await assert.rejects(fs.access(path.join(root, CONFIG_FILE)));
  });
});
