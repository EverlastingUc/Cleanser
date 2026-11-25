import fs from "node:fs/promises";
import { builtinModules } from "node:module";
import path from "node:path";
import ts from "typescript";
import {
  collectProjectFiles,
  isSafeProjectFile,
  resolveFileConfig,
} from "./cleaner.js";
import { buildDependencyGraph } from "./dependency-graph.js";
import { buildControlFlowGraph } from "./control-flow.js";
import { readCachedText } from "./file-cache.js";

const BUILTIN_MODULES = new Set(
  builtinModules.flatMap((name) => [name, name.replace(/^node:/, "")]),
);

const RULES = Object.freeze([
  {
    id: "syntax-error",
    severity: "error",
    description: "Source code could not be parsed.",
  },
  {
    id: "unused-variable",
    severity: "warning",
    description: "A local variable is declared but never read.",
  },
  {
    id: "unused-constant",
    severity: "warning",
    description: "A local constant is declared but never read.",
  },
  {
    id: "unused-function",
    severity: "warning",
    description: "A local function is declared but never used.",
  },
  {
    id: "unused-class",
    severity: "warning",
    description: "A local class is declared but never used.",
  },
  {
    id: "unused-type",
    severity: "warning",
    description: "A local type declaration is declared but never used.",
  },
  {
    id: "unused-import",
    severity: "warning",
    description: "An imported binding is never used.",
  },
  {
    id: "unused-parameter",
    severity: "warning",
    description: "A function parameter is never read.",
  },
  {
    id: "duplicate-declaration",
    severity: "error",
    description: "A name is declared more than once in the same scope.",
  },
  {
    id: "duplicate-import",
    severity: "warning",
    description: "A module is imported more than once in the same file.",
  },
  {
    id: "import-order",
    severity: "info",
    description: "Consecutive type-only imports are not in lexical order.",
  },
  {
    id: "import-grouping",
    severity: "info",
    description:
      "Imports from different module groups are not visually separated.",
  },
  {
    id: "import-path-normalization",
    severity: "info",
    description: "A relative import path contains redundant dot segments.",
  },
  {
    id: "relative-import-consistency",
    severity: "info",
    description: "Relative imports mix extensionful and extensionless paths.",
  },
  {
    id: "redundant-array-operation",
    severity: "info",
    description: "An array map callback returns its input unchanged.",
  },
  {
    id: "unreachable-code",
    severity: "warning",
    description: "The compiler can prove this statement cannot run.",
  },
  {
    id: "unused-label",
    severity: "warning",
    description: "A label is declared but no break or continue uses it.",
  },
  {
    id: "empty-function",
    severity: "info",
    description: "A function body contains no statements.",
  },
  {
    id: "empty-block",
    severity: "info",
    description: "A block contains no statements.",
  },
  {
    id: "empty-catch",
    severity: "warning",
    description: "A catch block discards the caught error.",
  },
  {
    id: "constant-condition",
    severity: "warning",
    description: "A conditional expression always has the same result.",
  },
  {
    id: "unnecessary-else",
    severity: "info",
    description:
      "The preceding branch always exits, so this else is redundant.",
  },
  {
    id: "redundant-expression",
    severity: "warning",
    description: "This expression statement has no observable effect.",
  },
  {
    id: "redundant-return",
    severity: "info",
    description: "A final bare return can be omitted.",
  },
  {
    id: "prefer-const",
    severity: "info",
    description: "This binding is not reassigned after initialization.",
  },
  {
    id: "prefer-let",
    severity: "info",
    description: "This var binding is a candidate for block-scoped migration.",
  },
  {
    id: "repeated-branch-condition",
    severity: "warning",
    description:
      "An else-if branch repeats an earlier stable condition in the same chain.",
  },
  {
    id: "unnecessary-return-await",
    severity: "info",
    description:
      "This async function returns an awaited value without a nearby catch or finally that needs the await.",
  },
  {
    id: "unnecessary-type-assertion",
    severity: "info",
    description:
      "This TypeScript assertion does not change the compiler-reported type.",
  },
  {
    id: "redundant-type-annotation",
    severity: "info",
    description:
      "A primitive type annotation matches the type inferred for a mutable literal binding.",
  },
  {
    id: "redundant-parentheses",
    severity: "info",
    description:
      "Parentheses around a simple atomic expression do not change its precedence.",
  },
  {
    id: "constant-expression",
    severity: "info",
    description:
      "This expression contains only literals and can be evaluated without runtime values.",
  },
  {
    id: "redundant-ternary",
    severity: "info",
    description: "This ternary returns a boolean equivalent to its condition.",
  },
  {
    id: "prefer-template-literal",
    severity: "info",
    description:
      "A primitive string concatenation can be expressed with a template literal.",
  },
  {
    id: "prefer-optional-chain",
    severity: "info",
    description:
      "A nullish guard around a property access can use optional chaining.",
  },
  {
    id: "prefer-nullish-coalescing",
    severity: "info",
    description: "A nullish fallback can use the nullish coalescing operator.",
  },
  {
    id: "object-shorthand",
    severity: "info",
    description:
      "Use object property shorthand when a key and local binding have the same name.",
  },
  {
    id: "empty-spread",
    severity: "info",
    description:
      "An empty array or object literal is spread without adding any entries.",
  },
  {
    id: "hardcoded-api-key",
    severity: "warning",
    description:
      "A credential-like value is assigned to an API key or secret setting.",
  },
  {
    id: "hardcoded-password",
    severity: "warning",
    description: "A non-placeholder password is embedded in source code.",
  },
  {
    id: "private-key",
    severity: "error",
    description: "A private-key block is embedded in source code.",
  },
  {
    id: "suspicious-url",
    severity: "warning",
    description: "A URL uses an executable scheme or embeds credentials.",
  },
  {
    id: "unsafe-eval",
    severity: "warning",
    description: "Direct eval executes a string as source code.",
  },
  {
    id: "unsafe-dynamic-code",
    severity: "warning",
    description: "The Function constructor compiles a string as source code.",
  },
  {
    id: "dangerous-shell-command",
    severity: "warning",
    description:
      "A shell command is built from dynamic input or enables a shell for a process.",
  },
  {
    id: "insecure-http",
    severity: "warning",
    description: "A remote URL uses unencrypted HTTP.",
  },
  {
    id: "weak-cryptography",
    severity: "warning",
    description: "MD5 or SHA-1 is selected for a cryptographic hash.",
  },
  {
    id: "insecure-random",
    severity: "warning",
    description: "Math.random is not suitable for security-sensitive values.",
  },
  {
    id: "sql-injection-risk",
    severity: "warning",
    description: "A dynamic value is interpolated into a SQL query string.",
  },
  {
    id: "xss-risk",
    severity: "warning",
    description: "HTML is assigned through an injection-prone DOM property.",
  },
  {
    id: "path-traversal-risk",
    severity: "warning",
    description:
      "A path is joined with a value named like user-controlled input.",
  },
  {
    id: "unsafe-deserialization",
    severity: "warning",
    description:
      "A general-purpose deserializer or virtual machine evaluates data.",
  },
  {
    id: "insecure-file-permissions",
    severity: "warning",
    description: "A filesystem operation grants permissions to every user.",
  },
  {
    id: "high-cyclomatic-complexity",
    severity: "warning",
    description: "A function has more than 10 independent control-flow paths.",
  },
  {
    id: "high-cognitive-complexity",
    severity: "warning",
    description: "A function exceeds the cognitive complexity threshold of 15.",
  },
  {
    id: "long-function",
    severity: "warning",
    description: "A function spans more than 50 source lines.",
  },
  {
    id: "deep-nesting",
    severity: "warning",
    description: "A function nests control flow deeper than four levels.",
  },
  {
    id: "too-many-parameters",
    severity: "warning",
    description: "A function declares more than five parameters.",
  },
  {
    id: "large-class",
    severity: "warning",
    description: "A class spans more than 100 source lines.",
  },
  {
    id: "too-many-dependencies",
    severity: "warning",
    description: "A file imports or requires more than 20 modules.",
  },
  {
    id: "high-file-complexity",
    severity: "warning",
    description: "A file's combined cyclomatic complexity exceeds 100.",
  },
  {
    id: "duplicate-code",
    severity: "warning",
    description:
      "A function body exactly duplicates another substantial body in the project.",
  },
  {
    id: "broken-import",
    severity: "warning",
    description:
      "A relative import does not resolve to a supported project file.",
  },
  {
    id: "circular-dependency",
    severity: "warning",
    description:
      "Project modules in this component depend on one another cyclically.",
  },
  {
    id: "outdated-todo",
    severity: "info",
    description: "A TODO comment has an explicit due date that has passed.",
  },
  {
    id: "fixme-comment",
    severity: "warning",
    description: "A FIXME comment marks an unresolved code issue.",
  },
  {
    id: "duplicate-comment",
    severity: "info",
    description:
      "The same substantive comment appears more than once in a file.",
  },
  {
    id: "empty-comment",
    severity: "info",
    description: "A comment contains no text.",
  },
  {
    id: "commented-out-code",
    severity: "info",
    description: "A comment appears to contain disabled source code.",
  },
  {
    id: "missing-function-documentation",
    severity: "info",
    description: "An exported function or class has no JSDoc description.",
  },
  {
    id: "missing-public-documentation",
    severity: "info",
    description:
      "An exported type, enum, or variable has no JSDoc description.",
  },
  {
    id: "missing-parameter-documentation",
    severity: "info",
    description: "A documented function has parameters missing @param tags.",
  },
  {
    id: "missing-return-documentation",
    severity: "info",
    description:
      "A documented function returns a value but has no @returns tag.",
  },
  {
    id: "invalid-jsdoc",
    severity: "warning",
    description:
      "A JSDoc parameter tag is duplicated or names no function parameter.",
  },
]);
const REDUNDANT_PRIMITIVE_INITIALIZERS = new Map([
  [ts.SyntaxKind.NumberKeyword, new Set([ts.SyntaxKind.NumericLiteral])],
  [
    ts.SyntaxKind.StringKeyword,
    new Set([
      ts.SyntaxKind.StringLiteral,
      ts.SyntaxKind.NoSubstitutionTemplateLiteral,
    ]),
  ],
  [
    ts.SyntaxKind.BooleanKeyword,
    new Set([ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword]),
  ],
  [ts.SyntaxKind.BigIntKeyword, new Set([ts.SyntaxKind.BigIntLiteral])],
]);

const RULE_BY_ID = new Map(RULES.map((rule) => [rule.id, rule]));
const DIAGNOSTIC_RULES = new Map([
  [2300, "duplicate-declaration"],
  [2451, "duplicate-declaration"],
  [7027, "unreachable-code"],
  [7028, "unused-label"],
]);
const ANALYZABLE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
]);

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function importGroup(specifier) {
  if (specifier.startsWith(".")) return "relative";
  if (
    specifier.startsWith("#") ||
    specifier.startsWith("@/") ||
    specifier.startsWith("~/")
  ) {
    return "project-alias";
  }
  return BUILTIN_MODULES.has(specifier.replace(/^node:/, ""))
    ? "builtin"
    : "package";
}

function isTypeOnlyImportDeclaration(node) {
  if (!ts.isImportDeclaration(node) || !node.importClause) return false;
  const clause = node.importClause;
  if (clause.isTypeOnly) return true;
  return Boolean(
    !clause.name &&
    clause.namedBindings &&
    ts.isNamedImports(clause.namedBindings) &&
    clause.namedBindings.elements.length > 0 &&
    clause.namedBindings.elements.every((element) => element.isTypeOnly),
  );
}

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

function getSmallestNodeAt(sourceFile, position) {
  let current = sourceFile;
  for (;;) {
    const child = current
      .getChildren(sourceFile)
      .find(
        (candidate) =>
          candidate.getStart(sourceFile) <= position &&
          position < candidate.getEnd(),
      );
    if (!child) return current;
    current = child;
  }
}

