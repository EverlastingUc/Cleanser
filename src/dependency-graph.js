import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { collectProjectFiles, isSafeProjectFile } from "./cleaner.js";

const CODE_EXTENSIONS = new Set([
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

function addReference(node, sourceFile, references) {
  if (!node || !ts.isStringLiteralLike(node)) return;
  references.push({
    specifier: node.text,
    start: node.getStart(sourceFile),
    end: node.getEnd(),
    line:
      sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line +
      1,
    column:
      sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
        .character + 1,
  });
}

function collectReferences(sourceFile) {
  const references = [];

  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier
    ) {
      addReference(node.moduleSpecifier, sourceFile, references);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      addReference(node.arguments[0], sourceFile, references);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return references.sort(
    (left, right) =>
      left.start - right.start || compareText(left.specifier, right.specifier),
  );
}

function resolveLocalImport(root, sourceFile, specifier, projectFiles) {
  if (!specifier.startsWith(".")) return undefined;

  const target = path.resolve(path.dirname(sourceFile), specifier);
  const rootRelative = path.relative(root, target);
  if (
    rootRelative === ".." ||
    rootRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(rootRelative)
  ) {
    return undefined;
  }

  const candidates = [target];
  const extension = path.extname(target).toLowerCase();
  const replacementExtensions = {
    ".js": [".ts", ".tsx", ".d.ts"],
    ".jsx": [".tsx", ".ts"],
    ".mjs": [".mts"],
    ".cjs": [".cts"],
  };
  for (const replacement of replacementExtensions[extension] ?? []) {
    candidates.push(target.slice(0, -extension.length) + replacement);
  }

  if (!extension) {
    for (const candidateExtension of CODE_EXTENSIONS) {
      candidates.push(`${target}${candidateExtension}`);
      candidates.push(path.join(target, `index${candidateExtension}`));
    }
  }

  return candidates.find((candidate) =>
    projectFiles.has(path.resolve(candidate)),
  );
}

function findCycles(nodes, edges) {
  const adjacency = new Map(nodes.map((node) => [node, []]));
  for (const edge of edges) {
    if (edge.targetPath) adjacency.get(edge.sourcePath).push(edge.targetPath);
  }
  for (const targets of adjacency.values()) targets.sort(compareText);

  let nextIndex = 0;
  const indexes = new Map();
  const lowLinks = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];

  function connect(node) {
    indexes.set(node, nextIndex);
    lowLinks.set(node, nextIndex);
    nextIndex++;
    stack.push(node);
    onStack.add(node);

    for (const target of adjacency.get(node)) {
      if (!indexes.has(target)) {
        connect(target);
        lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(target)));
      } else if (onStack.has(target)) {
        lowLinks.set(node, Math.min(lowLinks.get(node), indexes.get(target)));
      }
    }

    if (lowLinks.get(node) === indexes.get(node)) {
      const component = [];
      let current;
      do {
        current = stack.pop();
        onStack.delete(current);
        component.push(current);
      } while (current !== node);
      if (
        component.length > 1 ||
        adjacency.get(component[0]).includes(component[0])
      ) {
        components.push(component.sort(compareText));
      }
    }
  }

  for (const node of nodes) {
    if (!indexes.has(node)) connect(node);
  }
  return components.sort((left, right) => compareText(left[0], right[0]));
}

export async function buildDependencyGraph({
  root = process.cwd(),
  config,
} = {}) {
  if (!config || typeof config !== "object") {
    throw new TypeError("A Cleanser configuration object is required.");
  }

  const absoluteRoot = path.resolve(root);
  const candidates = (await collectProjectFiles(absoluteRoot, config))
    .filter((filePath) =>
      CODE_EXTENSIONS.has(path.extname(filePath).toLowerCase()),
    )
    .sort(compareText);
  const files = [];
  for (const filePath of candidates) {
    if (await isSafeProjectFile(absoluteRoot, filePath)) files.push(filePath);
  }
  const projectFiles = new Set(files.map((filePath) => path.resolve(filePath)));
  const nodes = files.map((filePath) =>
    path.relative(absoluteRoot, filePath).split(path.sep).join("/"),
  );
  const edges = [];
  const brokenImports = [];

  for (const filePath of files) {
    const source = await fs.readFile(filePath, "utf8");
    const sourceFile = ts.createSourceFile(
      filePath,
      source,
      ts.ScriptTarget.Latest,
      true,
      scriptKind(filePath),
    );
    const sourcePath = path
      .relative(absoluteRoot, filePath)
      .split(path.sep)
      .join("/");

    for (const reference of collectReferences(sourceFile)) {
      if (!reference.specifier.startsWith(".")) continue;
      const targetFile = resolveLocalImport(
        absoluteRoot,
        filePath,
        reference.specifier,
        projectFiles,
      );
      const targetPath = targetFile
        ? path.relative(absoluteRoot, targetFile).split(path.sep).join("/")
        : undefined;
      const edge = { sourcePath, targetPath, ...reference };
      edges.push(edge);
      if (!targetPath) brokenImports.push(edge);
    }
  }

  edges.sort(
    (left, right) =>
      compareText(left.sourcePath, right.sourcePath) ||
      left.start - right.start ||
      compareText(left.specifier, right.specifier),
  );
  brokenImports.sort(
    (left, right) =>
      compareText(left.sourcePath, right.sourcePath) ||
      left.start - right.start,
  );

  return {
    nodes,
    edges,
    brokenImports,
    cycles: findCycles(nodes, edges),
  };
}
