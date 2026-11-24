#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import {
  CONFIG_FILE,
  CONFIG_JSON_FILE,
  getConfigFile,
  loadConfig,
} from "./config.js";
import {
  cleanProject,
  withProjectWriteLock,
  collectProjectFiles,
  isIncludedPath,
  isSafeProjectFile,
  previewProject,
} from "./cleaner.js";
import { analyzeProject, listRules } from "./analyzer.js";
import { buildDependencyGraph } from "./dependency-graph.js";
import { inspectSourceAst } from "./ast-explorer.js";
import { auditProject } from "./project-audit.js";
import {
  assertCleanGitWorkingTree,
  commitCleanFiles,
  inspectGit,
  listChangedFiles,
} from "./git-tools.js";
import { listBackups, restoreBackup } from "./history.js";
import { startWatcher } from "./watcher.js";
import { typecheckProject } from "./typecheck.js";
import {
  reportProjectMetrics,
  renderCallGraph,
  renderControlFlowGraphs,
} from "./metrics.js";
import { reportCleanupScore } from "./score.js";
import { verifyDeterministicFormatting } from "./verification.js";
import { runFormatSnapshot } from "./snapshots.js";
import { manageGitHook } from "./hooks.js";
import { createCiConfig } from "./ci.js";
import { runEslint } from "./eslint.js";
import { startLanguageServer } from "./lsp.js";
import { startPlaygroundServer } from "./playground.js";
import { migrateConfigFormat } from "./config-migration.js";
import { createPullRequestReport } from "./pull-request-report.js";

const SECURITY_RULE =
  /^(?:hardcoded-api-key|hardcoded-password|private-key|suspicious-url|unsafe-eval|unsafe-dynamic-code|unsafe-deserialization|dangerous-shell-command|insecure-http|insecure-random|insecure-file-permissions|weak-cryptography|sql-injection-risk|xss-risk|path-traversal-risk)$/;

const { version: VERSION } = JSON.parse(
  await fs.readFile(new URL("../package.json", import.meta.url), "utf8"),
);

function supportsColor() {
  if (process.env.NO_COLOR !== undefined || process.env.FORCE_COLOR === "0") {
    return false;
  }
  return process.env.FORCE_COLOR !== undefined || process.stdout.isTTY;
}

function colorize(value, code) {
  return supportsColor() ? `\u001b[${code}m${value}\u001b[0m` : value;
}

function printStatus(label, message, code, stream = console.log) {
  stream(`${colorize(label, code)}  ${message}`);
}

function printVerboseResult(result) {
  if (!result.verificationMethod) return;
  console.log(
    `      risk=${result.risk} confidence=${result.confidence} verification=${result.verificationMethod}`,
  );
}