function createFinding(sourceFile, root, ruleId, node, message, severity) {
  const rule = RULE_BY_ID.get(ruleId);
  const start = Math.max(0, node?.getStart(sourceFile) ?? 0);
  const end = Math.max(start, node?.getEnd() ?? start);
  const location = sourceFile.getLineAndCharacterOfPosition(start);

  return {
    filePath: path
      .relative(root, sourceFile.fileName)
      .split(path.sep)
      .join("/"),
    ruleId,
    severity: severity ?? rule.severity,
    message: message ?? rule.description,
    line: location.line + 1,
    column: location.character + 1,
    start,
    end,
  };
}

function hasCommentTrivia(sourceFile, start, end) {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    sourceFile.languageVariant,
    sourceFile.text.slice(start, end),
  );
  while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) {
    if (
      scanner.getToken() === ts.SyntaxKind.SingleLineCommentTrivia ||
      scanner.getToken() === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      return true;
    }
  }
  return false;
}

function flattenLiteralConcatenation(node, operands) {
  if (ts.isParenthesizedExpression(node)) {
    const value = evaluateConstant(node.expression);
    if (
      value === undefined ||
      (value !== null &&
        !["string", "number", "boolean", "bigint"].includes(typeof value))
    ) {
      return false;
    }
    operands.push(node);
    return true;
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    return (
      flattenLiteralConcatenation(node.left, operands) &&
      flattenLiteralConcatenation(node.right, operands)
    );
  }
  if (
    ts.isStringLiteralLike(node) ||
    ts.isNumericLiteral(node) ||
    ts.isBigIntLiteral(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword
  ) {
    operands.push(node);
    return true;
  }
  return false;
}

function escapeTemplateText(value) {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("`", "\\`")
    .replaceAll("${", "\\${")
    .replaceAll("\r", "\\r")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

export function getSafeQuickFix(source, filePath, ruleId, start, end) {
  if (
    typeof source !== "string" ||
    typeof filePath !== "string" ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    end > source.length
  ) {
    return undefined;
  }
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(filePath),
  );
  if (sourceFile.parseDiagnostics.length > 0) return undefined;
  let candidate;
  function visit(node) {
    if (
      node.getStart(sourceFile) <= start &&
      node.getEnd() >= end &&
      (!candidate || node.getWidth(sourceFile) < candidate.getWidth(sourceFile))
    ) {
      candidate = node;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  if (!candidate) return undefined;

  if (
    (ruleId === "prefer-nullish-coalescing" ||
      ruleId === "prefer-optional-chain") &&
    ts.isConditionalExpression(candidate) &&
    !hasCommentTrivia(sourceFile, candidate.getStart(sourceFile), candidate.end)
  ) {
    let condition = candidate.condition;
    while (ts.isParenthesizedExpression(condition)) {
      condition = condition.expression;
    }
    if (ts.isBinaryExpression(condition)) {
      const operator = condition.operatorToken.kind;
      const isNullishCheck =
        operator === ts.SyntaxKind.EqualsEqualsToken ||
        operator === ts.SyntaxKind.ExclamationEqualsToken;
      const identifier =
        ts.isIdentifier(condition.left) &&
        condition.right.kind === ts.SyntaxKind.NullKeyword
          ? condition.left
          : ts.isIdentifier(condition.right) &&
              condition.left.kind === ts.SyntaxKind.NullKeyword
            ? condition.right
            : undefined;
      if (isNullishCheck && identifier) {
        const checksForNullish = operator === ts.SyntaxKind.EqualsEqualsToken;
        const retained = checksForNullish
          ? candidate.whenFalse
          : candidate.whenTrue;
        const fallback = checksForNullish
          ? candidate.whenTrue
          : candidate.whenFalse;
        if (
          ruleId === "prefer-nullish-coalescing" &&
          ts.isIdentifier(retained) &&
          retained.text === identifier.text
        ) {
          return {
            start: candidate.getStart(sourceFile),
            end: candidate.end,
            newText: `${identifier.getText(sourceFile)} ?? ${fallback.getText(sourceFile)}`,
            title: "Use nullish coalescing",
          };
        }
        const isVoidZero =
          ts.isVoidExpression(fallback) &&
          ts.isNumericLiteral(fallback.expression) &&
          Number(fallback.expression.text) === 0;
        if (
          ruleId === "prefer-optional-chain" &&
          isVoidZero &&
          ((ts.isPropertyAccessExpression(retained) &&
            ts.isIdentifier(retained.expression) &&
            retained.expression.text === identifier.text &&
            !retained.questionDotToken) ||
            (ts.isElementAccessExpression(retained) &&
              ts.isIdentifier(retained.expression) &&
              retained.expression.text === identifier.text &&
              !retained.questionDotToken))
        ) {
          const access = ts.isPropertyAccessExpression(retained)
            ? `?.${retained.name.getText(sourceFile)}`
            : `?.[${retained.argumentExpression.getText(sourceFile)}]`;
          return {
            start: candidate.getStart(sourceFile),
            end: candidate.end,
            newText: `${identifier.getText(sourceFile)}${access}`,
            title: "Use optional chaining",
          };
        }
      }
    }
  }

  if (
    ruleId === "object-shorthand" &&
    ts.isPropertyAssignment(candidate) &&
    ts.isIdentifier(candidate.name) &&
    ts.isIdentifier(candidate.initializer) &&
    candidate.name.text === candidate.initializer.text &&
    candidate.name.text !== "__proto__" &&
    !hasCommentTrivia(
      sourceFile,
      candidate.name.end,
      candidate.initializer.getStart(sourceFile),
    )
  ) {
    return {
      start: candidate.getStart(sourceFile),
      end: candidate.getEnd(),
      newText: candidate.name.getText(sourceFile),
      title: "Use object property shorthand",
    };
  }

  if (
    ruleId === "redundant-parentheses" &&
    ts.isParenthesizedExpression(candidate) &&
    !hasCommentTrivia(sourceFile, candidate.getStart(sourceFile), candidate.end)
  ) {
    return {
      start: candidate.getStart(sourceFile),
      end: candidate.getEnd(),
      newText: candidate.expression.getText(sourceFile),
      title: "Remove redundant parentheses",
    };
  }

  if (ruleId === "redundant-expression") {
    const statement = ts.isExpressionStatement(candidate.parent)
      ? candidate.parent
      : undefined;
    if (
      statement &&
      isPureLiteralExpression(statement.expression) &&
      !ts.isStringLiteralLike(statement.expression) &&
      !hasCommentTrivia(
        sourceFile,
        statement.getStart(sourceFile),
        statement.end,
      )
    ) {
      const lineBreak =
        source.slice(statement.end).match(/^(?:\r\n|\r|\n)/u)?.[0] ?? "";
      return {
        start: statement.getStart(sourceFile),
        end: statement.end + lineBreak.length,
        newText: "",
        title: "Remove redundant expression statement",
      };
    }
  }

  if (
    ruleId === "redundant-ternary" &&
    ts.isConditionalExpression(candidate) &&
    !hasCommentTrivia(sourceFile, candidate.getStart(sourceFile), candidate.end)
  ) {
    const whenTrue = candidate.whenTrue.kind === ts.SyntaxKind.TrueKeyword;
    const whenFalse = candidate.whenFalse.kind === ts.SyntaxKind.TrueKeyword;
    if (whenTrue !== whenFalse) {
      const condition = candidate.condition.getText(sourceFile);
      return {
        start: candidate.getStart(sourceFile),
        end: candidate.getEnd(),
        newText: whenTrue ? `!!(${condition})` : `!(${condition})`,
        title: "Simplify boolean conditional",
      };
    }
  }

  if (ruleId === "repeated-branch-condition" && ts.isExpression(candidate)) {
    const branch = candidate.parent;
    const previous = branch.parent;
    if (
      ts.isIfStatement(branch) &&
      branch.expression === candidate &&
      ts.isIfStatement(previous) &&
      previous.elseStatement === branch &&
      isStableCondition(branch.expression)
    ) {
      const printer = ts.createPrinter({ removeComments: true });
      const repeatedCondition = printer
        .printNode(ts.EmitHint.Expression, branch.expression, sourceFile)
        .trim();
      const previousCondition = printer
        .printNode(ts.EmitHint.Expression, previous.expression, sourceFile)
        .trim();
      if (
        repeatedCondition === previousCondition &&
        !hasCommentTrivia(sourceFile, previous.thenStatement.end, branch.end)
      ) {
        return {
          start: previous.thenStatement.end,
          end: branch.end,
          newText: branch.elseStatement
            ? ` else ${branch.elseStatement.getText(sourceFile)}`
            : "",
          title: "Remove repeated else-if branch",
        };
      }
    }
  }

  if (ruleId === "import-order") {
    const statements = sourceFile.statements;
    const importStatement = statements.find(
      (statement) =>
        ts.isImportDeclaration(statement) &&
        statement.getStart(sourceFile) <= start &&
        statement.end >= end,
    );
    const candidateIndex = statements.indexOf(importStatement);
    if (candidateIndex >= 0 && isTypeOnlyImportDeclaration(importStatement)) {
      let first = candidateIndex;
      let last = candidateIndex;
      while (first > 0 && isTypeOnlyImportDeclaration(statements[first - 1])) {
        first--;
      }
      while (
        last + 1 < statements.length &&
        isTypeOnlyImportDeclaration(statements[last + 1])
      ) {
        last++;
      }
      if (last > first) {
        const run = statements.slice(first, last + 1);
        let safe = true;
        let newline;
        for (const statement of run) {
          if (
            hasCommentTrivia(
              sourceFile,
              statement.getStart(sourceFile),
              statement.end,
            )
          ) {
            safe = false;
            break;
          }
        }
        for (let index = first; safe && index < last; index++) {
          const separator = source.slice(
            statements[index].end,
            statements[index + 1].getStart(sourceFile),
          );
          if (!/^(?:\r\n|\r|\n)$/u.test(separator)) {
            safe = false;
          } else {
            newline ??= separator;
            if (separator !== newline) safe = false;
          }
        }
        const ordered = [...run].sort((left, right) =>
          compareText(left.moduleSpecifier.text, right.moduleSpecifier.text),
        );
        if (
          safe &&
          ordered.some((statement, index) => statement !== run[index])
        ) {
          return {
            start: run[0].getStart(sourceFile),
            end: run.at(-1).end,
            newText: ordered
              .map((statement) =>
                source.slice(statement.getStart(sourceFile), statement.end),
              )
              .join(newline),
            title: "Sort type-only imports",
          };
        }
      }
    }
  }

  if (ruleId === "import-grouping") {
    const statements = sourceFile.statements;
    const currentIndex = statements.findIndex(
      (statement) =>
        ts.isImportDeclaration(statement) &&
        statement.getStart(sourceFile) <= start &&
        statement.end >= end,
    );
    const previous = statements[currentIndex - 1];
    const current = statements[currentIndex];
    if (
      currentIndex > 0 &&
      ts.isImportDeclaration(previous) &&
      ts.isImportDeclaration(current) &&
      importGroup(previous.moduleSpecifier.text) !==
        importGroup(current.moduleSpecifier.text)
    ) {
      const separator = source.slice(
        previous.end,
        current.getStart(sourceFile),
      );
      const lineBreak = separator.match(/\r\n|\r|\n/u)?.[0];
      if (
        lineBreak &&
        /^[\t \r\n]*$/u.test(separator) &&
        !/\r?\n\s*\r?\n/u.test(separator)
      ) {
        return {
          start: previous.end,
          end: current.getStart(sourceFile),
          newText: separator.replace(lineBreak, lineBreak + lineBreak),
          title: "Separate import groups",
        };
      }
    }
  }

  if (ruleId === "duplicate-import" && ts.isStringLiteralLike(candidate)) {
    const current = candidate.parent;
    if (
      ts.isImportDeclaration(current) &&
      current.moduleSpecifier === candidate &&
      current.importClause?.namedBindings &&
      ts.isNamedImports(current.importClause.namedBindings) &&
      !current.importClause.name &&
      !current.assertClause &&
      !current.attributes
    ) {
      const statements = sourceFile.statements;
      const currentIndex = statements.indexOf(current);
      const previous = statements[currentIndex - 1];
      if (
        previous &&
        ts.isImportDeclaration(previous) &&
        previous.moduleSpecifier.text === candidate.text &&
        previous.importClause?.namedBindings &&
        ts.isNamedImports(previous.importClause.namedBindings) &&
        !previous.importClause.name &&
        previous.importClause.isTypeOnly === current.importClause.isTypeOnly &&
        !previous.assertClause &&
        !previous.attributes
      ) {
        const firstBindings = previous.importClause.namedBindings;
        const secondBindings = current.importClause.namedBindings;
        const localNames = new Set(
          firstBindings.elements.map((element) => element.name.text),
        );
        const hasCollision = secondBindings.elements.some((element) =>
          localNames.has(element.name.text),
        );
        const separator = source.slice(previous.end, current.getStart(sourceFile));
        if (
          !hasCollision &&
          /^[\t \r\n]*$/u.test(separator) &&
          !hasCommentTrivia(sourceFile, previous.getStart(sourceFile), current.end)
        ) {
          const elements = [...firstBindings.elements, ...secondBindings.elements]
            .map((element) => element.getText(sourceFile));
          const typeOnly = previous.importClause.isTypeOnly;
          const semicolon = source.slice(previous.end - 1, previous.end) === ";";
          return {
            start: previous.getStart(sourceFile),
            end: current.end,
            newText:
              "import" +
              (typeOnly ? " type" : "") +
              " { " +
              elements.join(", ") +
              " } from " +
              previous.moduleSpecifier.getText(sourceFile) +
              (semicolon ? ";" : ""),
            title: "Merge duplicate named imports",
          };
        }
      }
    }
  }

  if (ruleId === "prefer-template-literal") {
    const operands = [];
    if (
      ts.isBinaryExpression(candidate) &&
      flattenLiteralConcatenation(candidate, operands) &&
      operands.some(ts.isStringLiteralLike) &&
      !hasCommentTrivia(
        sourceFile,
        candidate.getStart(sourceFile),
        candidate.end,
      )
    ) {
      let template = "`";
      for (const operand of operands) {
        if (ts.isStringLiteralLike(operand)) {
          template += escapeTemplateText(operand.text);
        } else {
          template += `\u0024{${operand.getText(sourceFile)}}`;
        }
      }
      return {
        start: candidate.getStart(sourceFile),
        end: candidate.end,
        newText: template + "`",
        title: "Convert concatenation to a template literal",
      };
    }
  }

  if (
    ruleId === "empty-spread" &&
    (ts.isSpreadElement(candidate) || ts.isSpreadAssignment(candidate)) &&
    ((ts.isArrayLiteralExpression(candidate.parent) &&
      candidate.parent.elements.length === 1) ||
      (ts.isObjectLiteralExpression(candidate.parent) &&
        candidate.parent.properties.length === 1)) &&
    !hasCommentTrivia(sourceFile, candidate.getStart(sourceFile), candidate.end)
  ) {
    return {
      start: candidate.getStart(sourceFile),
      end: candidate.getEnd(),
      newText: "",
      title: "Remove empty spread",
    };
  }

  return undefined;
}

export function getSafeQuickFixes(source, filePath, findings) {
  if (
    !Array.isArray(findings) ||
    findings.some(
      (finding) =>
        !finding ||
        typeof finding.ruleId !== "string" ||
        !Number.isSafeInteger(finding.start) ||
        !Number.isSafeInteger(finding.end),
    )
  ) {
    return [];
  }
  const candidates = [];
  const seen = new Set();
  for (const finding of findings) {
    const fix = getSafeQuickFix(
      source,
      filePath,
      finding.ruleId,
      finding.start,
      finding.end,
    );
    if (!fix) continue;
    const key = `${fix.start}:${fix.end}:${fix.newText}`;
    if (!seen.has(key)) {
      seen.add(key);
      candidates.push(fix);
    }
  }
  candidates.sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  const nonOverlapping = [];
  for (const candidate of candidates) {
    const previous = nonOverlapping.at(-1);
    if (
      previous &&
      (candidate.start < previous.end || candidate.start === previous.start)
    ) {
      continue;
    }
    nonOverlapping.push(candidate);
  }
  return nonOverlapping;
}

function analyzeComments(sourceFile, root, findings) {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    sourceFile.languageVariant,
    sourceFile.text,
  );
  const commentKinds = new Set([
    ts.SyntaxKind.SingleLineCommentTrivia,
    ts.SyntaxKind.MultiLineCommentTrivia,
    ts.SyntaxKind.JSDocCommentTrivia,
  ]);
  const seenComments = new Set();
  const today = new Date().toISOString().slice(0, 10);

  while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) {
    const kind = scanner.getToken();
    if (!commentKinds.has(kind)) continue;

    const raw = scanner.getTokenText();
    const start = scanner.getTokenPos();
    const end = scanner.getTextPos();
    const commentText = raw.startsWith("//")
      ? raw.slice(2)
      : raw.slice(2, -2).replace(/^\*/, "");
    const body = commentText
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*\*\s?/, "").trim())
      .join("\n")
      .trim();
    const push = (ruleId, message) => {
      findings.push(
        createFinding(
          sourceFile,
          root,
          ruleId,
          { getStart: () => start, getEnd: () => end },
          message,
        ),
      );
    };

    if (!body) {
      push("empty-comment");
      continue;
    }

    const todoDueDate = body.match(/\bTODO\s*\[due:\s*(\d{4}-\d{2}-\d{2})\]/i);
    const dueDateIsValid =
      todoDueDate &&
      !Number.isNaN(Date.parse(todoDueDate[1])) &&
      new Date(`${todoDueDate[1]}T00:00:00.000Z`)
        .toISOString()
        .startsWith(todoDueDate[1]);
    if (dueDateIsValid && todoDueDate[1] < today) {
      push("outdated-todo", "TODO due date has passed.");
    }
    if (/\bFIXME\b/i.test(body)) push("fixme-comment");

    const normalized = body.replace(/\s+/g, " ").toLowerCase();
    if (
      normalized.length >= 24 &&
      !/^(?:copyright|licensed under|spdx-license-identifier)/i.test(normalized)
    ) {
      if (seenComments.has(normalized)) {
        push("duplicate-comment");
      } else {
        seenComments.add(normalized);
      }
    }

    const codePatterns = [
      /^(?:const|let|var)\s+[\w$]+\s*=.+;?$/,
      /^(?:if|for|while|switch|catch)\s*\(/,
      /^(?:import|export)\s+(?:\{|\*|[\w$]).*\s+from\s+["']/,
      /^(?:function|class)\s+[\w$]+\s*[({]/,
      /^(?:return|throw)\s+.+;?$/,
    ];
    if (codePatterns.some((pattern) => pattern.test(body))) {
      push("commented-out-code");
    }
  }
}

function modifierNames(node) {
  return (
    (ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined)?.map(
      (modifier) => modifier.kind,
    ) ?? []
  );
}

function hasValueReturn(node) {
  let found = false;
  function visit(candidate) {
    if (found || (candidate !== node && ts.isFunctionLike(candidate))) return;
    if (ts.isReturnStatement(candidate) && candidate.expression) {
      found = true;
      return;
    }
    ts.forEachChild(candidate, visit);
  }
  if (node.body) visit(node.body);
  return found;
}

function analyzeDocumentation(node, push) {
  const isFunctionDeclaration =
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node);
  const isClassDeclaration = ts.isClassDeclaration(node);
  const isOtherPublicDeclaration =
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isVariableStatement(node);
  if (
    !isFunctionDeclaration &&
    !isClassDeclaration &&
    !isOtherPublicDeclaration
  ) {
    return;
  }

  const modifiers = modifierNames(node);
  if (
    modifiers.includes(ts.SyntaxKind.PrivateKeyword) ||
    modifiers.includes(ts.SyntaxKind.ProtectedKeyword)
  ) {
    return;
  }
  let isPublicApi = modifiers.includes(ts.SyntaxKind.ExportKeyword);
  for (
    let parent = node.parent;
    !isPublicApi && parent;
    parent = parent.parent
  ) {
    if (
      ts.isClassDeclaration(parent) &&
      modifierNames(parent).includes(ts.SyntaxKind.ExportKeyword)
    ) {
      isPublicApi = true;
      break;
    }
    if (ts.isSourceFile(parent)) break;
  }
  if (!isPublicApi) return;

  const docs = node.jsDoc ?? [];
  const tags = docs.flatMap((doc) => [...(doc.tags ?? [])]);
  const descriptions = docs
    .map((doc) => (typeof doc.comment === "string" ? doc.comment.trim() : ""))
    .filter(Boolean);
  if (descriptions.length === 0) {
    push(
      isFunctionDeclaration || isClassDeclaration
        ? "missing-function-documentation"
        : "missing-public-documentation",
      node.name ?? node,
    );
  }
  if (!isFunctionDeclaration) return;

  const parameterNames = node.parameters
    .map((parameter) => parameter.name)
    .filter(ts.isIdentifier)
    .map((name) => name.text);
  const documentedParameters = new Set();
  for (const tag of tags) {
    if (!ts.isJSDocParameterTag(tag)) continue;
    const name = tag.name.getText().split(".")[0];
    if (!parameterNames.includes(name) || documentedParameters.has(name)) {
      push("invalid-jsdoc", tag);
      continue;
    }
    documentedParameters.add(name);
  }

  const hasDocumentation = docs.length > 0;
  if (hasDocumentation) {
    const missingParameters = parameterNames.filter(
      (name) => !documentedParameters.has(name),
    );
    if (missingParameters.length > 0) {
      push(
        "missing-parameter-documentation",
        node.name ?? node,
        `Missing @param documentation for: ${missingParameters.join(", ")}.`,
      );
    }
    const hasReturns = tags.some(
      (tag) =>
        ts.isJSDocReturnTag(tag) ||
        ["return", "returns"].includes(tag.tagName.text.toLowerCase()),
    );
    if (hasValueReturn(node) && !hasReturns) {
      push("missing-return-documentation", node.name ?? node);
    }
  }
}

function evaluateConstant(node) {
  if (ts.isParenthesizedExpression(node))
    return evaluateConstant(node.expression);
  if (
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    return evaluateConstant(node.expression);
  }
  if (ts.isConditionalExpression(node)) {
    const condition = evaluateConstant(node.condition);
    if (condition === undefined) return undefined;
    return evaluateConstant(condition ? node.whenTrue : node.whenFalse);
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text.replaceAll("_", ""));

  if (ts.isPrefixUnaryExpression(node)) {
    const value = evaluateConstant(node.operand);
    if (value === undefined) return undefined;
    switch (node.operator) {
      case ts.SyntaxKind.ExclamationToken:
        return !value;
      case ts.SyntaxKind.PlusToken:
        return +value;
      case ts.SyntaxKind.MinusToken:
        return -value;
      case ts.SyntaxKind.TildeToken:
        return ~value;
      default:
        return undefined;
    }
  }

  if (!ts.isBinaryExpression(node)) return undefined;
  const left = evaluateConstant(node.left);
  if (left === undefined) return undefined;
  if (
    node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
    !left
  ) {
    return left;
  }
  if (node.operatorToken.kind === ts.SyntaxKind.BarBarToken && left) {
    return left;
  }
  if (
    node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
    left !== null
  ) {
    return left;
  }
  const right = evaluateConstant(node.right);
  if (right === undefined) return undefined;

  switch (node.operatorToken.kind) {
    case ts.SyntaxKind.PlusToken:
      return left + right;
    case ts.SyntaxKind.MinusToken:
      return left - right;
    case ts.SyntaxKind.AsteriskToken:
      return left * right;
    case ts.SyntaxKind.SlashToken:
      return left / right;
    case ts.SyntaxKind.PercentToken:
      return left % right;
    case ts.SyntaxKind.AsteriskAsteriskToken:
      return left ** right;
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
      return left === right;
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
      return left !== right;
    case ts.SyntaxKind.LessThanToken:
      return left < right;
    case ts.SyntaxKind.LessThanEqualsToken:
      return left <= right;
    case ts.SyntaxKind.GreaterThanToken:
      return left > right;
    case ts.SyntaxKind.GreaterThanEqualsToken:
      return left >= right;
    case ts.SyntaxKind.AmpersandAmpersandToken:
      return left && right;
    case ts.SyntaxKind.BarBarToken:
      return left || right;
    case ts.SyntaxKind.QuestionQuestionToken:
      return left ?? right;
    default:
      return undefined;
  }
}

function isConstantExpressionNode(node) {
  return (
    ts.isBinaryExpression(node) ||
    ts.isPrefixUnaryExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isConditionalExpression(node)
  );
}

function isFunctionBody(block) {
  return ts.isFunctionLike(block.parent) && block.parent.body === block;
}

function isTerminatingStatement(statement) {
  if (
    ts.isReturnStatement(statement) ||
    ts.isThrowStatement(statement) ||
    ts.isBreakStatement(statement) ||
    ts.isContinueStatement(statement)
  ) {
    return true;
  }
  if (ts.isBlock(statement)) {
    const last = statement.statements.at(-1);
    return Boolean(last && isTerminatingStatement(last));
  }
  return (
    ts.isIfStatement(statement) &&
    statement.elseStatement !== undefined &&
    isTerminatingStatement(statement.thenStatement) &&
    isTerminatingStatement(statement.elseStatement)
  );
}

function isPureLiteralExpression(node) {
  if (ts.isParenthesizedExpression(node)) {
    return isPureLiteralExpression(node.expression);
  }
  if (
    ts.isNumericLiteral(node) ||
    ts.isStringLiteralLike(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword
  ) {
    return true;
  }
  if (ts.isPrefixUnaryExpression(node)) {
    return isPureLiteralExpression(node.operand);
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.every(
      (element) =>
        !ts.isSpreadElement(element) &&
        (ts.isOmittedExpression(element) || isPureLiteralExpression(element)),
    );
  }
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.every(
      (property) =>
        ts.isPropertyAssignment(property) &&
        !ts.isComputedPropertyName(property.name) &&
        isPureLiteralExpression(property.initializer),
    );
  }
  return evaluateConstant(node) !== undefined;
}

const STABLE_CONDITION_OPERATORS = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
]);

function isStableCondition(node) {
  if (
    ts.isIdentifier(node) ||
    ts.isStringLiteralLike(node) ||
    ts.isNumericLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword ||
    node.kind === ts.SyntaxKind.ThisKeyword
  ) {
    return true;
  }
  if (ts.isParenthesizedExpression(node)) {
    return isStableCondition(node.expression);
  }
  if (
    ts.isPrefixUnaryExpression(node) &&
    [
      ts.SyntaxKind.ExclamationToken,
      ts.SyntaxKind.PlusToken,
      ts.SyntaxKind.MinusToken,
      ts.SyntaxKind.TildeToken,
    ].includes(node.operator)
  ) {
    return isStableCondition(node.operand);
  }
  if (ts.isBinaryExpression(node)) {
    return (
      STABLE_CONDITION_OPERATORS.has(node.operatorToken.kind) &&
      isStableCondition(node.left) &&
      isStableCondition(node.right)
    );
  }
  return false;
}

function hasAsyncModifier(node) {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
    )
  );
}

