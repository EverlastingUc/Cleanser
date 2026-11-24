"use strict";

const vscode = require("vscode");
const { randomUUID } = require("node:crypto");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const activeDocuments = new Set();
let output;

async function loadCleanserModules(context) {
  const root = path.resolve(context.extensionPath);
  const configUrl = pathToFileURL(path.join(root, "src", "config.js")).href;
  const cleanerUrl = pathToFileURL(path.join(root, "src", "cleaner.js")).href;
  const analyzerUrl = pathToFileURL(path.join(root, "src", "analyzer.js")).href;
  const [configModule, cleanerModule, analyzerModule] = await Promise.all([
    import(configUrl),
    import(cleanerUrl),
    import(analyzerUrl),
  ]);
  return {
    loadConfig: configModule.loadConfig,
    cleanProject: cleanerModule.cleanProject,
    formatSource: cleanerModule.formatSource,
    compareAstEquivalence: cleanerModule.compareAstEquivalence,
    createBackup: cleanerModule.createBackup,
    isIncludedPath: cleanerModule.isIncludedPath,
    isSafeProjectFile: cleanerModule.isSafeProjectFile,
    resolveFileConfig: cleanerModule.resolveFileConfig,
    analyzeProject: analyzerModule.analyzeProject,
    listRules: analyzerModule.listRules,
    getSafeQuickFix: analyzerModule.getSafeQuickFix,
    getSafeQuickFixes: analyzerModule.getSafeQuickFixes,
  };
}

function changedSpan(original, formatted) {
  let start = 0;
  const limit = Math.min(original.length, formatted.length);
  while (start < limit && original[start] === formatted[start]) start++;
  if (
    start > 0 &&
    /[\uD800-\uDBFF]/u.test(original[start - 1]) &&
    /[\uDC00-\uDFFF]/u.test(original[start] ?? "")
  ) {
    start--;
  }
  let suffix = 0;
  while (
    suffix < original.length - start &&
    suffix < formatted.length - start &&
    original[original.length - suffix - 1] ===
      formatted[formatted.length - suffix - 1]
  ) {
    suffix++;
  }
  return {
    start,
    end: original.length - suffix,
    newText: formatted.slice(start, formatted.length - suffix),
  };
}

async function formatRange(document, range, modules) {
  if (document.uri.scheme !== "file" || !isSupported(document) || !range) {
    return [];
  }
  const workspace = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!workspace) return [];
  const relative = path.relative(workspace.uri.fsPath, document.fileName);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    !(await modules.isSafeProjectFile(workspace.uri.fsPath, document.fileName))
  ) {
    return [];
  }
  const normalized = relative.split(path.sep).join("/");
  const config = await modules.loadConfig(workspace.uri.fsPath);
  if (!config.enabled || !modules.isIncludedPath(normalized, config)) return [];
  const fileConfig = modules.resolveFileConfig(config, normalized);
  const original = document.getText();
  const formatted = await modules.formatSource(
    original,
    document.fileName,
    fileConfig,
    {
      start: document.offsetAt(range.start),
      end: document.offsetAt(range.end),
    },
  );
  if (formatted === original) return [];
  const verification = await modules.compareAstEquivalence(
    original,
    formatted,
    document.fileName,
    fileConfig,
  );
  if (!verification.equivalent) {
    output.appendLine(
      `Skipped range formatting for ${normalized}: source-equivalence check failed (${verification.difference}).`,
    );
    return [];
  }
  const change = changedSpan(original, formatted);
  if (change.start === change.end && change.newText === "") return [];
  return [
    vscode.TextEdit.replace(
      new vscode.Range(
        document.positionAt(change.start),
        document.positionAt(change.end),
      ),
      change.newText,
    ),
  ];
}