function printHelp(command) {
  if (command === "init") {
    console.log(`
Cleanser ${VERSION} — initialize a project.

Usage:
  cleanser init

Creates .cleanser.clns in the current directory.
An existing configuration is never overwritten.
`);
    return;
  }

  if (command === "clean" || command === "check" || command === "format") {
    console.log(`
Cleanser ${VERSION} — ${command === "clean" ? "format project files" : "check formatting"}.

Usage:
  cleanser ${command} [--changed] [--quiet] [--verbose]${command === "clean" ? " [--interactive] [--allow-dirty] [--commit] [--message=TEXT]" : ""} [--max-files=N] [--max-bytes=N]

${
  command === "clean" || command === "format"
    ? "Formats configured source and web/configuration files in the current project."
    : "Checks configured files without modifying them."
}
Use --changed to limit work to Git changed files.
${command === "clean" ? "Use --interactive to approve or decline each changed file before writing." : ""}
Use --quiet to hide successful file and summary output.
Use --verbose to include risk, confidence, and source-verification details.
Use --allow-dirty to override configured Git working-tree protection for this run.
${command === "clean" ? "Use --commit to create a dedicated commit for cleaned tracked files; it requires a clean Git tree before formatting. Set --message=TEXT to choose the one-line commit message." : ""}
Use --max-files=N and --max-bytes=N to cap a formatting batch.

Both commands require .cleanser.clns in the current directory.
`);
    return;
  }

  if (command === "preview") {
    console.log(
      [
        `Cleanser ${VERSION} — preview formatting changes without writing files.`,
        "",
        "Usage:",
        "  cleanser preview [--changed] [--verbose]",
      ].join("\n"),
    );
    return;
  }

  if (command === "watch") {
    console.log(
      [
        `Cleanser ${VERSION} — watch project files for formatting changes.`,
        "",
        "Usage:",
        "  cleanser watch [--check] [--quiet] [--verbose]",
        "",
        "Formatting uses the configured backup and atomic-write protections. Press Ctrl+C to stop.",
      ].join("\n"),
    );
    return;
  }

  if (command === "analyze") {
    console.log(`\nCleanser ${VERSION} — deterministic JS/TS analysis.

Usage:
  cleanser analyze [--format=json]

Reports rule findings without modifying source files. JSON output is stable and
includes file, rule, severity, message, and source location.
`);
    return;
  }

  if (command === "rules") {
    console.log(`\nCleanser ${VERSION} — list built-in analysis rules.

Usage:
  cleanser rules

Prints each rule ID, severity, and description.
`);
    return;
  }

  if (command === "graph") {
    console.log(
      [
        `Cleanser ${VERSION} — inspect local module dependencies.`,
        "",
        "Usage:",
        "  cleanser graph [--format=tree|mermaid|json|callgraph|cfg]",
        "",
        "Reads configured JavaScript and TypeScript files without changing them.",
      ].join("\n"),
    );
    return;
  }

  if (command === "explain") {
    console.log(
      [
        `Cleanser ${VERSION} — explain a built-in rule.`,
        "",
        "Usage:",
        "  cleanser explain <rule-id>",
        "",
        'Run "cleanser rules" to list available rule IDs.',
      ].join("\n"),
    );
    return;
  }

  if (command === "report") {
    console.log(
      [
        `Cleanser ${VERSION} — report project findings.`,
        "",
        "Usage:",
        "  cleanser report [--format=markdown|json|csv|html|sarif]",
        "",
        "Reports deterministic JS/TS findings without changing source files.",
      ].join("\n"),
    );
    return;
  }

  if (command === "pr-report") {
    console.log(
      [
        `Cleanser ${VERSION} — summarize formatting and findings against a Git base.`,
        "",
        "Usage:",
        "  cleanser pr-report --base=<branch-or-revision> [--format=markdown|json]",
        "",
        "Reads committed paths between the base and HEAD; it does not edit files or post to a hosting service.",
      ].join("\n"),
    );
    return;
  }

  if (command === "metrics") {
    console.log(
      [
        `Cleanser ${VERSION} — report deterministic JavaScript and TypeScript metrics.`,
        "",
        "Usage:",
        "  cleanser metrics [--format=json] [--changed]",
        "",
        "Reports per-file and per-function complexity, exact same-file duplication, dependencies, and a documented maintainability-index approximation.",
      ].join("\n"),
    );
    return;
  }

  if (command === "score") {
    console.log(
      [
        `Cleanser ${VERSION} — calculate a read-only cleanup score.`,
        "",
        "Usage:",
        "  cleanser score [--format=json] [--changed]",
        "",
        "Combines formatting debt with built-in JS/TS findings; it never edits files.",
      ].join("\n"),
    );
    return;
  }

  if (command === "verify") {
    console.log(
      [
        `Cleanser ${VERSION} — verify formatter output determinism.`,
        "",
        "Usage:",
        "  cleanser verify [--format=json] [--compiler]",
        "",
        "Formats each configured file twice in memory; --compiler also compares TypeScript-emitted JavaScript syntax trees for JS/TS files. No files are written.",
      ].join("\n"),
    );
    return;
  }

  if (command === "snapshot") {
    console.log(
      [
        `Cleanser ${VERSION} — compare formatted output with a saved snapshot.`,
        "",
        "Usage:",
        "  cleanser snapshot [--update] [--format=json]",
        "",
        "Use --update to create or refresh .cleanser-snapshot.json. The default command checks the snapshot without changing source files.",
      ].join("\n"),
    );
    return;
  }

  if (command === "hooks") {
    console.log(
      [
        `Cleanser ${VERSION} — manage optional Git formatting hooks.`,
        "",
        "Usage:",
        "  cleanser hooks install <pre-commit|pre-push>",
        "  cleanser hooks uninstall <pre-commit|pre-push>",
        "",
        "Hooks run read-only formatting checks and never stage or rewrite files.",
      ].join("\n"),
    );
    return;
  }

  if (command === "ci") {
    console.log(
      [
        `Cleanser ${VERSION} — create a CI starter configuration.`,
        "",
        "Usage:",
        "  cleanser ci init <gitlab|bitbucket>",
        "",
        "Generated files run the repository tests and Cleanser check command. Existing CI files are never overwritten.",
      ].join("\n"),
    );
    return;
  }

  if (command === "eslint") {
    console.log(
      [
        `Cleanser ${VERSION} — run the project's installed ESLint.`,
        "",
        "Usage:",
        "  cleanser eslint [--format=json]",
        "",
        "Runs ESLint locally without installing dependencies, changing files, or sending results to a service.",
      ].join("\n"),
    );
    return;
  }

  if (command === "lsp") {
    console.log(
      [
        `Cleanser ${VERSION} — start the Language Server Protocol formatter.`,
        "",
        "Usage:",
        "  cleanser lsp",
        "",
        "Connect an editor to this command with the project root as the LSP workspace. Formatting changes are checked for source equivalence before they are returned.",
      ].join("\n"),
    );
    return;
  }

  if (command === "playground") {
    console.log(
      [
        `Cleanser ${VERSION} — start the local formatting playground.`,
        "",
        "Usage:",
        "  cleanser playground [--port=N]",
        "",
        "Serves a loopback-only editor for JavaScript, TypeScript, JSON, CSS, HTML, YAML, and Markdown. Input is formatted in memory and project files are not changed.",
      ].join("\n"),
    );
    return;
  }

  if (command === "security") {
    console.log(
      [
        `Cleanser ${VERSION} — report security-focused code findings.`,
        "",
        "Usage:",
        "  cleanser security [--format=markdown|json|csv|html|sarif] [--changed]",
        "",
        "Runs local static checks and emits only security rule findings.",
      ].join("\n"),
    );
    return;
  }

  if (command === "doctor") {
    console.log(
      [
        `Cleanser ${VERSION} — inspect the current project setup.`,
        "",
        "Usage:",
        "  cleanser doctor",
        "",
        "Validates the project configuration and reports the supported file count.",
      ].join("\n"),
    );
    return;
  }

  if (command === "typecheck") {
    console.log(
      [
        `Cleanser ${VERSION} — run TypeScript project checks without emitting files.`,
        "",
        "Usage:",
        "  cleanser typecheck [--format=json]",
        "",
        "Reads tsconfig.json, reports TypeScript compiler diagnostics, and never emits project output.",
      ].join("\n"),
    );
    return;
  }

  if (command === "audit") {
    console.log(
      [
        `Cleanser ${VERSION} — inspect project files, npm dependencies, and cleanup candidates.`,
        "",
        "Usage:",
        "  cleanser audit [--format=json]",
        "",
        "Read-only scan for empty, temporary, backup, log, build, and duplicate configuration files.",
      ].join("\n"),
    );
    return;
  }

  if (command === "config") {
    console.log(
      [
        `Cleanser ${VERSION} — show the effective project configuration.`,
        "",
        "Usage:",
        "  cleanser config",
        "  cleanser config migrate --to=<clns|json>",
        "",
        "Prints the validated configuration and safe defaults as JSON. Migration converts between .cleanser.clns and .cleanser.json without discarding settings.",
      ].join("\n"),
    );
    return;
  }

  if (command === "ast") {
    console.log(
      [
        `Cleanser ${VERSION} — inspect a JavaScript or TypeScript AST.`,
        "",
        "Usage:",
        "  cleanser ast <file>",
        "",
        "Prints a bounded, deterministic syntax-tree view as JSON. Project code is not executed or changed.",
      ].join("\n"),
    );
    return;
  }

  if (command === "git") {
    console.log(
      [
        `Cleanser ${VERSION} — inspect Git data without changing the repository.`,
        "",
        "Usage:",
        "  cleanser git status",
        "  cleanser git changed [--staged]",
        "  cleanser git diff",
        "  cleanser git lines [--staged]",
        "  cleanser git conflicts",
        "  cleanser git compare <branch-or-revision>",
        "  cleanser git history <file>",
        "  cleanser git blame <file>",
      ].join("\n"),
    );
    return;
  }

  if (command === "history") {
    console.log(
      [
        `Cleanser ${VERSION} — list formatter backups.`,
        "",
        "Usage:",
        "  cleanser history",
        "",
        "Lists original file backups created by successful clean runs.",
      ].join("\n"),
    );
    return;
  }

  if (command === "restore") {
    console.log(
      [
        `Cleanser ${VERSION} — restore an original formatter backup.`,
        "",
        "Usage:",
        "  cleanser restore <file> --yes",
        "",
        "Restoration replaces the current file with its saved original backup.",
      ].join("\n"),
    );
    return;
  }

  console.log(`
Cleanser ${VERSION} — clean code, preserve intent.

Usage:
  cleanser init       Create a starter .cleanser.clns file
  cleanser clean      Format supported files in this project
  cleanser format     Alias for clean
  cleanser fix        Alias for clean
  cleanser check      Find files that need formatting (read-only)
  cleanser preview    Show formatting diffs without writing files
  cleanser watch      Format or check files when they change
  cleanser analyze    Report deterministic JS/TS code findings
  cleanser metrics    Report complexity, duplication, and maintainability metrics
  cleanser score      Report a read-only formatting and analysis score
  cleanser verify     Verify deterministic formatter output (read-only)
  cleanser snapshot   Check or update formatted output snapshots
  cleanser hooks      Install or remove Git formatting checks
  cleanser ci         Generate a GitLab or Bitbucket CI starter
  cleanser eslint     Run the locally installed ESLint (read-only)
  cleanser lsp        Start the Language Server Protocol formatter
  cleanser playground Open a local interactive formatting playground
  cleanser typecheck  Run TypeScript project checks without emitting files
  cleanser graph      Show local module dependencies
  cleanser explain    Explain one built-in rule
  cleanser report     Report project findings as Markdown, JSON, CSV, HTML, or SARIF
  cleanser pr-report  Summarize formatting and findings against a Git base
  cleanser security   Report security-focused static findings
  cleanser ast        Inspect a JavaScript or TypeScript syntax tree
  cleanser doctor     Validate project configuration and setup
  cleanser config     Show the effective project configuration
  cleanser audit      Inspect project files and dependencies (read-only)
  cleanser git        Inspect status, changes, diffs, history, and blame
  cleanser history    List original formatter backups
  cleanser restore    Restore a backed-up file with explicit confirmation
  cleanser undo       Alias for restore
  cleanser rules      List the built-in analysis rules
  cleanser --version  Print the installed version
  cleanser --help     Show help

Run "cleanser <command> --help" for command details.
`);
}