function isUnnecessaryReturnAwait(returnNode) {
  let expression = returnNode.expression;
  while (expression && ts.isParenthesizedExpression(expression)) {
    expression = expression.expression;
  }
  if (!expression || !ts.isAwaitExpression(expression)) return false;

  let current = returnNode.parent;
  while (current && !ts.isFunctionLike(current)) {
    if (
      ts.isTryStatement(current) &&
      (current.catchClause || current.finallyBlock)
    ) {
      return false;
    }
    current = current.parent;
  }
  return Boolean(
    current && hasAsyncModifier(current) && !current.asteriskToken,
  );
}

function isAssignmentTo(node, symbol, checker) {
  if (ts.isIdentifier(node) && checker.getSymbolAtLocation(node) === symbol) {
    const parent = node.parent;
    if (
      ts.isBinaryExpression(parent) &&
      parent.left === node &&
      parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      return true;
    }
    if (
      ts.isPrefixUnaryExpression(parent) ||
      ts.isPostfixUnaryExpression(parent)
    ) {
      return (
        parent.operator === ts.SyntaxKind.PlusPlusToken ||
        parent.operator === ts.SyntaxKind.MinusMinusToken
      );
    }
  }
  return false;
}

function getPropertyName(node) {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && node.argumentExpression) {
    if (ts.isStringLiteralLike(node.argumentExpression)) {
      return node.argumentExpression.text;
    }
  }
  return undefined;
}

