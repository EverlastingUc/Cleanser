import fs from "node:fs/promises";
import path from "node:path";
import { inspectSourceMetrics } from "./analyzer.js";
import { collectProjectFiles, isSafeProjectFile } from "./cleaner.js";

const SOURCE_EXTENSIONS = new Set([
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

export function renderCallGraph(report) {
  const nodes = [];
  const functionsByFile = new Map();
  const nodeByFunction = new Map();
  for (const file of report.files) {
    if (!file.metrics) continue;
    file.metrics.functions.forEach((fn) => {
      const node = {
        id: `function${nodes.length}`,
        filePath: file.filePath,
        name: fn.name,
        startLine: fn.startLine,
      };
      nodes.push(node);
      nodeByFunction.set(fn, node);
      const sameName = functionsByFile.get(file.filePath) ?? new Map();
      const candidates = sameName.get(fn.name) ?? [];
      candidates.push(node);
      sameName.set(fn.name, candidates);
      functionsByFile.set(file.filePath, sameName);
    });
  }

  if (nodes.length === 0) return "No function bodies found.";
  const lines = ["flowchart TD"];
  for (const node of nodes) {
    const label = `${node.filePath}:${node.startLine} ${node.name}`.replaceAll(
      '"',
      "&quot;",
    );
    lines.push(`  ${node.id}["${label}"]`);
  }
  const edges = new Set();
  for (const file of report.files) {
    if (!file.metrics) continue;
    const sameName = functionsByFile.get(file.filePath);
    for (const fn of file.metrics.functions) {
      const caller = nodeByFunction.get(fn);
      if (!caller) continue;
      for (const call of fn.calls ?? []) {
        if (call.name.includes(".")) continue;
        const candidates = sameName.get(call.name) ?? [];
        if (candidates.length !== 1) continue;
        const key = `${caller.id}\0${candidates[0].id}`;
        if (edges.has(key)) continue;
        edges.add(key);
        lines.push(`  ${caller.id} --> ${candidates[0].id}`);
      }
    }
  }
  return lines.join("\n");
}

export function renderControlFlowGraphs(report) {
  const lines = ["flowchart TD"];
  let functionIndex = 0;
  let graphCount = 0;
  for (const file of report.files) {
    if (!file.metrics) continue;
    for (const fn of file.metrics.functions) {
      const graph = fn.controlFlowGraph;
      if (!graph) continue;
      graphCount++;
      const prefix = `flow${functionIndex++}`;
      const idByNode = new Map(
        graph.nodes.map((node) => [node.id, `${prefix}_${node.id}`]),
      );
      for (const node of graph.nodes) {
        const label =
          `${file.filePath}:${fn.startLine} ${fn.name} — ${node.kind}: ${node.label}`
            .replaceAll('"', "&quot;")
            .replaceAll("[", "&#91;")
            .replaceAll("]", "&#93;")
            .replaceAll("\n", " ");
        lines.push(`  ${idByNode.get(node.id)}["${label}"]`);
      }
      for (const edge of graph.edges) {
        const from = idByNode.get(edge.from);
        const to = idByNode.get(edge.to);
        if (!from || !to) continue;
        lines.push(
          edge.kind === "next"
            ? `  ${from} --> ${to}`
            : `  ${from} -->|${edge.kind.replaceAll("|", " ")}| ${to}`,
        );
      }
    }
  }
  return graphCount === 0
    ? "No function control-flow graphs found."
    : lines.join("\n");
}

export async function reportProjectMetrics({
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
      SOURCE_EXTENSIONS.has(path.extname(filePath).toLowerCase()) &&
      (!changedPathSet ||
        changedPathSet.has(
          path.relative(absoluteRoot, filePath).split(path.sep).join("/"),
        )),
  );
  const files = [];

  for (const filePath of candidates) {
    if (!(await isSafeProjectFile(absoluteRoot, filePath))) continue;
    const relativePath = path
      .relative(absoluteRoot, filePath)
      .split(path.sep)
      .join("/");
    const source = await fs.readFile(filePath, "utf8");
    try {
      files.push({
        filePath: relativePath,
        metrics: inspectSourceMetrics(source, relativePath),
      });
    } catch (error) {
      files.push({ filePath: relativePath, error: error.message });
    }
  }

  files.sort((left, right) => compareText(left.filePath, right.filePath));
  const validMetrics = files.flatMap((file) =>
    file.metrics ? [file.metrics] : [],
  );
  const totalLines = validMetrics.reduce(
    (sum, metrics) => sum + metrics.lineCount,
    0,
  );
  const duplicateLines = validMetrics.reduce(
    (sum, metrics) => sum + metrics.duplication.duplicateLines,
    0,
  );
  const weightedMaintainability = validMetrics.reduce(
    (sum, metrics) => sum + metrics.maintainabilityIndex * metrics.lineCount,
    0,
  );
  const averageMaintainabilityIndex =
    totalLines === 0
      ? 100
      : Number((weightedMaintainability / totalLines).toFixed(2));
  const duplicationPercentage =
    totalLines === 0
      ? 0
      : Number(((duplicateLines / totalLines) * 100).toFixed(2));
  const variableLifetimes = validMetrics.flatMap((metrics) =>
    metrics.functions.flatMap((fn) => fn.variableLifetimes ?? []),
  );
  const totalVariableLifetimeLines = variableLifetimes.reduce(
    (sum, variable) => sum + variable.lifetimeLines,
    0,
  );

  return {
    algorithm: {
      maintainabilityIndex:
        "A deterministic 0–100 approximation of the classic Maintainability Index using AST operator and operand nodes for Halstead volume, plus cyclomatic complexity and source-line count.",
      codeHealthScore:
        "The line-weighted average maintainability index minus two points for each percentage point of duplicate lines, clamped to 0–100; it is a documented code-health proxy, not a quality guarantee.",
      duplication:
        "Exact repeated block-bodied functions with at least four statements within each file after TypeScript printer normalization; cross-file and near-duplicate matches are excluded.",
      variableLifetime:
        "Reports the source-line span from a parameter or local declaration to its last same-name reference in the function text. Shadowed names and runtime closure lifetimes can widen or shorten this estimate.",
    },
    summary: {
      fileCount: files.length,
      analyzedFileCount: validMetrics.length,
      parseErrorCount: files.length - validMetrics.length,
      totalLines,
      functionCount: validMetrics.reduce(
        (sum, metrics) => sum + metrics.functionCount,
        0,
      ),
      variableCount: variableLifetimes.length,
      averageVariableLifetimeLines:
        variableLifetimes.length === 0
          ? 0
          : Number(
              (totalVariableLifetimeLines / variableLifetimes.length).toFixed(
                2,
              ),
            ),
      classCount: validMetrics.reduce(
        (sum, metrics) => sum + metrics.classCount,
        0,
      ),
      cyclomaticComplexity: validMetrics.reduce(
        (sum, metrics) => sum + metrics.cyclomaticComplexity,
        0,
      ),
      cognitiveComplexity: validMetrics.reduce(
        (sum, metrics) => sum + metrics.cognitiveComplexity,
        0,
      ),
      dependencyCount: new Set(
        validMetrics.flatMap((metrics) => metrics.dependencies),
      ).size,
      duplicateFunctionCount: validMetrics.reduce(
        (sum, metrics) => sum + metrics.duplication.duplicateFunctionCount,
        0,
      ),
      duplicateLines,
      duplicationPercentage,
      averageMaintainabilityIndex,
      codeHealthScore: Number(
        Math.max(
          0,
          averageMaintainabilityIndex - duplicationPercentage * 2,
        ).toFixed(2),
      ),
    },
    files,
  };
}