function parseArguments(args) {
  const [inputCommand = "help", ...options] = args;
  const command =
    inputCommand === "format" || inputCommand === "fix"
      ? "clean"
      : inputCommand === "undo"
        ? "restore"
        : inputCommand;
  const help = options.length === 1 && ["--help", "-h"].includes(options[0]);
  const supportedOptions =
    command === "clean" || command === "check"
      ? [
          "--changed",
          "--quiet",
          "--verbose",
          ...(command === "clean" ? ["--allow-dirty"] : []),
          ...(command === "clean" ? ["--interactive"] : []),
          ...(command === "clean" ? ["--commit"] : []),
        ]
      : command === "preview"
        ? ["--changed", "--verbose"]
        : command === "watch"
          ? ["--check", "--quiet"]
          : command === "verify"
            ? ["--format=json", "--compiler"]
            : command === "snapshot"
              ? ["--update", "--format=json"]
              : command === "hooks"
                ? []
                : command === "eslint"
                  ? ["--format=json"]
                  : command === "lsp"
                    ? []
                    : command === "playground"
                      ? []
                      : command === "config"
                        ? ["--to=clns", "--to=json"]
                        : command === "pr-report"
                          ? ["--format=json", "--format=markdown"]
                          : command === "analyze" ||
                              command === "metrics" ||
                              command === "score" ||
                              command === "report" ||
                              command === "security"
                            ? [
                                ...(command === "metrics" || command === "score"
                                  ? ["--format=json"]
                                  : [
                                      "--format=json",
                                      "--format=markdown",
                                      "--format=csv",
                                      "--format=html",
                                      "--format=sarif",
                                    ]),
                                "--changed",
                                ...(command === "analyze" ? ["--json"] : []),
                              ]
                            : command === "graph"
                              ? [
                                  "--format=tree",
                                  "--format=mermaid",
                                  "--format=json",
                                  "--format=callgraph",
                                  "--format=cfg",
                                ]
                              : command === "audit"
                                ? ["--format=json", "--json"]
                                : command === "typecheck"
                                  ? ["--format=json", "--json"]
                                  : [];
  const explainRule = command === "explain" && options.length === 1;
  const astFile = command === "ast" && options.length === 1;
  const gitAction = command === "git" ? options[0] : undefined;
  const gitValue = command === "git" ? options[1] : undefined;
  const gitArgumentsValid =
    command !== "git" ||
    (gitAction === "status" && options.length === 1) ||
    (gitAction === "changed" &&
      (options.length === 1 ||
        (options.length === 2 && gitValue === "--staged"))) ||
    (gitAction === "diff" && options.length === 1) ||
    (gitAction === "lines" &&
      (options.length === 1 ||
        (options.length === 2 && gitValue === "--staged"))) ||
    (gitAction === "conflicts" && options.length === 1) ||
    ((gitAction === "compare" ||
      gitAction === "history" ||
      gitAction === "blame") &&
      options.length === 2);
  const historyArgumentsValid = command !== "history" || options.length === 0;
  const restoreArgumentsValid =
    command !== "restore" ||
    options.length === 1 ||
    (options.length === 2 && options[1] === "--yes");
  const actionArgumentsValid =
    gitArgumentsValid && historyArgumentsValid && restoreArgumentsValid;
  const analysisOptionsValid =
    (command === "analyze" || command === "report" || command === "security") &&
    options.length <= 2 &&
    options.every((option) => supportedOptions.includes(option)) &&
    new Set(options).size === options.length &&
    options.filter((option) => option !== "--changed").length <= 1;
  const metricsOptionsValid =
    command === "metrics" &&
    options.length <= 2 &&
    options.every((option) => supportedOptions.includes(option)) &&
    new Set(options).size === options.length;
  const scoreOptionsValid =
    command === "score" &&
    options.length <= 2 &&
    options.every((option) => supportedOptions.includes(option)) &&
    new Set(options).size === options.length;
  const verifyOptionsValid =
    command === "verify" &&
    options.length <= 2 &&
    options.every((option) => supportedOptions.includes(option)) &&
    new Set(options).size === options.length;
  const pullRequestReportOptionsValid =
    command === "pr-report" &&
    options.length >= 1 &&
    options.length <= 2 &&
    options.every(
      (option) =>
        supportedOptions.includes(option) ||
        /^--base=[A-Za-z0-9][A-Za-z0-9._/-]*(?:[~^][0-9]*)?$/.test(option),
    ) &&
    options.filter((option) => option.startsWith("--base=")).length === 1 &&
    new Set(options).size === options.length;
  const basicOptionsValid =
    (command === "clean" || command === "check") &&
    options.length <= 9 &&
    !(options.includes("--quiet") && options.includes("--verbose")) &&
    !(
      options.includes("--commit") &&
      (options.includes("--allow-dirty") || options.includes("--changed"))
    ) &&
    !(
      options.some((option) => option.startsWith("--message=")) &&
      !options.includes("--commit")
    ) &&
    !options.some(
      (option) =>
        option.startsWith("--message=") &&
        !/(?=.*\S).{1,200}$/u.test(option.slice("--message=".length)),
    ) &&
    options.every(
      (option) =>
        supportedOptions.includes(option) ||
        /^--message=.{1,200}$/u.test(option) ||
        /^--max-(?:files|bytes)=\d+$/.test(option),
    ) &&
    new Set(options).size === options.length;
  const watchOptionsValid =
    command === "watch" &&
    options.length <= 3 &&
    !(options.includes("--quiet") && options.includes("--verbose")) &&
    options.every((option) => supportedOptions.includes(option)) &&
    new Set(options).size === options.length;
  const previewOptionsValid =
    command === "preview" &&
    options.length <= 2 &&
    options.every((option) => supportedOptions.includes(option)) &&
    new Set(options).size === options.length;
  const genericOptionsValid =
    ["git", "history", "restore"].includes(command) ||
    (options.length === 1 && supportedOptions.includes(options[0]));
  const snapshotOptionsValid =
    command === "snapshot" &&
    options.length <= 2 &&
    options.every((option) => supportedOptions.includes(option)) &&
    new Set(options).size === options.length;
  const hooksOptionsValid =
    command === "hooks" &&
    options.length === 2 &&
    ["install", "uninstall"].includes(options[0]) &&
    ["pre-commit", "pre-push"].includes(options[1]);
  const ciOptionsValid =
    command === "ci" &&
    options.length === 2 &&
    options[0] === "init" &&
    ["gitlab", "bitbucket"].includes(options[1]);
  const eslintOptionsValid =
    command === "eslint" &&
    options.length <= 1 &&
    options.every((option) => supportedOptions.includes(option));
  const lspOptionsValid = command === "lsp" && options.length === 0;
  const playgroundOptionsValid =
    command === "playground" &&
    options.length <= 1 &&
    options.every((option) => /^--port=\d+$/.test(option)) &&
    new Set(options).size === options.length &&
    (!options[0] || Number(options[0].slice("--port=".length)) <= 65535);
  const configMigrationValid =
    command === "config" &&
    options.length === 2 &&
    options[0] === "migrate" &&
    ["--to=clns", "--to=json"].includes(options[1]);
  const commandOptionsValid =
    actionArgumentsValid &&
    (command === "analyze" || command === "report" || command === "security"
      ? analysisOptionsValid
      : command === "metrics"
        ? metricsOptionsValid
        : command === "score"
          ? scoreOptionsValid
          : command === "verify"
            ? verifyOptionsValid
            : command === "pr-report"
              ? pullRequestReportOptionsValid
              : command === "snapshot"
                ? snapshotOptionsValid
                : command === "hooks"
                  ? hooksOptionsValid
                  : command === "ci"
                    ? ciOptionsValid
                    : command === "eslint"
                      ? eslintOptionsValid
                      : command === "lsp"
                        ? lspOptionsValid
                        : command === "playground"
                          ? playgroundOptionsValid
                          : command === "config"
                            ? options.length === 0 || configMigrationValid
                            : command === "clean" || command === "check"
                              ? basicOptionsValid
                              : command === "watch"
                                ? watchOptionsValid
                                : command === "preview"
                                  ? previewOptionsValid
                                  : genericOptionsValid);
  if (
    options.length > 0 &&
    !help &&
    !explainRule &&
    !astFile &&
    !commandOptionsValid
  ) {
    throw new Error(
      `Unexpected argument(s): ${options.join(" ")}. Run "cleanser --help".`,
    );
  }
  return {
    command,
    help,
    json: options.includes("--json") || options.includes("--format=json"),
    format: options
      .find((option) => option.startsWith("--format="))
      ?.replace("--format=", ""),
    changedOnly: options.includes("--changed"),
    verbose: options.includes("--verbose"),
    interactive: command === "clean" && options.includes("--interactive"),
    allowDirty: command === "clean" && options.includes("--allow-dirty"),
    commitCleanup: command === "clean" && options.includes("--commit"),
    commitMessage: options
      .find((option) => option.startsWith("--message="))
      ?.slice("--message=".length),
    updateSnapshot: command === "snapshot" && options.includes("--update"),
    compilerOutput: command === "verify" && options.includes("--compiler"),
    playgroundPort: options.some((option) => option.startsWith("--port="))
      ? Number(options.find((option) => option.startsWith("--port="))?.slice(7))
      : undefined,
    pullRequestBase: options
      .find((option) => option.startsWith("--base="))
      ?.slice("--base=".length),
    hookAction: command === "hooks" ? options[0] : undefined,
    hookName: command === "hooks" ? options[1] : undefined,
    ciProvider: command === "ci" ? options[1] : undefined,
    configMigrationTo:
      command === "config" && options[0] === "migrate"
        ? options[1]?.slice("--to=".length)
        : undefined,
    limits: {
      ...(options.some((option) => option.startsWith("--max-files="))
        ? {
            maxFiles: Number(
              options
                .find((option) => option.startsWith("--max-files="))
                ?.slice(12),
            ),
          }
        : {}),
      ...(options.some((option) => option.startsWith("--max-bytes="))
        ? {
            maxBytes: Number(
              options
                .find((option) => option.startsWith("--max-bytes="))
                ?.slice(12),
            ),
          }
        : {}),
    },
    watchCheckOnly: command === "watch" && options[0] === "--check",
    quiet: options.includes("--quiet"),
    ruleId: explainRule ? options[0] : undefined,
    filePath: astFile ? options[0] : undefined,
    gitAction,
    gitValue,
    restoreFile: command === "restore" ? options[0] : undefined,
    restoreConfirmed: command === "restore" && options[1] === "--yes",
  };
}