function getStringValue(node) {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

function hasDynamicValue(node) {
  if (ts.isTemplateExpression(node)) return node.templateSpans.length > 0;
  if (ts.isBinaryExpression(node)) {
    return (
      node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
      (hasDynamicValue(node.left) || hasDynamicValue(node.right))
    );
  }
  return !(
    ts.isStringLiteralLike(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isNumericLiteral(node)
  );
}

function hasUserNamedInput(node) {
  let found = false;
  function visit(candidate) {
    if (
      ts.isIdentifier(candidate) &&
      (/^(?:req|request|params?|query|input|user|filename|filepath|url)$/i.test(
        candidate.text,
      ) ||
        /(?:user|request|param|query|input|upload)/i.test(candidate.text))
    ) {
      found = true;
      return;
    }
    ts.forEachChild(candidate, visit);
  }
  visit(node);
  return found;
}

function hasShellEnabledOptions(node) {
  return node.arguments.some(
    (argument) =>
      ts.isObjectLiteralExpression(argument) &&
      argument.properties.some(
        (property) =>
          ts.isPropertyAssignment(property) &&
          getPropertyName(property.name) === "shell" &&
          property.initializer.kind === ts.SyntaxKind.TrueKeyword,
      ),
  );
}

function getPermissionMode(call) {
  const operation = getPropertyName(call.expression);
  const optionsArgument = call.arguments.find(ts.isObjectLiteralExpression);
  if (optionsArgument) {
    for (const property of optionsArgument.properties) {
      if (
        ts.isPropertyAssignment(property) &&
        getPropertyName(property.name) === "mode" &&
        ts.isNumericLiteral(property.initializer)
      ) {
        return Number(property.initializer.text);
      }
    }
  }

  const modeIndex =
    operation === "open" ? 2 : operation === "writeFile" ? 2 : 1;
  const mode = call.arguments[modeIndex];
  return mode && ts.isNumericLiteral(mode) ? Number(mode.text) : undefined;
}

function isPlausibleCredential(value) {
  const normalized = value.trim();
  return (
    normalized.length >= 8 &&
    !/^(?:your|example|sample|placeholder|change.?me|replace|dummy|test|xxx+|123456)(?:[_-].*)?$/i.test(
      normalized,
    )
  );
}

function containsPrivateKey(value) {
  const match = value.match(
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\s*([A-Za-z0-9+/=\r\n]+)\s*-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  );
  return Boolean(match && match[1].replace(/\s/g, "").length >= 64);
}

function classifyCredential(name, value) {
  const normalizedName = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (/password|passwd|pwd/.test(normalizedName)) {
    return isPlausibleCredential(value) ? "hardcoded-password" : undefined;
  }
  if (/apikey|accesskey|clientsecret|secret|token/.test(normalizedName)) {
    return isPlausibleCredential(value) ? "hardcoded-api-key" : undefined;
  }
  return undefined;
}

function addCredentialFindings(node, name, initializer, push) {
  const value = getStringValue(initializer);
  if (value === undefined) return;
  if (containsPrivateKey(value)) {
    push("private-key", initializer);
    return;
  }
  const ruleId = classifyCredential(name, value);
  if (ruleId) push(ruleId, initializer);
}

function getChildProcessBindings(sourceFile) {
  const modules = new Set(["child_process"]);
  const functions = new Set();

  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteralLike(statement.moduleSpecifier) &&
      /^(?:node:)?child_process$/.test(statement.moduleSpecifier.text)
    ) {
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        modules.add(bindings.name.text);
      } else if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          functions.add(element.name.text);
        }
      }
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (
          !declaration.initializer ||
          !ts.isCallExpression(declaration.initializer) ||
          !ts.isIdentifier(declaration.initializer.expression) ||
          declaration.initializer.expression.text !== "require" ||
          !declaration.initializer.arguments[0] ||
          !ts.isStringLiteralLike(declaration.initializer.arguments[0]) ||
          !/^(?:node:)?child_process$/.test(
            declaration.initializer.arguments[0].text,
          )
        ) {
          continue;
        }

        if (ts.isIdentifier(declaration.name)) {
          modules.add(declaration.name.text);
        } else if (ts.isObjectBindingPattern(declaration.name)) {
          for (const element of declaration.name.elements) {
            const imported = element.propertyName ?? element.name;
            if (ts.isIdentifier(imported) && ts.isIdentifier(element.name)) {
              functions.add(element.name.text);
            }
          }
        }
      }
    }
  }

  return { modules, functions };
}

function isChildProcessCall(call, bindings) {
  if (ts.isIdentifier(call.expression)) {
    return bindings.functions.has(call.expression.text);
  }
  const name = getPropertyName(call.expression);
  if (
    ![
      "exec",
      "execSync",
      "execFile",
      "execFileSync",
      "spawn",
      "spawnSync",
    ].includes(name)
  ) {
    return false;
  }
  if (!ts.isPropertyAccessExpression(call.expression)) return false;
  return (
    ts.isIdentifier(call.expression.expression) &&
    bindings.modules.has(call.expression.expression.text)
  );
}

function measureFunction(node, sourceFile) {
  let cyclomatic = 1;
  let cognitive = 0;
  let maximumNesting = 0;
  const nestingKinds = new Set([
    ts.SyntaxKind.IfStatement,
    ts.SyntaxKind.ForStatement,
    ts.SyntaxKind.ForInStatement,
    ts.SyntaxKind.ForOfStatement,
    ts.SyntaxKind.WhileStatement,
    ts.SyntaxKind.DoStatement,
    ts.SyntaxKind.SwitchStatement,
    ts.SyntaxKind.CatchClause,
    ts.SyntaxKind.ConditionalExpression,
  ]);
  const branchKinds = new Set([
    ...nestingKinds,
    ts.SyntaxKind.CaseClause,
    ts.SyntaxKind.DefaultClause,
  ]);

  function visit(candidate, nesting) {
    if (candidate !== node && ts.isFunctionLike(candidate)) return;
    if (branchKinds.has(candidate.kind)) {
      const isDefault = ts.isDefaultClause(candidate);
      if (!isDefault) cyclomatic++;
      if (
        candidate.kind !== ts.SyntaxKind.CaseClause &&
        candidate.kind !== ts.SyntaxKind.DefaultClause
      ) {
        cognitive += 1 + nesting;
      }
    }
    if (ts.isBinaryExpression(candidate)) {
      const operator = candidate.operatorToken.kind;
      if (
        operator === ts.SyntaxKind.AmpersandAmpersandToken ||
        operator === ts.SyntaxKind.BarBarToken ||
        operator === ts.SyntaxKind.QuestionQuestionToken
      ) {
        cyclomatic++;
        cognitive++;
      }
    }

    const nextNesting = nesting + (nestingKinds.has(candidate.kind) ? 1 : 0);
    maximumNesting = Math.max(maximumNesting, nextNesting);
    ts.forEachChild(candidate, (child) => visit(child, nextNesting));
  }

  if (node.body) visit(node.body, 0);
  const startLine = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile),
  ).line;
  const endLine = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line;

  return {
    cyclomatic,
    cognitive,
    maximumNesting,
    lineCount: endLine - startLine + 1,
    parameterCount: node.parameters.length,
  };
}