function isSupported(document) {
  return [
    ".js",
    ".jsx",
    ".ts",
    ".tsx",
    ".mjs",
    ".cjs",
    ".mts",
    ".cts",
    ".html",
    ".css",
    ".scss",
    ".json",
    ".jsonc",
    ".yaml",
    ".yml",
    ".md",
    ".vue",
    ".toml",
    ".xml",
    ".svg",
    ".sql",
    ".svelte",
    ".astro",
    ".sh",
    ".bash",
    ".zsh",
    ".ksh",
    ".bats",
    ".ps1",
    ".psm1",
    ".psd1",
    ".java",
    ".php",
  ].includes(path.extname(document.fileName).toLowerCase());
}

async function formatDocument(document, modules, manual = false) {
  if (document.uri.scheme !== "file" || !isSupported(document)) return;
  const key = document.uri.toString();
  if (activeDocuments.has(key)) return;

  const workspace = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!workspace) return;

  activeDocuments.add(key);
  try {
    const config = await modules.loadConfig(workspace.uri.fsPath);
    if (!config.enabled) {
      if (manual) {
        void vscode.window.showInformationMessage(
          "Cleanser is disabled in .cleanser.clns.",
        );
      }
      return;
    }
    if (!manual && config.trigger !== "onSave") return;

    const relative = path.relative(workspace.uri.fsPath, document.fileName);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      return;
    }
    if (
      !(await modules.isSafeProjectFile(
        workspace.uri.fsPath,
        document.fileName,
      ))
    ) {
      output.appendLine("Skipped linked or non-file path: " + relative);
      return;
    }
    if (!modules.isIncludedPath(relative, config)) return;
    const fileConfig = modules.resolveFileConfig(config, relative);

    const original = document.getText();
    let formatted;
    try {
      formatted = await modules.formatSource(
        original,
        document.fileName,
        fileConfig,
      );
    } catch (error) {
      const message = error.message.split("\n")[0];
      if (config.safety.skip_on_syntax_error) {
        output.appendLine("Skipped " + relative + ": " + message);
      } else {
        output.appendLine("Error " + relative + ": " + message);
        void vscode.window.showErrorMessage(
          "Cleanser could not format " + relative + ": " + message,
        );
      }
      return;
    }
    if (formatted === original) return;

    const comparison = await modules.compareAstEquivalence(
      original,
      formatted,
      document.fileName,
      fileConfig,
    );
    if (!comparison.equivalent) {
      const message =
        "source equivalence check failed: " + comparison.difference;
      output.appendLine("Skipped " + relative + ": " + message);
      if (manual) {
        void vscode.window.showWarningMessage(
          "Cleanser did not format " + relative + " because " + message,
        );
      }
      return;
    }

    if (config.safety.create_backup) {
      await modules.createBackup(
        workspace.uri.fsPath,
        document.fileName,
        original,
      );
    }

    const edit = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(
      document.positionAt(0),
      document.positionAt(original.length),
    );
    edit.replace(document.uri, fullRange, formatted);
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied)
      throw new Error("VS Code could not apply the formatting edit.");
    const saved = await document.save();
    if (!saved)
      throw new Error("VS Code could not save the formatted document.");
    output.appendLine("Formatted " + relative);
  } catch (error) {
    output.appendLine("Cleanser error: " + error.message);
  } finally {
    activeDocuments.delete(key);
  }
}

