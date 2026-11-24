import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareFindings(left, right) {
  return (
    left.line - right.line ||
    left.column - right.column ||
    compareText(left.ruleId, right.ruleId) ||
    compareText(left.message, right.message)
  );
}

export async function runEslint({ root = process.cwd() } = {}) {
  const absoluteRoot = path.resolve(root);
  const requireFromProject = createRequire(
    path.join(absoluteRoot, "package.json"),
  );
  let eslintEntry;
  try {
    eslintEntry = requireFromProject.resolve("eslint");
  } catch (error) {
    if (
      error.code === "MODULE_NOT_FOUND" ||
      error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED"
    ) {
      throw new Error(
        "ESLint is not installed in this project. Add it to the project dependencies to use this integration.",
        { cause: error },
      );
    }
    throw error;
  }

  const module = await import(pathToFileURL(eslintEntry).href);
  const ESLint = module.ESLint ?? module.default?.ESLint ?? module.default;
  if (typeof ESLint !== "function") {
    throw new Error(
      "The installed ESLint package does not expose its ESLint API.",
    );
  }
  const linter = new ESLint({ cwd: absoluteRoot });
  const results = await linter.lintFiles(["."]);
  const files = [];
  let errorCount = 0;
  let warningCount = 0;

  for (const result of results) {
    const relative = path.relative(absoluteRoot, result.filePath);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      continue;
    }
    const messages = result.messages
      .map((message) => ({
        ruleId: message.ruleId ?? "eslint",
        severity: message.severity === 2 ? "error" : "warning",
        line: message.line ?? 1,
        column: message.column ?? 1,
        ...(message.endLine === undefined ? {} : { endLine: message.endLine }),
        ...(message.endColumn === undefined
          ? {}
          : { endColumn: message.endColumn }),
        message: message.message,
        ...(message.fix ? { fixable: true } : {}),
      }))
      .sort(compareFindings);
    errorCount += result.errorCount;
    warningCount += result.warningCount;
    files.push({
      filePath: relative.split(path.sep).join("/"),
      messages,
      errorCount: result.errorCount,
      warningCount: result.warningCount,
    });
  }

  files.sort((left, right) => compareText(left.filePath, right.filePath));
  return {
    files,
    summary: {
      filesScanned: files.length,
      errorCount,
      warningCount,
      findings: errorCount + warningCount,
    },
  };
}