function collectVariableLifetimes(functionNode, sourceFile) {
  const declarations = [];
  const declarationNames = new Set();

  function collectDeclarations(node) {
    if (node !== functionNode && ts.isFunctionLike(node)) return;
    let kind;
    if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
      kind = "parameter";
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      ts.isVariableDeclarationList(node.parent)
    ) {
      kind =
        node.parent.flags & ts.NodeFlags.Const
          ? "const"
          : node.parent.flags & ts.NodeFlags.Let
            ? "let"
            : "var";
    }
    if (kind) {
      const name = node.name;
      const start = name.getStart(sourceFile);
      const entry = {
        name: name.text,
        kind,
        declarationOffset: start,
        lastUseOffset: name.end,
        referenceCount: 0,
      };
      declarations.push(entry);
      declarationNames.add(start);
    }
    ts.forEachChild(node, collectDeclarations);
  }

  function isNonReferenceIdentifier(node) {
    const parent = node.parent;
    const isBindingName =
      (ts.isVariableDeclaration(parent) && parent.name === node) ||
      (ts.isParameter(parent) && parent.name === node) ||
      (ts.isBindingElement(parent) && parent.name === node);
    if (
      declarationNames.has(node.getStart(sourceFile)) ||
      isBindingName ||
      (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
      (ts.isPropertyAssignment(parent) && parent.name === node) ||
      (ts.isMethodDeclaration(parent) && parent.name === node) ||
      (ts.isPropertyDeclaration(parent) && parent.name === node) ||
      (ts.isPropertySignature(parent) && parent.name === node) ||
      (ts.isMethodSignature(parent) && parent.name === node) ||
      (ts.isLabeledStatement(parent) && parent.label === node) ||
      ((ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) &&
        parent.label === node)
    ) {
      return true;
    }
    for (
      let ancestor = parent;
      ancestor && ancestor !== functionNode;
      ancestor = ancestor.parent
    ) {
      if (ts.isTypeNode(ancestor)) return true;
    }
    return false;
  }

  function collectReads(node) {
    if (
      ts.isIdentifier(node) &&
      !isNonReferenceIdentifier(node) &&
      declarations.length > 0
    ) {
      for (const declaration of declarations) {
        if (declaration.name === node.text) {
          declaration.referenceCount++;
          declaration.lastUseOffset = Math.max(
            declaration.lastUseOffset,
            node.getEnd(),
          );
        }
      }
    }
    ts.forEachChild(node, collectReads);
  }

  collectDeclarations(functionNode);
  if (functionNode.body) collectReads(functionNode.body);
  return declarations
    .map((declaration) => {
      const declarationLine =
        sourceFile.getLineAndCharacterOfPosition(declaration.declarationOffset)
          .line + 1;
      const lastUseLine =
        sourceFile.getLineAndCharacterOfPosition(declaration.lastUseOffset)
          .line + 1;
      return {
        ...declaration,
        declarationLine,
        lastUseLine,
        lifetimeLines: Math.max(1, lastUseLine - declarationLine + 1),
      };
    })
    .sort(
      (left, right) =>
        left.declarationOffset - right.declarationOffset ||
        compareText(left.name, right.name),
    );
}

function sourceLineCount(source) {
  if (source.length === 0) return 0;
  const lines = source.split(/\r\n|\r|\n/);
  if (/(?:\r\n|\r|\n)$/.test(source)) lines.pop();
  return lines.length;
}

function getMetricFunctionName(node, sourceFile) {
  if (node.name) return node.name.getText(sourceFile);
  const parent = node.parent;
  if (
    parent &&
    ts.isVariableDeclaration(parent) &&
    ts.isIdentifier(parent.name)
  ) {
    return parent.name.text;
  }
  if (parent && ts.isPropertyAssignment(parent)) {
    return parent.name.getText(sourceFile);
  }
  return "<anonymous>";
}

function isHalsteadOperator(node) {
  return (
    ts.isBinaryExpression(node) ||
    ts.isPrefixUnaryExpression(node) ||
    ts.isPostfixUnaryExpression(node) ||
    ts.isConditionalExpression(node) ||
    ts.isCallExpression(node) ||
    ts.isNewExpression(node) ||
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node) ||
    ts.isIfStatement(node) ||
    ts.isSwitchStatement(node) ||
    ts.isCaseClause(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node) ||
    ts.isTryStatement(node) ||
    ts.isThrowStatement(node) ||
    ts.isReturnStatement(node) ||
    ts.isAwaitExpression(node) ||
    ts.isYieldExpression(node)
  );
}

