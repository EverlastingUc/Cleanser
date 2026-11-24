import path from "node:path";
import ts from "typescript";

const SUPPORTED_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
]);

function scriptKind(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".js":
    case ".mjs":
    case ".cjs":
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

function getNodeText(node, sourceFile) {
  if (node.getChildCount(sourceFile) > 0) return undefined;
  const text = node.getText(sourceFile);
  return text.length <= 120 ? text : `${text.slice(0, 117)}...`;
}

function inspectNode(node, sourceFile, depth, maximumDepth) {
  const start = Math.max(0, node.getStart(sourceFile));
  const end = Math.max(start, node.getEnd());
  const startLocation = sourceFile.getLineAndCharacterOfPosition(start);
  const result = {
    kind: ts.SyntaxKind[node.kind],
    start,
    end,
    line: startLocation.line + 1,
    column: startLocation.character + 1,
  };
  const text = getNodeText(node, sourceFile);
  if (text !== undefined) result.text = text;

  const children = node.getChildren(sourceFile);
  if (children.length > 0) {
    if (depth >= maximumDepth) {
      result.omittedChildren = children.length;
    } else {
      result.children = children.map((child) =>
        inspectNode(child, sourceFile, depth + 1, maximumDepth),
      );
    }
  }
  return result;
}

export function inspectSourceAst(source, filePath, { maximumDepth = 8 } = {}) {
  if (typeof source !== "string") {
    throw new TypeError("Source code must be a string.");
  }
  if (typeof filePath !== "string" || filePath.length === 0) {
    throw new TypeError("A source file path is required.");
  }
  if (!SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
    throw new Error(
      `AST Explorer supports ${[...SUPPORTED_EXTENSIONS].join(", ")}.`,
    );
  }
  if (
    !Number.isInteger(maximumDepth) ||
    maximumDepth < 1 ||
    maximumDepth > 20
  ) {
    throw new RangeError(
      "AST Explorer depth must be a whole number from 1 to 20.",
    );
  }

  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(filePath),
  );
  const diagnostics = sourceFile.parseDiagnostics.map((diagnostic) => {
    const location = sourceFile.getLineAndCharacterOfPosition(
      diagnostic.start ?? 0,
    );
    return {
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
      line: location.line + 1,
      column: location.character + 1,
    };
  });

  return {
    filePath: filePath.replaceAll(path.sep, "/"),
    language: path.extname(filePath).slice(1).toLowerCase(),
    diagnostics,
    tree: inspectNode(sourceFile, sourceFile, 0, maximumDepth),
  };
}
