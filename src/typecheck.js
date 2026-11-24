import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function formatDiagnostic(diagnostic, root) {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
  let filePath;
  let line = 1;
  let column = 1;
  if (diagnostic.file) {
    filePath = path.relative(root, diagnostic.file.fileName);
    if (diagnostic.start !== undefined) {
      const location = diagnostic.file.getLineAndCharacterOfPosition(
        diagnostic.start,
      );
      line = location.line + 1;
      column = location.character + 1;
    }
  }
  return {
    filePath: filePath?.split(path.sep).join("/"),
    line,
    column,
    code: diagnostic.code,
    category: ts.DiagnosticCategory[diagnostic.category].toLowerCase(),
    message,
  };
}

export async function typecheckProject({ root = process.cwd() } = {}) {
  const absoluteRoot = path.resolve(root);
  const configPath = path.join(absoluteRoot, "tsconfig.json");
  let stats;
  try {
    stats = await fs.lstat(configPath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        configured: false,
        fileCount: 0,
        diagnostics: [],
      };
    }
    throw new Error(`Could not inspect tsconfig.json: ${error.message}`, {
      cause: error,
    });
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error("tsconfig.json must be a regular project file.");
  }

  const configRead = ts.readConfigFile(configPath, ts.sys.readFile);
  let diagnostics = [];
  let fileNames = [];
  let projectReferences;
  let options = {};
  if (configRead.error) {
    diagnostics.push(configRead.error);
  } else {
    const parsed = ts.parseJsonConfigFileContent(
      configRead.config,
      ts.sys,
      absoluteRoot,
      undefined,
      configPath,
    );
    diagnostics.push(...parsed.errors);
    fileNames = parsed.fileNames;
    projectReferences = parsed.projectReferences;
    options = parsed.options;
    if (diagnostics.length === 0 && fileNames.length > 0) {
      const program = ts.createProgram({
        rootNames: fileNames,
        options: {
          ...options,
          noEmit: true,
          incremental: false,
          tsBuildInfoFile: undefined,
        },
        projectReferences,
      });
      diagnostics.push(...ts.getPreEmitDiagnostics(program));
    }
  }

  const formatted = diagnostics
    .map((diagnostic) => formatDiagnostic(diagnostic, absoluteRoot))
    .sort(
      (left, right) =>
        compareText(left.filePath ?? "", right.filePath ?? "") ||
        left.line - right.line ||
        left.column - right.column ||
        left.code - right.code ||
        compareText(left.message, right.message),
    );

  return {
    configured: true,
    fileCount: fileNames.length,
    diagnostics: formatted,
  };
}