export function inspectSourceMetrics(source, filePath = "source.ts") {
  if (typeof source !== "string") {
    throw new TypeError("Source code must be a string.");
  }
  if (typeof filePath !== "string" || filePath.length === 0) {
    throw new TypeError("A source file path is required.");
  }

  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(filePath),
  );
  if (sourceFile.parseDiagnostics.length > 0) {
    const message = ts.flattenDiagnosticMessageText(
      sourceFile.parseDiagnostics[0].messageText,
      " ",
    );
    throw new Error(`Could not measure ${filePath}: ${message}`);
  }

  const functions = [];
  const functionNodes = new Map();
  const classes = [];
  const dependencies = new Set();
  const duplicateBodies = new Set();
  const printer = ts.createPrinter({ removeComments: true });
  const operatorKinds = new Set();
  const operandValues = new Set();
  let operatorCount = 0;
  let operandCount = 0;
  let duplicateFunctionCount = 0;
  let duplicateLines = 0;
  let cyclomaticComplexity = 0;
  let cognitiveComplexity = 0;
  let maximumNestingDepth = 0;

  function lineSpan(node) {
    const start = sourceFile.getLineAndCharacterOfPosition(
      node.getStart(sourceFile),
    ).line;
    const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line;
    return {
      startLine: start + 1,
      endLine: end + 1,
      lineCount: end - start + 1,
    };
  }

  function visit(node) {
    if (ts.isFunctionLike(node) && node.body) {
      const span = lineSpan(node);
      const complexity = measureFunction(node, sourceFile);
      const functionMetrics = {
        name: getMetricFunctionName(node, sourceFile),
        ...span,
        variableLifetimes: collectVariableLifetimes(node, sourceFile),
        cyclomaticComplexity: complexity.cyclomatic,
        cognitiveComplexity: complexity.cognitive,
        maximumNestingDepth: complexity.maximumNesting,
        parameterCount: complexity.parameterCount,
        calls: [],
      };
      functions.push(functionMetrics);
      functionNodes.set(node, functionMetrics);
      cyclomaticComplexity += complexity.cyclomatic;
      cognitiveComplexity += complexity.cognitive;
      maximumNestingDepth = Math.max(
        maximumNestingDepth,
        complexity.maximumNesting,
      );

      if (ts.isBlock(node.body) && node.body.statements.length >= 4) {
        const body = printer.printNode(
          ts.EmitHint.Unspecified,
          node.body,
          sourceFile,
        );
        if (duplicateBodies.has(body)) {
          duplicateFunctionCount++;
          duplicateLines += lineSpan(node).lineCount;
        } else {
          duplicateBodies.add(body);
        }
      }
    }

    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const heritage = node.heritageClauses ?? [];
      const extendsTypes = heritage
        .filter((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)
        .flatMap((clause) =>
          clause.types.map((type) => type.expression.getText(sourceFile)),
        );
      const implementsTypes = heritage
        .filter((clause) => clause.token === ts.SyntaxKind.ImplementsKeyword)
        .flatMap((clause) =>
          clause.types.map((type) => type.getText(sourceFile)),
        );
      classes.push({
        name: node.name?.text ?? "<anonymous>",
        ...lineSpan(node),
        extends: extendsTypes,
        implements: implementsTypes,
        methods: node.members
          .filter(
            (member) =>
              ts.isMethodDeclaration(member) ||
              ts.isConstructorDeclaration(member) ||
              ts.isGetAccessorDeclaration(member) ||
              ts.isSetAccessorDeclaration(member),
          )
          .map((member) => member.name?.getText(sourceFile) ?? "<anonymous>"),
      });
    }

    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      dependencies.add(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      dependencies.add(node.arguments[0].text);
    }

    if (isHalsteadOperator(node)) {
      const kind = ts.SyntaxKind[node.kind];
      operatorKinds.add(kind);
      operatorCount++;
    }
    if (
      ts.isIdentifier(node) ||
      ts.isStringLiteralLike(node) ||
      ts.isNumericLiteral(node) ||
      ts.isBigIntLiteral(node) ||
      ts.isRegularExpressionLiteral(node) ||
      node.kind === ts.SyntaxKind.TrueKeyword ||
      node.kind === ts.SyntaxKind.FalseKeyword ||
      node.kind === ts.SyntaxKind.NullKeyword
    ) {
      const kind = ts.SyntaxKind[node.kind];
      const value =
        ts.isIdentifier(node) || ts.isStringLiteralLike(node)
          ? node.text
          : node.getText(sourceFile);
      operandValues.add(`${kind}:${value}`);
      operandCount++;
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  for (const [functionNode, metrics] of functionNodes) {
    metrics.controlFlowGraph = buildControlFlowGraph(functionNode, sourceFile);
    const collectCalls = (node) => {
      if (node !== functionNode.body && ts.isFunctionLike(node)) return;
      if (ts.isCallExpression(node)) {
        let target = node.expression;
        while (ts.isParenthesizedExpression(target)) target = target.expression;
        let name;
        if (ts.isIdentifier(target)) {
          name = target.text;
        } else if (ts.isPropertyAccessExpression(target)) {
          name = target.getText(sourceFile);
        } else if (
          ts.isElementAccessExpression(target) &&
          target.argumentExpression &&
          (ts.isStringLiteralLike(target.argumentExpression) ||
            ts.isNumericLiteral(target.argumentExpression))
        ) {
          name = target.getText(sourceFile);
        } else {
          name = "<dynamic>";
        }
        metrics.calls.push({
          name,
          line:
            sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
              .line + 1,
        });
      }
      ts.forEachChild(node, collectCalls);
    };
    if (functionNode.body) collectCalls(functionNode.body);
    metrics.calls.sort(
      (left, right) =>
        left.line - right.line || compareText(left.name, right.name),
    );
  }
  functions.sort(
    (left, right) =>
      left.startLine - right.startLine ||
      left.endLine - right.endLine ||
      compareText(left.name, right.name),
  );
  classes.sort(
    (left, right) =>
      left.startLine - right.startLine || compareText(left.name, right.name),
  );

  const lineCount = sourceLineCount(source);
  const vocabularySize = operatorKinds.size + operandValues.size;
  const halsteadVolume =
    operatorCount + operandCount === 0 || vocabularySize === 0
      ? 0
      : (operatorCount + operandCount) * Math.log2(vocabularySize);
  const maintainabilityIndex = Math.max(
    0,
    Math.min(
      100,
      (100 / 171) *
        (171 -
          5.2 * Math.log(Math.max(halsteadVolume, 1)) -
          0.23 * Math.max(cyclomaticComplexity, 1) -
          16.2 * Math.log(Math.max(lineCount, 1))),
    ),
  );

  return {
    lineCount,
    functionCount: functions.length,
    classCount: classes.length,
    dependencyCount: dependencies.size,
    dependencies: [...dependencies].sort(compareText),
    cyclomaticComplexity,
    cognitiveComplexity,
    maximumNestingDepth,
    functions,
    classes,
    duplication: {
      duplicateFunctionCount,
      duplicateLines,
      percentage:
        lineCount === 0 ? 0 : Math.min(100, (duplicateLines / lineCount) * 100),
    },
    halstead: {
      operatorCount,
      distinctOperators: operatorKinds.size,
      operandCount,
      distinctOperands: operandValues.size,
      volume: halsteadVolume,
    },
    maintainabilityIndex: Number(maintainabilityIndex.toFixed(2)),
  };
}

function analyzeTree(sourceFile, root, checker, findings) {
  const push = (ruleId, node, message) => {
    findings.push(createFinding(sourceFile, root, ruleId, node, message));
  };
  const seenImports = new Map();
  const dependencies = new Set();
  const duplicateBodies = new Map();
  const printer = ts.createPrinter({ removeComments: true });
  let fileComplexity = 0;
  const childProcessBindings = getChildProcessBindings(sourceFile);

  function isTypeOnlyImport(node) {
    const clause = node.importClause;
    if (!clause) return false;
    if (clause.isTypeOnly) return true;
    return Boolean(
      !clause.name &&
      clause.namedBindings &&
      ts.isNamedImports(clause.namedBindings) &&
      clause.namedBindings.elements.length > 0 &&
      clause.namedBindings.elements.every((element) => element.isTypeOnly),
    );
  }

  const imports = sourceFile.statements.filter(ts.isImportDeclaration);
  let hasExtensionfulRelativeImport = false;
  let hasExtensionlessRelativeImport = false;
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier.text;
    if (specifier.startsWith(".")) {
      const pathPart = specifier.split(/[?#]/, 1)[0];
      if (/\/(?:\.|\.\.|)\//u.test(pathPart)) {
        push(
          "import-path-normalization",
          statement.moduleSpecifier,
          "This relative path contains an interior dot or empty segment; verify that normalization preserves symlink and resolver behavior.",
        );
      }
      if (path.posix.extname(pathPart)) hasExtensionfulRelativeImport = true;
      else hasExtensionlessRelativeImport = true;
    }
  }
  if (hasExtensionfulRelativeImport && hasExtensionlessRelativeImport) {
    const candidate = imports.find(
      (statement) =>
        statement.moduleSpecifier.text.startsWith(".") &&
        !path.posix.extname(statement.moduleSpecifier.text.split(/[?#]/, 1)[0]),
    );
    if (candidate) {
      push(
        "relative-import-consistency",
        candidate.moduleSpecifier,
        "This file mixes relative imports with and without extensions; module-resolution settings may require that mix, so Cleanser does not rewrite paths.",
      );
    }
  }
  for (let index = 1; index < sourceFile.statements.length; index++) {
    const previous = sourceFile.statements[index - 1];
    const current = sourceFile.statements[index];
    if (!ts.isImportDeclaration(previous) || !ts.isImportDeclaration(current)) {
      continue;
    }
    const previousSpecifier = previous.moduleSpecifier.text;
    const currentSpecifier = current.moduleSpecifier.text;
    if (
      isTypeOnlyImport(previous) &&
      isTypeOnlyImport(current) &&
      compareText(previousSpecifier, currentSpecifier) > 0
    ) {
      push(
        "import-order",
        current.moduleSpecifier,
        "Consecutive type-only imports are out of lexical order; no import is reordered automatically.",
      );
    }
    if (importGroup(previousSpecifier) !== importGroup(currentSpecifier)) {
      const between = sourceFile.text.slice(
        previous.end,
        current.getStart(sourceFile),
      );
      if (!/\r?\n\s*\r?\n/u.test(between)) {
        push(
          "import-grouping",
          current.moduleSpecifier,
          "Add a blank line between these import groups while preserving their current evaluation order.",
        );
      }
    }
  }

  function hasRedundantPrimitiveAnnotation(node) {
    if (
      !ts.isVariableDeclaration(node) ||
      !node.type ||
      !node.initializer ||
      !ts.isIdentifier(node.name) ||
      !ts.isVariableDeclarationList(node.parent) ||
      (node.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      return false;
    }

    if (
      !REDUNDANT_PRIMITIVE_INITIALIZERS.get(node.type.kind)?.has(
        node.initializer.kind,
      )
    ) {
      return false;
    }

    const declaredType = checker.getTypeFromTypeNode(node.type);
    const inferredType = checker.getBaseTypeOfLiteralType(
      checker.getTypeAtLocation(node.initializer),
    );
    if (
      (declaredType.flags | inferredType.flags) &
      (ts.TypeFlags.Any | ts.TypeFlags.Unknown)
    ) {
      return false;
    }
    return (
      checker.typeToString(declaredType, node) ===
      checker.typeToString(inferredType, node)
    );
  }

  function hasRedundantAtomicParentheses(node) {
    if (!ts.isParenthesizedExpression(node)) return false;
    const expression = node.expression;
    if (
      ts.isStringLiteral(expression) &&
      ts.isExpressionStatement(node.parent)
    ) {
      return false;
    }
    return (
      ts.isIdentifier(expression) ||
      ts.isNumericLiteral(expression) ||
      ts.isStringLiteral(expression) ||
      ts.isNoSubstitutionTemplateLiteral(expression) ||
      ts.isBigIntLiteral(expression) ||
      ts.isRegularExpressionLiteral(expression) ||
      expression.kind === ts.SyntaxKind.TrueKeyword ||
      expression.kind === ts.SyntaxKind.FalseKeyword ||
      expression.kind === ts.SyntaxKind.NullKeyword
    );
  }

  function stableLocalSymbol(node) {
    if (!ts.isIdentifier(node)) return undefined;
    const symbol = checker.getSymbolAtLocation(node);
    if (!symbol) return undefined;
    return (symbol.declarations ?? []).some(
      (declaration) =>
        ts.isParameter(declaration) ||
        (ts.isVariableDeclaration(declaration) &&
          ts.isIdentifier(declaration.name)),
    )
      ? symbol
      : undefined;
  }

  function expressionSymbol(node) {
    while (ts.isParenthesizedExpression(node)) node = node.expression;
    return stableLocalSymbol(node);
  }

  function nullishComparison(node) {
    while (ts.isParenthesizedExpression(node)) node = node.expression;
    if (!ts.isBinaryExpression(node)) return undefined;
    const operator = node.operatorToken.kind;
    if (
      ![
        ts.SyntaxKind.EqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsToken,
      ].includes(operator)
    ) {
      return undefined;
    }
    let identifier;
    if (
      ts.isIdentifier(node.left) &&
      node.right.kind === ts.SyntaxKind.NullKeyword
    ) {
      identifier = node.left;
    } else if (
      ts.isIdentifier(node.right) &&
      node.left.kind === ts.SyntaxKind.NullKeyword
    ) {
      identifier = node.right;
    }
    const symbol = identifier && stableLocalSymbol(identifier);
    return symbol
      ? {
          symbol,
          checksForNullish: operator === ts.SyntaxKind.EqualsEqualsToken,
        }
      : undefined;
  }

  function isUndefinedValue(node) {
    const type = checker.getTypeAtLocation(node);
    const types = type.isUnion() ? type.types : [type];
    return (
      types.length > 0 &&
      types.every((part) => part.flags === ts.TypeFlags.Undefined)
    );
  }

  function isPrimitiveTemplateValue(node) {
    const type = checker.getTypeAtLocation(node);
    const types = type.isUnion() ? type.types : [type];
    const primitiveFlags =
      ts.TypeFlags.StringLike |
      ts.TypeFlags.NumberLike |
      ts.TypeFlags.BooleanLike |
      ts.TypeFlags.BigIntLike |
      ts.TypeFlags.Null |
      ts.TypeFlags.Undefined;
    return (
      types.length > 0 &&
      types.every(
        (part) =>
          (part.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) === 0 &&
          (part.flags & primitiveFlags) !== 0,
      )
    );
  }

  function isSafeStringConcatenation(node) {
    if (
      !ts.isBinaryExpression(node) ||
      node.operatorToken.kind !== ts.SyntaxKind.PlusToken ||
      (checker.getTypeAtLocation(node).flags & ts.TypeFlags.StringLike) === 0
    ) {
      return false;
    }
    const operands = [];
    let containsString = false;
    const collectOperands = (candidate) => {
      if (
        ts.isBinaryExpression(candidate) &&
        candidate.operatorToken.kind === ts.SyntaxKind.PlusToken &&
        !ts.isParenthesizedExpression(candidate.parent)
      ) {
        collectOperands(candidate.left);
        collectOperands(candidate.right);
      } else {
        operands.push(candidate);
        const type = checker.getTypeAtLocation(candidate);
        if ((type.flags & ts.TypeFlags.StringLike) !== 0) containsString = true;
      }
    };
    collectOperands(node);
    return containsString && operands.every(isPrimitiveTemplateValue);
  }

  function isTemplateSuggestionRoot(node) {
    let parent = node.parent;
    while (ts.isParenthesizedExpression(parent)) parent = parent.parent;
    return !(
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.PlusToken
    );
  }

  function visit(node) {
    analyzeDocumentation(node, push);

    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "map" &&
      node.arguments.length === 1
    ) {
      const callback = node.arguments[0];
      const parameters =
        ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)
          ? callback.parameters
          : [];
      const body =
        ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)
          ? callback.body
          : undefined;
      const returnExpression =
        body &&
        ts.isBlock(body) &&
        body.statements.length === 1 &&
        ts.isReturnStatement(body.statements[0])
          ? body.statements[0].expression
          : body && !ts.isBlock(body)
            ? body
            : undefined;
      const receiverType = checker.getTypeAtLocation(
        node.expression.expression,
      );
      const receiverTypes = receiverType.isUnion()
        ? receiverType.types
        : [receiverType];
      let receiver = node.expression.expression;
      while (ts.isParenthesizedExpression(receiver)) {
        receiver = receiver.expression;
      }
      const isArray =
        ts.isArrayLiteralExpression(receiver) ||
        receiverTypes.every(
          (type) =>
            (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) === 0 &&
            checker.getIndexTypeOfType(type, ts.IndexKind.Number) !== undefined,
        );
      if (
        isArray &&
        parameters.length === 1 &&
        ts.isIdentifier(parameters[0].name) &&
        ts.isIdentifier(returnExpression) &&
        checker.getSymbolAtLocation(parameters[0].name) ===
          checker.getSymbolAtLocation(returnExpression)
      ) {
        push(
          "redundant-array-operation",
          node,
          "This map callback returns each array value unchanged; map still creates a shallow copy, so review whether that allocation is intentional.",
        );
      }
    }

    if (hasRedundantPrimitiveAnnotation(node)) {
      push(
        "redundant-type-annotation",
        node.type,
        "This primitive annotation matches the type inferred from its mutable literal initializer.",
      );
    }
    if (hasRedundantAtomicParentheses(node)) {
      push(
        "redundant-parentheses",
        node,
        "Parentheses around this simple expression are unnecessary; grouped expressions are left untouched.",
      );
    }

    if (
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isNonNullExpression(node)
    ) {
      const sourceType = checker.getTypeAtLocation(node.expression);
      const assertedType = checker.getTypeAtLocation(node);
      const sourceTypeName = checker.typeToString(
        sourceType,
        node,
        ts.TypeFormatFlags.NoTruncation,
      );
      const assertedTypeName = checker.typeToString(
        assertedType,
        node,
        ts.TypeFormatFlags.NoTruncation,
      );
      if (
        sourceTypeName === assertedTypeName &&
        !(sourceType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))
      ) {
        push(
          "unnecessary-type-assertion",
          node,
          `The assertion leaves the expression type as ${sourceTypeName}.`,
        );
      }
    }

    if (isConstantExpressionNode(node)) {
      const value = evaluateConstant(node);
      const parent = node.parent;
      if (
        value !== undefined &&
        !(
          isConstantExpressionNode(parent) &&
          evaluateConstant(parent) !== undefined
        )
      ) {
        const valueText =
          typeof value === "string" ? JSON.stringify(value) : String(value);
        push(
          "constant-expression",
          node,
          `This expression always evaluates to ${valueText}.`,
        );
      }
    }

    if (ts.isIfStatement(node) && isStableCondition(node.expression)) {
      const conditionText = printer
        .printNode(ts.EmitHint.Expression, node.expression, sourceFile)
        .trim();
      let child = node;
      let ancestor = node.parent;
      while (ts.isIfStatement(ancestor) && ancestor.elseStatement === child) {
        const earlierText = printer
          .printNode(ts.EmitHint.Expression, ancestor.expression, sourceFile)
          .trim();
        if (conditionText === earlierText) {
          push(
            "repeated-branch-condition",
            node.expression,
            "This stable condition already appeared in an earlier branch of the same else-if chain.",
          );
          break;
        }
        child = ancestor;
        ancestor = ancestor.parent;
      }
    }

    if (ts.isReturnStatement(node) && isUnnecessaryReturnAwait(node)) {
      push(
        "unnecessary-return-await",
        node.expression,
        "Consider removing await after checking stack traces and surrounding async behavior.",
      );
    }

    if (isSafeStringConcatenation(node) && isTemplateSuggestionRoot(node)) {
      push(
        "prefer-template-literal",
        node,
        "This string concatenation uses only primitive values and can be written as a template literal; Cleanser does not rewrite it automatically.",
      );
    }

    if (ts.isConditionalExpression(node)) {
      const comparison = nullishComparison(node.condition);
      if (comparison) {
        const retainedValue = comparison.checksForNullish
          ? node.whenFalse
          : node.whenTrue;
        const fallback = comparison.checksForNullish
          ? node.whenTrue
          : node.whenFalse;
        if (expressionSymbol(retainedValue) === comparison.symbol) {
          push(
            "prefer-nullish-coalescing",
            node,
            "This local nullish check can use the ?? operator without changing falsy-value behavior; no source is rewritten automatically.",
          );
        } else if (
          (ts.isPropertyAccessExpression(retainedValue) ||
            ts.isElementAccessExpression(retainedValue)) &&
          expressionSymbol(retainedValue.expression) === comparison.symbol &&
          !retainedValue.questionDotToken &&
          isUndefinedValue(fallback)
        ) {
          push(
            "prefer-optional-chain",
            node,
            "This local nullish guard and property access can use optional chaining; no source is rewritten automatically.",
          );
        }
      }
    }

    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      dependencies.add(node.moduleSpecifier.text);
    }

    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      addCredentialFindings(
        node,
        node.name.text,
        node.initializer,
        (ruleId, target) => push(ruleId, target),
      );
    }

    if (ts.isPropertyAssignment(node)) {
      const name = getPropertyName(node.name);
      if (name) {
        addCredentialFindings(node, name, node.initializer, (ruleId, target) =>
          push(ruleId, target),
        );
      }
      if (
        ts.isIdentifier(node.name) &&
        node.name.text !== "__proto__" &&
        ts.isIdentifier(node.initializer) &&
        node.name.text === node.initializer.text
      ) {
        push(
          "object-shorthand",
          node,
          "The property key and value use the same identifier and can use object shorthand; no source is rewritten automatically.",
        );
      }
      if (name === "dangerouslySetInnerHTML") {
        push("xss-risk", node.name);
      }
    }

    if (
      (ts.isSpreadElement(node) &&
        ts.isArrayLiteralExpression(node.expression) &&
        node.expression.elements.length === 0) ||
      (ts.isSpreadAssignment(node) &&
        ts.isObjectLiteralExpression(node.expression) &&
        node.expression.properties.length === 0)
    ) {
      push(
        "empty-spread",
        node,
        "This spread adds no literal entries; Cleanser reports it for review and does not rewrite the expression.",
      );
    }

    if (
      ts.isJsxAttribute(node) &&
      node.name.text === "dangerouslySetInnerHTML"
    ) {
      push("xss-risk", node.name);
    }

    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      ["innerHTML", "outerHTML"].includes(node.left.name.text)
    ) {
      push("xss-risk", node.left.name);
    }

    if (
      ts.isStringLiteralLike(node) ||
      ts.isNoSubstitutionTemplateLiteral(node)
    ) {
      const value = node.text;
      if (containsPrivateKey(value)) {
        push("private-key", node);
      }
      if (
        /^(?:javascript:|data:text\/html)/i.test(value.trim()) ||
        /^https?:\/\/[^/\s]+:[^@/\s]+@/i.test(value.trim())
      ) {
        push("suspicious-url", node);
      }
      if (
        /^http:\/\//i.test(value.trim()) &&
        !/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(
          value.trim(),
        )
      ) {
        push("insecure-http", node);
      }
    }

    if (
      ts.isImportDeclaration(node) &&
      node.importClause &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      const specifier = node.moduleSpecifier.text;
      dependencies.add(specifier);
      const firstImport = seenImports.get(specifier);
      if (firstImport) {
        push(
          "duplicate-import",
          node.moduleSpecifier,
          `"${specifier}" is already imported at line ${firstImport}.`,
        );
      } else {
        seenImports.set(
          specifier,
          sourceFile.getLineAndCharacterOfPosition(
            node.moduleSpecifier.getStart(sourceFile),
          ).line + 1,
        );
      }
    }

    if (
      ts.isFunctionLike(node) &&
      node.body &&
      ts.isBlock(node.body) &&
      node.body.statements.length === 0
    ) {
      push("empty-function", node.body);
    }

    if (ts.isFunctionLike(node) && node.body) {
      const metrics = measureFunction(node, sourceFile);
      fileComplexity += metrics.cyclomatic;
      const functionNode = node.name ?? node;
      if (metrics.cyclomatic > 10) {
        push(
          "high-cyclomatic-complexity",
          functionNode,
          `Function cyclomatic complexity is ${metrics.cyclomatic}; the threshold is 10.`,
        );
      }
      if (metrics.cognitive > 15) {
        push(
          "high-cognitive-complexity",
          functionNode,
          `Function cognitive complexity is ${metrics.cognitive}; the threshold is 15.`,
        );
      }
      if (metrics.lineCount > 50) {
        push(
          "long-function",
          functionNode,
          `Function spans ${metrics.lineCount} source lines; the threshold is 50.`,
        );
      }
      if (metrics.maximumNesting > 4) {
        push(
          "deep-nesting",
          functionNode,
          `Function control flow nests ${metrics.maximumNesting} levels; the threshold is 4.`,
        );
      }
      if (metrics.parameterCount > 5) {
        push(
          "too-many-parameters",
          functionNode,
          `Function declares ${metrics.parameterCount} parameters; the threshold is 5.`,
        );
      }

      if (ts.isBlock(node.body) && node.body.statements.length >= 4) {
        const bodyText = printer.printNode(
          ts.EmitHint.Unspecified,
          node.body,
          sourceFile,
        );
        const previous = duplicateBodies.get(bodyText);
        if (previous) {
          push(
            "duplicate-code",
            functionNode,
            "Function body duplicates an earlier function in this file.",
          );
        } else {
          duplicateBodies.set(bodyText, functionNode);
        }
      }
    }

    if (
      (ts.isClassDeclaration(node) || ts.isClassExpression(node)) &&
      sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line -
        sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
          .line +
        1 >
        100
    ) {
      push("large-class", node.name ?? node);
    }

    if (ts.isCallExpression(node)) {
      const calleeName = getPropertyName(node.expression);
      const receiver = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.expression.getText(sourceFile)
        : "";

      if (
        calleeName === "require" &&
        ts.isIdentifier(node.expression) &&
        node.arguments[0] &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        dependencies.add(node.arguments[0].text);
      }

      if (calleeName === "eval" && ts.isIdentifier(node.expression)) {
        push("unsafe-eval", node.expression);
      }
      if (
        calleeName === "Function" &&
        (ts.isIdentifier(node.expression) || receiver === "globalThis")
      ) {
        push("unsafe-dynamic-code", node.expression);
      }
      if (calleeName === "random" && receiver === "Math") {
        push("insecure-random", node.expression);
      }
      if (
        ["createHash", "createHmac"].includes(calleeName) &&
        node.arguments[0] &&
        ["md5", "sha1"].includes(
          getStringValue(node.arguments[0])?.toLowerCase(),
        )
      ) {
        push("weak-cryptography", node.arguments[0]);
      }
      if (
        ["query", "execute", "raw"].includes(calleeName) &&
        node.arguments[0] &&
        hasDynamicValue(node.arguments[0])
      ) {
        push("sql-injection-risk", node.arguments[0]);
      }
      if (
        isChildProcessCall(node, childProcessBindings) &&
        (hasShellEnabledOptions(node) ||
          (node.arguments[0] && hasDynamicValue(node.arguments[0])))
      ) {
        push("dangerous-shell-command", node);
      }
      if (
        ["join", "resolve"].includes(calleeName) &&
        (receiver === "path" || receiver === "path.posix") &&
        node.arguments.length > 1 &&
        node.arguments.slice(1).some(hasUserNamedInput)
      ) {
        push("path-traversal-risk", node);
      }
      if (
        [
          "deserialize",
          "unserialize",
          "runInContext",
          "runInNewContext",
          "runInThisContext",
        ].includes(calleeName)
      ) {
        push("unsafe-deserialization", node.expression);
      }
      if (
        ["chmod", "writeFile", "mkdir", "open"].includes(calleeName) &&
        ((getPermissionMode(node) ?? 0) & 0o007) !== 0
      ) {
        push("insecure-file-permissions", node);
      }
    }

    if (
      ts.isNewExpression(node) &&
      getPropertyName(node.expression) === "Function"
    ) {
      push("unsafe-dynamic-code", node.expression);
    }

    if (ts.isCatchClause(node) && node.block.statements.length === 0) {
      push("empty-catch", node.block);
    }

    if (
      ts.isBlock(node) &&
      node.statements.length === 0 &&
      !isFunctionBody(node) &&
      !ts.isCatchClause(node.parent)
    ) {
      push("empty-block", node);
    }

    if (
      ts.isIfStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node) ||
      ts.isConditionalExpression(node) ||
      (ts.isForStatement(node) && node.condition !== undefined)
    ) {
      const condition = ts.isForStatement(node)
        ? node.condition
        : node.expression;
      if (condition && evaluateConstant(condition) !== undefined) {
        push(
          "constant-condition",
          condition,
          `This condition is always ${Boolean(evaluateConstant(condition)) ? "true" : "false"}.`,
        );
      }
    }

    if (
      ts.isIfStatement(node) &&
      node.elseStatement &&
      isTerminatingStatement(node.thenStatement)
    ) {
      push("unnecessary-else", node.elseStatement);
    }

    if (
      ts.isExpressionStatement(node) &&
      isPureLiteralExpression(node.expression) &&
      !ts.isStringLiteralLike(node.expression)
    ) {
      push("redundant-expression", node.expression);
    }

    if (
      ts.isReturnStatement(node) &&
      node.expression === undefined &&
      ts.isBlock(node.parent) &&
      node.parent.statements.at(-1) === node &&
      isFunctionBody(node.parent)
    ) {
      push("redundant-return", node);
    }

    if (
      ts.isConditionalExpression(node) &&
      node.whenTrue.kind === ts.SyntaxKind.TrueKeyword &&
      node.whenFalse.kind === ts.SyntaxKind.FalseKeyword
    ) {
      push("redundant-ternary", node);
    } else if (
      ts.isConditionalExpression(node) &&
      node.whenTrue.kind === ts.SyntaxKind.FalseKeyword &&
      node.whenFalse.kind === ts.SyntaxKind.TrueKeyword
    ) {
      push("redundant-ternary", node);
    }

    if (
      ts.isVariableDeclarationList(node) &&
      !(node.flags & ts.NodeFlags.Const)
    ) {
      const isVar = !(node.flags & ts.NodeFlags.Let);
      const isForInitializer =
        ts.isForStatement(node.parent) ||
        ts.isForInStatement(node.parent) ||
        ts.isForOfStatement(node.parent);
      if (!isVar && isForInitializer) {
        ts.forEachChild(node, visit);
        return;
      }
      for (const declaration of node.declarations) {
        if (
          (!declaration.initializer && !isVar) ||
          !ts.isIdentifier(declaration.name)
        ) {
          continue;
        }
        const symbol = checker.getSymbolAtLocation(declaration.name);
        if (!symbol) continue;
        if (isVar && (symbol.declarations?.length ?? 0) > 1) continue;
        let reassigned = false;
        const findWrites = (candidate) => {
          if (isAssignmentTo(candidate, symbol, checker)) reassigned = true;
          if (!reassigned) ts.forEachChild(candidate, findWrites);
        };
        findWrites(sourceFile);
        if (isVar) {
          if (reassigned || !declaration.initializer) {
            push("prefer-let", declaration.name);
          } else {
            push("prefer-const", declaration.name);
          }
        } else if (!reassigned) {
          push("prefer-const", declaration.name);
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  if (dependencies.size > 20) {
    push(
      "too-many-dependencies",
      sourceFile,
      `File depends on ${dependencies.size} distinct modules; the threshold is 20.`,
    );
  }
  if (fileComplexity > 100) {
    push(
      "high-file-complexity",
      sourceFile,
      `File cyclomatic complexity totals ${fileComplexity}; the threshold is 100.`,
    );
  }
}

function hasCommonJsSyntax(sourceFile) {
  let found = false;
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require"
    ) {
      found = true;
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ((node.expression.text === "module" && node.name.text === "exports") ||
        node.expression.text === "exports")
    ) {
      found = true;
    }
    if (!found) ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return found;
}

function isTopLevelDeclaration(node, sourceFile) {
  let current = node;
  while (current.parent && current.parent !== sourceFile) {
    current = current.parent;
    if (
      (ts.isFunctionLike(current) || ts.isClassLike(current)) &&
      current.name !== node
    ) {
      return false;
    }
  }
  return current.parent === sourceFile;
}

function isDeclarationName(identifier, symbol) {
  return (symbol.declarations ?? []).some(
    (declaration) => declaration.name === identifier,
  );
}

function isExportedBinding(name, sourceFile, checker) {
  const symbol = checker.getSymbolAtLocation(name);
  let declaration = name.parent;
  while (declaration && declaration !== sourceFile) {
    if (ts.canHaveModifiers(declaration)) {
      const modifiers = ts.getModifiers(declaration) ?? [];
      if (
        modifiers.some(
          (modifier) =>
            modifier.kind === ts.SyntaxKind.ExportKeyword ||
            modifier.kind === ts.SyntaxKind.DefaultKeyword,
        )
      ) {
        return true;
      }
    }
    declaration = declaration.parent;
  }

  if (!symbol) return false;
  for (const statement of sourceFile.statements) {
    if (
      !ts.isExportDeclaration(statement) ||
      !statement.exportClause ||
      !ts.isNamedExports(statement.exportClause)
    ) {
      continue;
    }
    for (const specifier of statement.exportClause.elements) {
      const localName = specifier.propertyName ?? specifier.name;
      if (checker.getSymbolAtLocation(localName) === symbol) return true;
    }
  }
  return false;
}

function addBindingNames(name, ruleId, add) {
  if (ts.isIdentifier(name)) {
    add(name, ruleId);
    return;
  }
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) {
        addBindingNames(element.name, ruleId, add);
      }
    }
  }
}