async function analyzeDocument(document, modules, diagnostics, output) {
  if (document.uri.scheme !== "file") return;
  if (
    ![".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts"].includes(
      path.extname(document.fileName).toLowerCase(),
    )
  ) {
    diagnostics.delete(document.uri);
    return;
  }

  const workspace = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!workspace) return;

  try {
    const config = await modules.loadConfig(workspace.uri.fsPath);
    if (!config.enabled) {
      diagnostics.delete(document.uri);
      return;
    }
    const relative = path.relative(workspace.uri.fsPath, document.fileName);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative) ||
      !modules.isIncludedPath(relative, config) ||
      !(await modules.isSafeProjectFile(
        workspace.uri.fsPath,
        document.fileName,
      ))
    ) {
      diagnostics.delete(document.uri);
      return;
    }

    const findings = await modules.analyzeProject({
      root: workspace.uri.fsPath,
      config,
    });
    const sourceLength = document.getText().length;
    const fileDiagnostics = findings
      .filter(
        (finding) => finding.filePath === relative.split(path.sep).join("/"),
      )
      .map((finding) => {
        const start = Math.max(0, Math.min(sourceLength, finding.start ?? 0));
        const end = Math.max(
          start,
          Math.min(sourceLength, finding.end ?? start),
        );
        const diagnostic = new vscode.Diagnostic(
          new vscode.Range(
            document.positionAt(start),
            document.positionAt(end),
          ),
          finding.message,
          finding.severity === "error"
            ? vscode.DiagnosticSeverity.Error
            : finding.severity === "warning"
              ? vscode.DiagnosticSeverity.Warning
              : vscode.DiagnosticSeverity.Information,
        );
        diagnostic.code = finding.ruleId;
        diagnostic.source = "Cleanser";
        return diagnostic;
      });
    diagnostics.set(document.uri, fileDiagnostics);
  } catch (error) {
    diagnostics.delete(document.uri);
    output.appendLine("Analysis error: " + error.message);
  }
}