function renderFindings(findings, format, title = "Cleanser analysis report") {
  if (format === "json") return JSON.stringify(findings, null, 2);

  const headers = ["file", "line", "column", "severity", "rule", "message"];
  const rows = findings.map((finding) => [
    finding.filePath,
    finding.line,
    finding.column,
    finding.severity,
    finding.ruleId,
    finding.message,
  ]);

  if (format === "csv") {
    const encode = (value) => `"${String(value).replaceAll('"', '""')}"`;
    return [headers, ...rows]
      .map((row) => row.map(encode).join(","))
      .join("\n");
  }

  if (format === "sarif") {
    return renderSarif(findings);
  }

  if (format === "html") {
    const escapeHtml = (value) =>
      String(value).replace(/[&<>"']/g, (character) => {
        const entities = {
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        };
        return entities[character];
      });
    const body = rows
      .map(
        (row) =>
          `      <tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`,
      )
      .join("\n");
    const head = headers
      .map((header) => `<th scope="col">${header}</th>`)
      .join("");
    return [
      "<!doctype html>",
      '<html lang="en">',
      "  <head>",
      '    <meta charset="utf-8">',
      '    <meta name="viewport" content="width=device-width, initial-scale=1">',
      `    <title>${escapeHtml(title)}</title>`,
      "  </head>",
      "  <body>",
      "    <main>",
      `      <h1>${escapeHtml(title)}</h1>`,
      `      <p>Findings: ${findings.length}</p>`,
      "      <table><thead><tr>" + head + "</tr></thead><tbody>",
      body,
      "      </tbody></table>",
      "    </main>",
      "  </body>",
      "</html>",
    ].join("\n");
  }

  const escapeCell = (value) =>
    String(value).replaceAll("|", "\\|").replaceAll(/\r?\n/g, "<br>");
  const lines = [
    `# ${title}`,
    "",
    `Findings: ${findings.length}`,
    "",
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escapeCell).join(" | ")} |`),
  ];
  return lines.join("\n");
}

function renderSarif(findings) {
  const rules = listRules();
  const ruleIndexes = new Map(rules.map((rule, index) => [rule.id, index]));
  const level = (severity) =>
    severity === "error"
      ? "error"
      : severity === "warning"
        ? "warning"
        : "note";
  const projectRoot = pathToFileURL(`${process.cwd()}${path.sep}`).href;
  const results = findings.map((finding) => ({
    ruleId: finding.ruleId,
    ruleIndex: ruleIndexes.get(finding.ruleId),
    level: level(finding.severity),
    message: { text: finding.message },
    locations: [
      {
        physicalLocation: {
          artifactLocation: {
            uri: finding.filePath
              .split("/")
              .map((segment) => encodeURIComponent(segment))
              .join("/"),
            uriBaseId: "SRCROOT",
          },
          region: {
            startLine: finding.line,
            startColumn: finding.column,
          },
        },
      },
    ],
  }));

  return JSON.stringify(
    {
      $schema: "https://json.schemastore.org/sarif-2.1.0.json",
      version: "2.1.0",
      runs: [
        {
          tool: {
            driver: {
              name: "Cleanser",
              semanticVersion: VERSION,
              rules: rules.map((rule) => ({
                id: rule.id,
                shortDescription: { text: rule.description },
                defaultConfiguration: { level: level(rule.severity) },
              })),
            },
          },
          originalUriBaseIds: {
            SRCROOT: { uri: projectRoot },
          },
          results,
        },
      ],
    },
    null,
    2,
  );
}

async function loadOptionalConfig() {
  try {
    return await loadConfig();
  } catch (error) {
    if (error.message.startsWith(`Missing ${CONFIG_FILE}`)) return undefined;
    throw error;
  }
}

function renderDependencyGraph(graph, format) {
  if (format === "json") return JSON.stringify(graph, null, 2);

  if (format === "mermaid") {
    const identifiers = new Map(
      graph.nodes.map((node, index) => [node, `file${index}`]),
    );
    const lines = ["graph TD"];
    for (const node of graph.nodes) {
      const label = node.replaceAll('"', "&quot;");
      lines.push(`  ${identifiers.get(node)}["${label}"]`);
    }
    for (const edge of graph.edges) {
      if (edge.targetPath) {
        lines.push(
          `  ${identifiers.get(edge.sourcePath)} --> ${identifiers.get(edge.targetPath)}`,
        );
      }
    }
    return lines.join("\n");
  }

  const children = new Map(graph.nodes.map((node) => [node, new Set()]));
  const incoming = new Set();
  for (const edge of graph.edges) {
    if (!edge.targetPath) continue;
    children.get(edge.sourcePath).add(edge.targetPath);
    incoming.add(edge.targetPath);
  }

  const lines = [];
  const visited = new Set();
  function visit(node, depth, ancestors) {
    const indent = "  ".repeat(depth);
    if (ancestors.has(node)) {
      lines.push(`${indent}${node} (cycle)`);
      return;
    }
    if (visited.has(node)) {
      lines.push(`${indent}${node} (shared)`);
      return;
    }
    lines.push(`${indent}${node}`);
    visited.add(node);
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(node);
    for (const target of [...children.get(node)].sort()) {
      visit(target, depth + 1, nextAncestors);
    }
  }

  const roots = graph.nodes.filter((node) => !incoming.has(node));
  for (const node of [...roots, ...graph.nodes]) {
    if (!visited.has(node)) visit(node, 0, new Set());
  }
  return lines.length > 0
    ? lines.join("\n")
    : "No configured source files found.";
}

function createApprovalFlow() {
  const terminal = Boolean(process.stdin.isTTY);
  const prompt = createInterface({
    input: process.stdin,
    ...(terminal ? { output: process.stdout } : {}),
    terminal,
    crlfDelay: Infinity,
  });
  const answers = terminal ? undefined : prompt[Symbol.asyncIterator]();

  return {
    async approveChange({ filePath, risk, confidence }) {
      const relative = path.relative(process.cwd(), filePath);
      const question = `Approve [${risk}/${confidence}] ${relative}? [y/N] `;
      let answer;
      if (terminal) {
        answer = await prompt.question(question);
      } else {
        process.stdout.write(question);
        const next = await answers.next();
        answer = next.done ? "" : next.value;
        process.stdout.write(`${answer}\n`);
      }
      return /^y(?:es)?$/i.test(answer.trim());
    },
    close() {
      prompt.close();
    },
  };
}

async function init() {
  return withProjectWriteLock(process.cwd(), async () => {
    const target = path.join(process.cwd(), CONFIG_FILE);
    const jsonTarget = path.join(process.cwd(), CONFIG_JSON_FILE);
    try {
      await fs.lstat(jsonTarget);
      throw new Error(
        CONFIG_JSON_FILE +
          " already exists. It was not changed and no YAML config was created.",
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const template = await fs.readFile(
      new URL("../templates/cleanser.clns", import.meta.url),
      "utf8",
    );

    let handle;
    let targetCreated = false;
    try {
      handle = await fs.open(target, "wx");
      targetCreated = true;
      await handle.writeFile(template, "utf8");
      await handle.sync();
      await handle.close();
    } catch (error) {
      await handle?.close().catch(() => {});
      if (targetCreated) {
        await fs.rm(target, { force: true }).catch(() => {});
      }
      if (error.code === "EEXIST") {
        throw new Error(CONFIG_FILE + " already exists. It was not changed.");
      }
      throw new Error(
        `Could not create ${CONFIG_FILE}: ${error.message}`,
        { cause: error },
      );
    }

    console.log("Created " + CONFIG_FILE);
  });
}

async function run() {
  let parsed;
  try {
    parsed = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(`Cleanser: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const { command: requestedCommand, help } = parsed;
  const helpCommand =
    requestedCommand === "format" ? "clean" : requestedCommand;
  if (
    help ||
    requestedCommand === "help" ||
    requestedCommand === "--help" ||
    requestedCommand === "-h"
  ) {
    printHelp(help ? helpCommand : undefined);
    return;
  }
  const command = requestedCommand === "format" ? "clean" : requestedCommand;
  if (command === "git" && !parsed.gitAction) {
    printHelp("git");
    return;
  }
  if (command === "--version" || command === "-v") {
    console.log(VERSION);
    return;
  }
  if (command === "init") {
    await init();
    return;
  }
  if (command === "config") {
    if (parsed.configMigrationTo) {
      const result = await migrateConfigFormat({
        root: process.cwd(),
        to: parsed.configMigrationTo,
      });
      console.log(`Migrated ${result.from} to ${result.to}.`);
      return;
    }
    const config = await loadConfig();
    console.log(JSON.stringify(config, null, 2));
    return;
  }
  if (command === "doctor") {
    const config = await loadConfig();
    const files = await collectProjectFiles(process.cwd(), config);
    const majorVersion = Number(process.versions.node.split(".")[0]);
    if (majorVersion < 20) {
      console.error(
        `Node.js ${process.versions.node} is unsupported; Cleanser requires Node.js 20 or newer.`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(`OK    Node.js ${process.versions.node}`);
    console.log(
      `OK    ${await getConfigFile()} is valid (${config.analysis.preset} preset)`,
    );
    console.log(`OK    ${files.length} supported project file(s)`);
    console.log(`OK    ${config.overrides.length} file-specific override(s)`);
    if (config._editorConfigs.length === 0) {
      console.log("INFO  No .editorconfig files found.");
    } else {
      for (const entry of config._editorConfigs) {
        const editorConfigPath = path
          .relative(process.cwd(), path.join(entry.directory, ".editorconfig"))
          .split(path.sep)
          .join("/");
        console.log(`OK    EditorConfig ${editorConfigPath}`);
      }
    }
    return;
  }
  if (command === "audit") {
    const result = await auditProject();
    if (parsed.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    for (const item of result.findings) {
      console.log(`${item.filePath} ${item.ruleId} ${item.message}`);
    }
    console.log(
      `\nScanned ${result.summary.fileCount} file(s) in ${result.summary.directoryCount} directory(s); ${result.findings.length} finding(s).`,
    );
    return;
  }
  if (command === "typecheck") {
    const result = await typecheckProject();
    if (parsed.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (!result.configured) {
      console.log("No tsconfig.json found; TypeScript checking was skipped.");
    } else if (result.diagnostics.length === 0) {
      console.log(`OK    TypeScript checked ${result.fileCount} file(s).`);
    } else {
      for (const diagnostic of result.diagnostics) {
        const location = diagnostic.filePath
          ? `${diagnostic.filePath}:${diagnostic.line}:${diagnostic.column}`
          : "tsconfig.json";
        console.log(
          `${location} ${diagnostic.category} TS${diagnostic.code} ${diagnostic.message}`,
        );
      }
      console.log(
        `\nFound ${result.diagnostics.length} TypeScript diagnostic(s).`,
      );
    }
    if (
      result.diagnostics.some((diagnostic) => diagnostic.category === "error")
    ) {
      process.exitCode = 1;
    }
    return;
  }
  if (command === "metrics") {
    const config = await loadConfig();
    const changedFiles = parsed.changedOnly
      ? await listChangedFiles({ root: process.cwd() })
      : undefined;
    const result = await reportProjectMetrics({ config, changedFiles });
    if (parsed.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      for (const file of result.files) {
        if (file.error) {
          console.error(`${file.filePath} ERROR ${file.error}`);
          continue;
        }
        const metrics = file.metrics;
        console.log(
          `${file.filePath} functions=${metrics.functionCount} classes=${metrics.classCount} cyclomatic=${metrics.cyclomaticComplexity} cognitive=${metrics.cognitiveComplexity} dependencies=${metrics.dependencyCount} duplication=${metrics.duplication.percentage.toFixed(2)}% MI=${metrics.maintainabilityIndex.toFixed(2)}`,
        );
        for (const fn of metrics.functions) {
          console.log(
            `  ${fn.startLine} ${fn.name} cyclomatic=${fn.cyclomaticComplexity} cognitive=${fn.cognitiveComplexity} nesting=${fn.maximumNestingDepth} lines=${fn.lineCount} parameters=${fn.parameterCount}`,
          );
        }
      }
      const summary = result.summary;
      console.log(
        `\nScanned ${summary.fileCount} file(s); analyzed ${summary.analyzedFileCount}; ${summary.functionCount} function(s); ${summary.variableCount} variable binding(s); average lexical lifetime ${summary.averageVariableLifetimeLines} line(s); health ${summary.codeHealthScore}; average maintainability ${summary.averageMaintainabilityIndex}; duplication ${summary.duplicationPercentage}%.`,
      );
    }
    if (result.summary.parseErrorCount > 0) process.exitCode = 1;
    return;
  }
  if (command === "score") {
    const config = await loadConfig();
    const changedFiles = parsed.changedOnly
      ? await listChangedFiles({ root: process.cwd() })
      : undefined;
    const result = await reportCleanupScore({ config, changedFiles });
    if (parsed.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Cleanser cleanup score: ${result.summary.score}/100`);
      console.log(
        `Formatting ${result.summary.formattingScore}/100; ${result.summary.filesNeedingFormatting}/${result.summary.filesScanned} file(s) need formatting; ${result.summary.findings} analyzer finding(s) (errors ${result.summary.findingsBySeverity.error}, warnings ${result.summary.findingsBySeverity.warning}, info ${result.summary.findingsBySeverity.info}); ${result.summary.skippedFiles} skipped.`,
      );
    }
    return;
  }
  if (command === "verify") {
    const config = await loadConfig();
    const result = await verifyDeterministicFormatting({
      config,
      compilerOutput: parsed.compilerOutput,
    });
    if (parsed.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      for (const item of result.files) {
        const detail = item.error ? `: ${item.error}` : "";
        const label =
          item.status === "deterministic"
            ? "OK"
            : item.status === "nondeterministic" ||
                item.status === "compiler-output-mismatch"
              ? "MISMATCH"
              : "ERROR";
        console.log(`${label}  ${item.filePath}${detail}`);
      }
      console.log(
        `\nVerified ${result.summary.filesScanned} file(s); ${result.summary.deterministic} deterministic; ${result.summary.nondeterministic} formatting mismatch(es); ${result.summary.errors} error(s)${parsed.compilerOutput ? `; compiler output checked for ${result.summary.compilerFilesScanned} file(s) with ${result.summary.compilerMismatches} mismatch(es)` : ""}.`,
      );
    }
    if (
      result.summary.nondeterministic > 0 ||
      result.summary.errors > 0 ||
      (result.summary.compilerMismatches ?? 0) > 0
    ) {
      process.exitCode = 1;
    }
    return;
  }
  if (command === "snapshot") {
    const config = await loadConfig();
    const result = await runFormatSnapshot({
      config,
      update: parsed.updateSnapshot,
    });
    if (parsed.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.status === "updated") {
      console.log(
        `Updated ${result.snapshotFile} with ${result.summary.files} formatted file(s).`,
      );
    } else if (result.status === "missing") {
      console.error(
        `Missing ${result.snapshotFile}; run "cleanser snapshot --update" to create it.`,
      );
    } else if (result.status === "matched") {
      console.log(
        `Snapshot matched ${result.summary.files} formatted file(s).`,
      );
    } else {
      for (const difference of result.differences) {
        console.log(
          `${difference.status.toUpperCase()}  ${difference.filePath}`,
        );
      }
      console.log(
        `\nSnapshot mismatch: ${result.summary.differences} difference(s). Run "cleanser snapshot --update" to accept the current output.`,
      );
    }
    if (result.status === "missing" || result.status === "mismatch") {
      process.exitCode = 1;
    }
    return;
  }
  if (command === "hooks") {
    const result = await manageGitHook({
      root: process.cwd(),
      action: parsed.hookAction,
      name: parsed.hookName,
    });
    console.log(
      result.status === "installed"
        ? `Installed Cleanser ${result.name} hook.`
        : result.status === "uninstalled"
          ? `Removed Cleanser ${result.name} hook.`
          : `No Cleanser ${result.name} hook was installed.`,
    );
    return;
  }
  if (command === "ci") {
    const result = await createCiConfig({
      root: process.cwd(),
      provider: parsed.ciProvider,
    });
    console.log(`Created ${result.filePath} for ${result.provider}.`);
    return;
  }
  if (command === "eslint") {
    const result = await runEslint({ root: process.cwd() });
    if (parsed.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      for (const file of result.files) {
        for (const finding of file.messages) {
          console.log(
            `${file.filePath}:${finding.line}:${finding.column} ${finding.severity} ${finding.ruleId} ${finding.message}`,
          );
        }
      }
      console.log(
        `\nESLint scanned ${result.summary.filesScanned} file(s); ${result.summary.errorCount} error(s); ${result.summary.warningCount} warning(s).`,
      );
    }
    if (result.summary.errorCount > 0) process.exitCode = 1;
    return;
  }
  if (command === "lsp") {
    startLanguageServer();
    return;
  }
  if (command === "playground") {
    const playground = await startPlaygroundServer({
      root: process.cwd(),
      port: parsed.playgroundPort ?? 0,
    });
    console.log(
      `Cleanser playground is running at ${playground.url} (loopback only). Press Ctrl+C to stop.`,
    );
    await new Promise((resolve) => playground.server.once("close", resolve));
    return;
  }
  if (command === "rules") {
    const config = await loadOptionalConfig();
    for (const rule of listRules()) {
      const severity = config?.analysis.rules[rule.id] ?? rule.severity;
      console.log(`${rule.id}\t${severity}\t${rule.description}`);
    }
    return;
  }
  if (command === "explain") {
    if (!parsed.ruleId) {
      printHelp("explain");
      return;
    }
    const rule = listRules().find(
      (candidate) => candidate.id === parsed.ruleId,
    );
    if (!rule) {
      console.error(`Unknown rule: ${parsed.ruleId}. Run "cleanser rules".`);
      process.exitCode = 1;
      return;
    }
    const config = await loadOptionalConfig();
    const severity = config?.analysis.rules[rule.id] ?? rule.severity;
    console.log(`${rule.id} (${severity})\n${rule.description}`);
    return;
  }
  if (command === "graph") {
    const config = await loadConfig();
    if (parsed.format === "callgraph") {
      const metrics = await reportProjectMetrics({ config });
      console.log(renderCallGraph(metrics));
    } else if (parsed.format === "cfg") {
      const metrics = await reportProjectMetrics({ config });
      console.log(renderControlFlowGraphs(metrics));
    } else {
      const graph = await buildDependencyGraph({ config });
      console.log(renderDependencyGraph(graph, parsed.format ?? "tree"));
    }
    return;
  }
  if (command === "ast") {
    if (!parsed.filePath) {
      printHelp("ast");
      return;
    }
    const config = await loadConfig();
    const root = process.cwd();
    const absoluteFile = path.resolve(root, parsed.filePath);
    const relativeFile = path.relative(root, absoluteFile);
    if (
      relativeFile === ".." ||
      relativeFile.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeFile) ||
      !isIncludedPath(relativeFile, config) ||
      !(await isSafeProjectFile(root, absoluteFile))
    ) {
      throw new Error(
        "AST Explorer file must be an included regular project file.",
      );
    }
    const source = await fs.readFile(absoluteFile, "utf8");
    console.log(
      JSON.stringify(inspectSourceAst(source, relativeFile), null, 2),
    );
    return;
  }
  if (command === "preview") {
    const config = await loadConfig();
    const changedFiles = parsed.changedOnly
      ? await listChangedFiles({ root: process.cwd() })
      : undefined;
    const results = await previewProject({ config, changedFiles });
    let changed = 0;
    let skipped = 0;
    for (const result of results) {
      if (result.status === "changed") {
        changed++;
        printStatus(
          `[${result.risk}/${result.confidence}]`,
          result.filePath,
          "36",
        );
        if (parsed.verbose) printVerboseResult(result);
        console.log(result.diff);
      } else if (result.status === "unsafe") {
        skipped++;
        printStatus(
          "REVIEW",
          `${result.filePath}: AST equivalence failed: ${result.verificationDifference}`,
          "31",
          console.error,
        );
        console.log(result.diff);
      } else if (result.status === "skipped") {
        skipped++;
        printStatus(
          "SKIP",
          `${result.filePath}: ${result.reason.split("\n")[0]}`,
          "33",
          console.error,
        );
      }
    }
    if (changed === 0) console.log("No formatting changes to preview.");
    console.log(
      `\nPreviewed ${results.length} file(s); ${changed} change(s); ${skipped} skipped.`,
    );
    if (skipped > 0) process.exitCode = 1;
    return;
  }
  if (command === "watch") {
    const config = await loadConfig();
    const watcher = startWatcher({
      config,
      checkOnly: parsed.watchCheckOnly,
      onEvent(event) {
        if (parsed.quiet && !["error", "skipped"].includes(event.type)) return;
        if (event.type === "config-reloaded") {
          printStatus(
            "CONFIG",
            `${event.configFile ?? CONFIG_FILE} reloaded`,
            "36",
          );
        } else if (event.filePath) {
          const prefix =
            event.type === "formatted"
              ? "CLEAN"
              : event.type === "needs-formatting"
                ? "NEEDS"
                : event.type === "skipped"
                  ? "SKIP"
                  : "ERROR";
          const colorCode =
            event.type === "formatted"
              ? "32"
              : event.type === "needs-formatting" || event.type === "skipped"
                ? "33"
                : "31";
          printStatus(
            prefix,
            `${event.filePath}${event.message ? `: ${event.message}` : ""}`,
            colorCode,
            event.type === "error" ? console.error : console.log,
          );
        } else if (event.message) {
          console.error(colorize(`Cleanser watch: ${event.message}`, "31"));
        }
      },
    });
    if (!parsed.quiet) {
      console.log(
        parsed.watchCheckOnly
          ? "Watching configured files; changes will be checked without writing. Press Ctrl+C to stop."
          : "Watching configured files; changes will be formatted safely. Press Ctrl+C to stop.",
      );
    }
    const stop = () => watcher.close();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    await watcher.closed;
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    return;
  }
  if (command === "git") {
    console.log(
      await inspectGit({
        root: process.cwd(),
        action: parsed.gitAction,
        value: parsed.gitValue,
      }),
    );
    return;
  }
  if (command === "pr-report") {
    const config = await loadConfig();
    const result = await createPullRequestReport({
      root: process.cwd(),
      config,
      base: parsed.pullRequestBase,
    });
    console.log(
      parsed.json ? JSON.stringify(result, null, 2) : result.markdown,
    );
    return;
  }
  if (command === "history") {
    const backups = await listBackups();
    console.log(
      backups.length > 0
        ? backups.join("\n")
        : "No Cleanser backups are available.",
    );
    return;
  }
  if (command === "restore") {
    if (!parsed.restoreConfirmed) {
      throw new Error(
        'Restore replaces a file. Re-run with "--yes" to confirm.',
      );
    }
    const restored = await restoreBackup({ filePath: parsed.restoreFile });
    console.log(`RESTORED  ${restored.filePath}`);
    return;
  }
  if (command === "analyze" || command === "report" || command === "security") {
    const config = await loadConfig();
    const changedFiles = parsed.changedOnly
      ? await listChangedFiles({ root: process.cwd() })
      : undefined;
    const allFindings = await analyzeProject({ config, changedFiles });
    const findings =
      command === "security"
        ? allFindings.filter((finding) => SECURITY_RULE.test(finding.ruleId))
        : allFindings;
    const format = parsed.json
      ? "json"
      : (parsed.format ??
        (command === "report" || command === "security" ? "markdown" : "text"));
    if (format === "text") {
      for (const finding of findings) {
        console.log(
          `${finding.filePath}:${finding.line}:${finding.column} ${finding.severity} ${finding.ruleId} ${finding.message}`,
        );
      }
      console.log(`\nFound ${findings.length} finding(s).`);
    } else {
      console.log(
        renderFindings(
          findings,
          format,
          command === "security"
            ? "Cleanser security report"
            : "Cleanser analysis report",
        ),
      );
    }
    if (
      findings.some(
        (finding) =>
          finding.severity === "warning" || finding.severity === "error",
      )
    ) {
      process.exitCode = 1;
    }
    return;
  }
  if (command !== "clean" && command !== "check") {
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exitCode = 1;
    return;
  }

  const config = await loadConfig();
  if (parsed.commitCleanup) {
    await assertCleanGitWorkingTree({ root: process.cwd() });
  }
  const changedFiles = parsed.changedOnly
    ? await listChangedFiles({ root: process.cwd() })
    : undefined;
  const approvalFlow = parsed.interactive ? createApprovalFlow() : undefined;
  let progressDisplayed = false;
  const showProgress = process.stdout.isTTY && !parsed.quiet;
  const controller = new AbortController();
  const cancel = () => {
    controller.abort();
    approvalFlow?.close();
  };
  let results;
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    results = await cleanProject({
      config,
      write: command === "clean",
      allowDirty: parsed.allowDirty,
      changedFiles,
      limits: parsed.limits,
      signal: controller.signal,
      approveChange: approvalFlow?.approveChange,
      onProgress: showProgress
        ? ({ completed, total }) => {
            progressDisplayed = true;
            const verb = command === "clean" ? "Formatting" : "Checking";
            process.stdout.write(`\r${verb} ${completed}/${total} file(s)...`);
          }
        : undefined,
    });
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
    approvalFlow?.close();
    if (progressDisplayed) process.stdout.write("\r\u001b[2K");
  }
  if (parsed.commitCleanup) {
    const files = results
      .filter((result) => result.status === "cleaned")
      .map((result) =>
        path.relative(process.cwd(), result.filePath).split(path.sep).join("/"),
      );
    if (files.length > 0) {
      const commit = await commitCleanFiles({
        root: process.cwd(),
        files,
        message: parsed.commitMessage ?? "chore: apply Cleanser formatting",
      });
      if (!parsed.quiet) {
        printStatus(
          "COMMIT",
          `${commit.commit}: ${commit.files.length} formatted file(s) committed.`,
          "32",
        );
      }
    } else if (!parsed.quiet) {
      printStatus(
        "OK",
        "No files needed formatting; no commit was created.",
        "32",
      );
    }
  }
  let changed = 0;
  let skipped = 0;

  for (const result of results) {
    const name = path.relative(process.cwd(), result.filePath);
    if (result.status === "skipped") {
      skipped++;
      printStatus(
        "SKIP",
        `${name}: ${result.reason.split("\n")[0]}`,
        "33",
        console.error,
      );
    } else if (result.status === "not-approved") {
      skipped++;
      if (!parsed.quiet) printStatus("NOPE", `${name}: change declined`, "33");
    } else if (result.status === "unchanged") {
      if (!parsed.quiet) printStatus("OK", name, "32");
    } else {
      changed++;
      if (!parsed.quiet) {
        printStatus(
          command === "clean" ? "CLEAN" : "NEEDS",
          name,
          command === "clean" ? "32" : "33",
        );
        if (parsed.verbose) printVerboseResult(result);
      }
    }
  }

  const action = command === "clean" ? "formatted" : "need formatting";
  if (!parsed.quiet) {
    console.log(
      `\nScanned ${results.length} file(s); ${changed} ${action}; ${skipped} skipped.`,
    );
  }
  if (command === "check" && (changed > 0 || skipped > 0)) process.exitCode = 1;
}

run().catch((error) => {
  console.error(`Cleanser: ${error.message}`);
  process.exitCode = 1;
});