function collectUnusedBindings(
  sourceFiles,
  sourceFile,
  root,
  checker,
  findings,
) {
  const candidates = [];
  const moduleLike =
    ts.isExternalModule(sourceFile) || hasCommonJsSyntax(sourceFile);

  function add(name, ruleId) {
    if (!name || !ts.isIdentifier(name)) return;
    if (ruleId === "unused-parameter" && name.text.startsWith("_")) return;
    if (!moduleLike && isTopLevelDeclaration(name, sourceFile)) return;
    const symbol = checker.getSymbolAtLocation(name);
    if (
      symbol &&
      (ruleId === "unused-parameter" ||
        !isExportedBinding(name, sourceFile, checker))
    ) {
      candidates.push({ name, symbol, ruleId });
    }
  }

  function collect(node) {
    if (ts.isVariableDeclaration(node)) {
      const ruleId =
        node.parent.flags & ts.NodeFlags.Const
          ? "unused-constant"
          : "unused-variable";
      addBindingNames(node.name, ruleId, add);
    } else if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node)
    ) {
      add(node.name, "unused-function");
    } else if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      add(node.name, "unused-class");
    } else if (ts.isParameter(node)) {
      addBindingNames(node.name, "unused-parameter", add);
    } else if (ts.isImportClause(node)) {
      add(node.name, "unused-import");
    } else if (ts.isImportEqualsDeclaration(node)) {
      add(node.name, "unused-import");
    } else if (ts.isNamespaceImport(node)) {
      add(node.name, "unused-import");
    } else if (ts.isImportSpecifier(node)) {
      add(node.name, "unused-import");
    } else if (
      ts.isTypeAliasDeclaration(node) ||
      ts.isInterfaceDeclaration(node)
    ) {
      add(node.name, "unused-type");
    }
    ts.forEachChild(node, collect);
  }
  collect(sourceFile);

  const referenced = new Set();
  for (const candidateFile of sourceFiles) {
    function count(node) {
      if (ts.isIdentifier(node)) {
        const symbol =
          ts.isShorthandPropertyAssignment(node.parent) &&
          node.parent.name === node
            ? checker.getShorthandAssignmentValueSymbol(node.parent)
            : checker.getSymbolAtLocation(node);
        if (symbol && !isDeclarationName(node, symbol)) {
          referenced.add(symbol);
        }
      }
      ts.forEachChild(node, count);
    }
    count(candidateFile);
  }

  for (const candidate of candidates) {
    if (referenced.has(candidate.symbol)) continue;
    findings.push(
      createFinding(
        sourceFile,
        root,
        candidate.ruleId,
        candidate.name,
        `${candidate.name.text} is declared but never read.`,
      ),
    );
  }
}