async function activate(context) {
  output = vscode.window.createOutputChannel("Cleanser");
  context.subscriptions.push(output);

  const modules = await loadCleanserModules(context);
  const previewContent = new Map();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider("cleanser-preview", {
      provideTextDocumentContent(uri) {
        return previewContent.get(uri.toString()) ?? "";
      },
    }),
  );
  const statusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    20,
  );
  statusItem.command = "cleanser.formatCurrentFile";
  async function updateStatus(editor) {
    const document = editor?.document;
    if (!document || document.uri.scheme !== "file" || !isSupported(document)) {
      statusItem.hide();
      return;
    }
    const workspace = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!workspace) {
      statusItem.hide();
      return;
    }
    try {
      const config = await modules.loadConfig(workspace.uri.fsPath);
      const relative = path.relative(workspace.uri.fsPath, document.fileName);
      if (!config.enabled || !modules.isIncludedPath(relative, config)) {
        statusItem.text = "$(circle-slash) Cleanser";
        statusItem.tooltip = "Cleanser is disabled for this file or workspace.";
      } else {
        statusItem.text = "$(sparkle) Cleanser";
        statusItem.tooltip =
          config.trigger === "onSave"
            ? "Cleanser formats this file on save. Click to format now."
            : "Click to format this file with Cleanser.";
      }
    } catch (error) {
      statusItem.text = "$(warning) Cleanser";
      statusItem.tooltip = error.message;
    }
    statusItem.show();
  }
  statusItem.show();
  context.subscriptions.push(statusItem);
  const diagnostics = vscode.languages.createDiagnosticCollection("cleanser");
  const analysisTimers = new Map();
  context.subscriptions.push(diagnostics, {
    dispose() {
      for (const timer of analysisTimers.values()) clearTimeout(timer);
      analysisTimers.clear();
    },
  });
  const scheduleAnalysis = (document) => {
    const key = document.uri.toString();
    clearTimeout(analysisTimers.get(key));
    const timer = setTimeout(() => {
      analysisTimers.delete(key);
      void analyzeDocument(document, modules, diagnostics, output);
    }, 100);
    analysisTimers.set(key, timer);
  };
  const saveListener = vscode.workspace.onDidSaveTextDocument((document) => {
    void formatDocument(document, modules, false);
    scheduleAnalysis(document);
    void updateStatus(vscode.window.activeTextEditor);
  });
  const activeEditorListener = vscode.window.onDidChangeActiveTextEditor(
    (editor) => void updateStatus(editor),
  );
  const configurationListener = vscode.workspace.onDidChangeConfiguration(
    () => void updateStatus(vscode.window.activeTextEditor),
  );
  const closeListener = vscode.workspace.onDidCloseTextDocument((document) => {
    if (document.uri.scheme === "cleanser-preview") {
      previewContent.delete(document.uri.toString());
      return;
    }
    clearTimeout(analysisTimers.get(document.uri.toString()));
    analysisTimers.delete(document.uri.toString());
    diagnostics.delete(document.uri);
  });
  const explain = vscode.commands.registerCommand(
    "cleanser.explainRule",
    async (ruleId, documentUri) => {
      const rule = modules
        .listRules()
        .find((candidate) => candidate.id === ruleId);
      if (!rule) return;
      const document = documentUri
        ? vscode.workspace.textDocuments.find(
            (candidate) => candidate.uri.toString() === documentUri.toString(),
          )
        : undefined;
      const workspace = document
        ? vscode.workspace.getWorkspaceFolder(document.uri)
        : vscode.workspace.workspaceFolders?.[0];
      let severity = rule.severity;
      if (workspace) {
        try {
          const config = await modules.loadConfig(workspace.uri.fsPath);
          const fileConfig = document
            ? modules.resolveFileConfig(
                config,
                path
                  .relative(workspace.uri.fsPath, document.fileName)
                  .split(path.sep)
                  .join("/"),
              )
            : config;
          severity = fileConfig.analysis.rules[rule.id] ?? severity;
        } catch (error) {
          output.appendLine("Could not load rule severity: " + error.message);
        }
      }
      void vscode.window.showInformationMessage(
        `${rule.id} (${severity}): ${rule.description}`,
      );
    },
  );
  const explanationProvider = vscode.languages.registerCodeActionsProvider(
    ["javascript", "javascriptreact", "typescript", "typescriptreact"],
    {
      provideCodeActions(document, range, actionContext) {
        return actionContext.diagnostics
          .filter((diagnostic) => typeof diagnostic.code === "string")
          .flatMap((diagnostic) => {
            const actions = [];
            const start = document.offsetAt(diagnostic.range.start);
            const end = document.offsetAt(diagnostic.range.end);
            const fix = modules.getSafeQuickFix(
              document.getText(),
              document.fileName,
              diagnostic.code,
              start,
              end,
            );
            if (fix) {
              const fixAction = new vscode.CodeAction(
                fix.title,
                vscode.CodeActionKind.QuickFix,
              );
              const edit = new vscode.WorkspaceEdit();
              edit.replace(
                document.uri,
                new vscode.Range(
                  document.positionAt(fix.start),
                  document.positionAt(fix.end),
                ),
                fix.newText,
              );
              fixAction.edit = edit;
              fixAction.isPreferred = true;
              actions.push(fixAction);
            }
            const action = new vscode.CodeAction(
              `Explain Cleanser rule: ${diagnostic.code}`,
              vscode.CodeActionKind.Empty,
            );
            action.command = {
              command: "cleanser.explainRule",
              title: "Explain Cleanser rule",
              arguments: [diagnostic.code, document.uri],
            };
            actions.push(action);
            return actions;
          });
      },
    },
  );
  const rangeFormattingProvider =
    vscode.languages.registerDocumentRangeFormattingEditProvider(
      { scheme: "file" },
      {
        provideDocumentRangeFormattingEdits(document, range) {
          return formatRange(document, range, modules).catch((error) => {
            output.appendLine("Range formatting error: " + error.message);
            return [];
          });
        },
      },
    );
  const command = vscode.commands.registerCommand(
    "cleanser.formatCurrentFile",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage("Cleanser: no active file.");
        return;
      }
      await formatDocument(editor.document, modules, true);
    },
  );

  const previewCommand = vscode.commands.registerCommand(
    "cleanser.previewCurrentFile",
    async () => {
      const editor = vscode.window.activeTextEditor;
      const document = editor?.document;
      if (
        !document ||
        document.uri.scheme !== "file" ||
        !isSupported(document)
      ) {
        void vscode.window.showInformationMessage(
          "Cleanser: open a supported file to preview formatting.",
        );
        return;
      }
      const workspace = vscode.workspace.getWorkspaceFolder(document.uri);
      if (!workspace) return;
      try {
        const config = await modules.loadConfig(workspace.uri.fsPath);
        const relative = path.relative(workspace.uri.fsPath, document.fileName);
        if (
          !config.enabled ||
          !modules.isIncludedPath(relative, config) ||
          !(await modules.isSafeProjectFile(
            workspace.uri.fsPath,
            document.fileName,
          ))
        ) {
          void vscode.window.showInformationMessage(
            "Cleanser: this file is disabled or excluded by project configuration.",
          );
          return;
        }
        const fileConfig = modules.resolveFileConfig(
          config,
          relative.split(path.sep).join("/"),
        );
        const original = document.getText();
        const formatted = await modules.formatSource(
          original,
          document.fileName,
          fileConfig,
        );
        if (formatted === original) {
          void vscode.window.showInformationMessage(
            "Cleanser: this file is already formatted.",
          );
          return;
        }
        const comparison = await modules.compareAstEquivalence(
          original,
          formatted,
          document.fileName,
          fileConfig,
        );
        if (!comparison.equivalent) {
          void vscode.window.showWarningMessage(
            "Cleanser skipped preview because source-equivalence verification failed.",
          );
          output.appendLine("Preview verification failed for " + relative);
          return;
        }

        const previewId = randomUUID();
        const beforeUri = document.uri.with({
          scheme: "cleanser-preview",
          query: `${previewId}:before`,
        });
        const afterUri = document.uri.with({
          scheme: "cleanser-preview",
          query: `${previewId}:after`,
        });
        previewContent.set(beforeUri.toString(), original);
        previewContent.set(afterUri.toString(), formatted);
        await vscode.commands.executeCommand(
          "vscode.diff",
          beforeUri,
          afterUri,
          `Cleanser Preview: ${path.basename(document.fileName)}`,
          { preview: true },
        );
      } catch (error) {
        void vscode.window.showErrorMessage(
          "Cleanser could not preview this file: " + error.message,
        );
      }
    },
  );

  const safeFixesCommand = vscode.commands.registerCommand(
    "cleanser.applySafeFixesCurrentFile",
    async () => {
      const document = vscode.window.activeTextEditor?.document;
      if (
        !document ||
        document.uri.scheme !== "file" ||
        ![
          ".js",
          ".jsx",
          ".ts",
          ".tsx",
          ".mjs",
          ".cjs",
          ".mts",
          ".cts",
        ].includes(path.extname(document.fileName).toLowerCase())
      ) {
        void vscode.window.showInformationMessage(
          "Cleanser: open a supported JavaScript or TypeScript file first.",
        );
        return;
      }
      if (document.isDirty) {
        void vscode.window.showInformationMessage(
          "Cleanser: save this file before applying analyzer fixes.",
        );
        return;
      }
      const workspace = vscode.workspace.getWorkspaceFolder(document.uri);
      if (!workspace) return;

      const version = document.version;
      const relative = path.relative(workspace.uri.fsPath, document.fileName);
      const normalized = relative.split(path.sep).join("/");
      try {
        const config = await modules.loadConfig(workspace.uri.fsPath);
        if (
          !config.enabled ||
          !modules.isIncludedPath(normalized, config) ||
          !(await modules.isSafeProjectFile(
            workspace.uri.fsPath,
            document.fileName,
          ))
        ) {
          void vscode.window.showInformationMessage(
            "Cleanser: this file is disabled or excluded by project configuration.",
          );
          return;
        }
        const source = document.getText();
        const diskSource = new TextDecoder().decode(
          await vscode.workspace.fs.readFile(document.uri),
        );
        if (source !== diskSource) {
          void vscode.window.showInformationMessage(
            "Cleanser: reload or save this file so analysis matches the editor contents.",
          );
          return;
        }
        const findings = await modules.analyzeProject({
          root: workspace.uri.fsPath,
          config,
          changedFiles: [normalized],
        });
        const latestDiskSource = new TextDecoder().decode(
          await vscode.workspace.fs.readFile(document.uri),
        );
        if (
          document.version !== version ||
          document.isDirty ||
          latestDiskSource !== source
        ) {
          void vscode.window.showInformationMessage(
            "Cleanser: the file changed during analysis; save it and run the command again.",
          );
          return;
        }
        const fixes = modules.getSafeQuickFixes(
          source,
          document.fileName,
          findings.filter((finding) => finding.filePath === normalized),
        );
        if (fixes.length === 0) {
          void vscode.window.showInformationMessage(
            "Cleanser: no safe analyzer fixes are available in this file.",
          );
          return;
        }

        const edit = new vscode.WorkspaceEdit();
        for (const fix of fixes) {
          edit.replace(
            document.uri,
            new vscode.Range(
              document.positionAt(fix.start),
              document.positionAt(fix.end),
            ),
            fix.newText,
          );
        }
        const applied = await vscode.workspace.applyEdit(edit);
        if (!applied) {
          throw new Error("VS Code could not apply the safe fixes.");
        }
        output.appendLine(
          `Applied ${fixes.length} safe analyzer fix(es) to ${normalized}.`,
        );
        void vscode.window.showInformationMessage(
          `Cleanser applied ${fixes.length} safe fix(es). Review the changes before saving.`,
        );
      } catch (error) {
        output.appendLine("Safe-fix command error: " + error.message);
        void vscode.window.showErrorMessage(
          "Cleanser could not apply safe fixes: " + error.message,
        );
      }
    },
  );

  const cleanWorkspaceCommand = vscode.commands.registerCommand(
    "cleanser.cleanWorkspace",
    async () => {
      const folders = vscode.workspace.workspaceFolders ?? [];
      if (folders.length === 0) {
        void vscode.window.showInformationMessage(
          "Cleanser: open a workspace folder first.",
        );
        return;
      }
      let cleaned = 0;
      let skipped = 0;
      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Cleanser: Cleaning workspace",
            cancellable: false,
          },
          async (progress) => {
            for (const [index, folder] of folders.entries()) {
              const config = await modules.loadConfig(folder.uri.fsPath);
              if (!config.enabled) continue;
              const results = await modules.cleanProject({
                root: folder.uri.fsPath,
                config,
                write: true,
                onProgress({ completed, total }) {
                  progress.report({
                    message: `${folder.name}: ${completed}/${total} files`,
                    increment: total > 0 ? 100 / folders.length / total : 0,
                  });
                },
              });
              cleaned += results.filter(
                (result) => result.status === "cleaned",
              ).length;
              skipped += results.filter(
                (result) => result.status === "skipped",
              ).length;
              output.appendLine(
                `Workspace ${folder.name}: ${results.length} scanned, ${results.filter((result) => result.status === "cleaned").length} formatted.`,
              );
              if (index < folders.length - 1) {
                progress.report({ message: `Completed ${folder.name}` });
              }
            }
          },
        );
        void vscode.window.showInformationMessage(
          `Cleanser workspace cleanup finished: ${cleaned} formatted, ${skipped} skipped.`,
        );
      } catch (error) {
        output.appendLine("Workspace cleanup error: " + error.message);
        void vscode.window.showErrorMessage(
          "Cleanser could not finish workspace cleanup: " + error.message,
        );
      }
    },
  );

  context.subscriptions.push(
    saveListener,
    activeEditorListener,
    configurationListener,
    closeListener,
    explain,
    explanationProvider,
    rangeFormattingProvider,
    command,
    previewCommand,
    safeFixesCommand,
    cleanWorkspaceCommand,
  );
  void updateStatus(vscode.window.activeTextEditor);
  output.appendLine(
    "Cleanser is active. Formatting and analysis follow .cleanser.clns.",
  );
}

module.exports = { activate };
