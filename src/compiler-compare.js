import path from "node:path";
import ts from "typescript";

const JAVASCRIPT_TYPESCRIPT_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
]);

function canonicalLiteral(node) {
  if (ts.isStringLiteralLike(node)) return JSON.stringify(node.text);
  if (ts.isNumericLiteral(node)) {
    const numericValue = Number(node.text.replaceAll("_", ""));
    return Number.isNaN(numericValue) ? node.text : String(numericValue);
  }
  if (ts.isBigIntLiteral(node)) {
    try {
      return BigInt(
        node.text.replaceAll("_", "").replace(/n$/i, ""),
      ).toString();
    } catch {
      return node.text;
    }
  }
  if (
    node.kind === ts.SyntaxKind.TemplateHead ||
    node.kind === ts.SyntaxKind.TemplateMiddle ||
    node.kind === ts.SyntaxKind.TemplateTail
  ) {
    return JSON.stringify(node.rawText ?? node.text);
  }
  if (ts.isRegularExpressionLiteral(node)) return node.text;
  if (ts.isIdentifier(node)) return node.text;
  return undefined;
}

function serializeSyntax(node) {
  if (ts.isParenthesizedExpression(node)) {
    return serializeSyntax(node.expression);
  }
  const literal = canonicalLiteral(node);
  const children = [];
  ts.forEachChild(node, (child) => {
    children.push(serializeSyntax(child));
  });
  return JSON.stringify([ts.SyntaxKind[node.kind], literal, children]);
}

function transpile(source, fileName) {
  const result = ts.transpileModule(source, {
    fileName,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.Preserve,
      experimentalDecorators: true,
      sourceMap: false,
      inlineSourceMap: false,
    },
  });
  const errors = (result.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (errors.length > 0) {
    const message = ts.flattenDiagnosticMessageText(errors[0].messageText, " ");
    throw new Error(`TypeScript could not emit ${fileName}: ${message}`);
  }
  const scriptKind = /\.[jt]sx$/i.test(fileName)
    ? ts.ScriptKind.JSX
    : ts.ScriptKind.JS;
  const outputFile = ts.createSourceFile(
    scriptKind === ts.ScriptKind.JSX ? "compiled.jsx" : "compiled.js",
    result.outputText,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  if (outputFile.parseDiagnostics.length > 0) {
    const message = ts.flattenDiagnosticMessageText(
      outputFile.parseDiagnostics[0].messageText,
      " ",
    );
    throw new Error(
      `Compiler output for ${fileName} could not be parsed: ${message}`,
    );
  }
  return serializeSyntax(outputFile);
}

export function compareCompilerOutput(original, formatted, fileName) {
  if (typeof original !== "string" || typeof formatted !== "string") {
    throw new TypeError("Compiler comparison inputs must be strings.");
  }
  if (typeof fileName !== "string" || fileName.length === 0) {
    throw new TypeError(
      "A source file path is required for compiler comparison.",
    );
  }
  const extension = path.extname(fileName).toLowerCase();
  if (!JAVASCRIPT_TYPESCRIPT_EXTENSIONS.has(extension)) {
    return {
      applicable: false,
      equivalent: true,
      difference: undefined,
      method: "not-applicable",
    };
  }
  try {
    const before = transpile(original, fileName);
    const after = transpile(formatted, fileName);
    return {
      applicable: true,
      equivalent: before === after,
      difference:
        before === after
          ? undefined
          : "TypeScript emitted different JavaScript syntax trees.",
      method: "typescript-transpile-ast",
    };
  } catch (error) {
    return {
      applicable: true,
      equivalent: false,
      difference: error.message,
      method: "typescript-transpile-ast",
    };
  }
}