function analyzeCompilerDiagnostics(sourceFile, root, diagnostics, findings) {
  for (const diagnostic of diagnostics) {
    if (diagnostic.file !== sourceFile || diagnostic.start === undefined)
      continue;
    const ruleId = DIAGNOSTIC_RULES.get(diagnostic.code);
    if (!ruleId) continue;
    const node = getSmallestNodeAt(sourceFile, diagnostic.start);
    const message = ts.flattenDiagnosticMessageText(
      diagnostic.messageText,
      " ",
    );
    findings.push(createFinding(sourceFile, root, ruleId, node, message));
  }
}

export function listRules() {
  return RULES.map((rule) => ({ ...rule }));
}

function analyzeCrossFileDuplicateCode(sourceFiles, root) {
  const printer = ts.createPrinter({ removeComments: true });
  const firstByBody = new Map();
  const findings = [];

  for (const sourceFile of sourceFiles) {
    if (sourceFile.parseDiagnostics.length > 0) continue;

    function visit(node) {
      if (
        ts.isFunctionLike(node) &&
        node.body &&
        ts.isBlock(node.body) &&
        node.body.statements.length >= 4
      ) {
        const normalizedBody = printer
          .printNode(ts.EmitHint.Unspecified, node.body, sourceFile)
          .trim();
        const previous = firstByBody.get(normalizedBody);
        if (previous && previous.filePath !== sourceFile.fileName) {
          const previousFilePath = path
            .relative(root, previous.filePath)
            .split(path.sep)
            .join("/");
          findings.push(
            createFinding(
              sourceFile,
              root,
              "duplicate-code",
              node.name ?? node,
              `Function body duplicates code in ${previousFilePath}.`,
            ),
          );
        } else if (!previous) {
          firstByBody.set(normalizedBody, {
            filePath: sourceFile.fileName,
          });
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }

  return findings;
}

export async function analyzeProject({
  root = process.cwd(),
  config,
  changedFiles,
} = {}) {
  if (!config || typeof config !== "object") {
    throw new TypeError("A Cleanser configuration object is required.");
  }
  if (
    changedFiles !== undefined &&
    (!Array.isArray(changedFiles) ||
      changedFiles.some(
        (filePath) => typeof filePath !== "string" || filePath.length === 0,
      ))
  ) {
    throw new TypeError(
      '"changedFiles" must be an array of project-relative paths.',
    );
  }

  const absoluteRoot = path.resolve(root);
  const changedPathSet =
    changedFiles === undefined
      ? undefined
      : new Set(changedFiles.map((filePath) => filePath.replace(/\\/g, "/")));
  const candidates = (await collectProjectFiles(absoluteRoot, config)).filter(
    (filePath) =>
      ANALYZABLE_EXTENSIONS.has(path.extname(filePath).toLowerCase()) &&
      (!changedPathSet ||
        changedPathSet.has(
          path.relative(absoluteRoot, filePath).split(path.sep).join("/"),
        )),
  );
  const files = [];
  for (const filePath of candidates) {
    if (await isSafeProjectFile(absoluteRoot, filePath)) files.push(filePath);
  }
  const sourceByPath = new Map();
  for (const filePath of files) {
    sourceByPath.set(path.normalize(filePath), await readCachedText(filePath));
  }

  const options = {
    allowJs: true,
    checkJs: true,
    noEmit: true,
    noLib: true,
    noResolve: true,
    allowUnreachableCode: false,
    // Ask TypeScript to report labels that are never targeted by break/continue.
    allowUnusedLabels: false,
    skipLibCheck: true,
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    jsx: ts.JsxEmit.Preserve,
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (
    fileName,
    languageVersion,
    onError,
    shouldCreateNewSourceFile,
  ) => {
    const source = sourceByPath.get(path.normalize(path.resolve(fileName)));
    if (source !== undefined) {
      return ts.createSourceFile(
        fileName,
        source,
        languageVersion,
        true,
        scriptKind(fileName),
      );
    }
    return getSourceFile(
      fileName,
      languageVersion,
      onError,
      shouldCreateNewSourceFile,
    );
  };
  const program = ts.createProgram({ rootNames: files, options, host });
  const sourceFiles = program
    .getSourceFiles()
    .filter((sourceFile) =>
      sourceByPath.has(path.normalize(path.resolve(sourceFile.fileName))),
    );
  const sourceFileByPath = new Map(
    sourceFiles.map((sourceFile) => [
      path.normalize(path.resolve(sourceFile.fileName)),
      sourceFile,
    ]),
  );
  const checker = program.getTypeChecker();
  const diagnostics = sourceFiles.flatMap((sourceFile) => [
    ...program.getSyntacticDiagnostics(sourceFile),
    ...program.getSemanticDiagnostics(sourceFile),
  ]);
  const findings = [];

  for (const sourceFile of sourceFiles) {
    analyzeComments(sourceFile, absoluteRoot, findings);
    for (const diagnostic of program.getSyntacticDiagnostics(sourceFile)) {
      const node = getSmallestNodeAt(sourceFile, diagnostic.start ?? 0);
      findings.push(
        createFinding(
          sourceFile,
          absoluteRoot,
          "syntax-error",
          node,
          ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
          "error",
        ),
      );
    }
    analyzeCompilerDiagnostics(sourceFile, absoluteRoot, diagnostics, findings);
    analyzeTree(sourceFile, absoluteRoot, checker, findings);
    collectUnusedBindings(
      sourceFiles,
      sourceFile,
      absoluteRoot,
      checker,
      findings,
    );
  }

  findings.push(...analyzeCrossFileDuplicateCode(sourceFiles, absoluteRoot));

  const dependencyGraph = await buildDependencyGraph({
    root: absoluteRoot,
    config,
  });
  for (const brokenImport of dependencyGraph.brokenImports) {
    const sourceFile = sourceFileByPath.get(
      path.normalize(path.resolve(absoluteRoot, brokenImport.sourcePath)),
    );
    if (!sourceFile) continue;
    findings.push(
      createFinding(
        sourceFile,
        absoluteRoot,
        "broken-import",
        getSmallestNodeAt(sourceFile, brokenImport.start),
        `Relative import "${brokenImport.specifier}" does not resolve inside the configured project files.`,
      ),
    );
  }
  for (const cycle of dependencyGraph.cycles) {
    const edge = dependencyGraph.edges.find(
      (candidate) =>
        candidate.sourcePath === cycle[0] &&
        candidate.targetPath &&
        cycle.includes(candidate.targetPath),
    );
    if (!edge) continue;
    const sourceFile = sourceFileByPath.get(
      path.normalize(path.resolve(absoluteRoot, edge.sourcePath)),
    );
    if (!sourceFile) continue;
    findings.push(
      createFinding(
        sourceFile,
        absoluteRoot,
        "circular-dependency",
        getSmallestNodeAt(sourceFile, edge.start),
        `Circular dependency component contains: ${cycle.join(", ")}.`,
      ),
    );
  }

  const unique = new Map();
  for (const finding of findings) {
    if (changedPathSet && !changedPathSet.has(finding.filePath)) continue;
    const fileConfig = resolveFileConfig(config, finding.filePath);
    const configuredSeverity = fileConfig.analysis?.rules?.[finding.ruleId];
    if (configuredSeverity === "off") continue;
    const effectiveFinding = configuredSeverity
      ? { ...finding, severity: configuredSeverity }
      : finding;
    const key = `${finding.filePath}\0${finding.ruleId}\0${finding.start}\0${finding.message}`;
    if (!unique.has(key)) unique.set(key, effectiveFinding);
  }

  return [...unique.values()].sort(
    (left, right) =>
      compareText(left.filePath, right.filePath) ||
      left.start - right.start ||
      compareText(left.ruleId, right.ruleId),
  );
}
