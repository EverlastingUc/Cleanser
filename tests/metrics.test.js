import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG } from "../src/config.js";
import { inspectSourceMetrics } from "../src/analyzer.js";
import {
  renderCallGraph,
  renderControlFlowGraphs,
  reportProjectMetrics,
} from "../src/metrics.js";

test("reports deterministic per-function complexity and project metrics", () => {
  const source = [
    'import value from "package-name";',
    "export function branch(flag) {",
    "  if (flag) return 1;",
    "  return 0;",
    "}",
    "function first(input) {",
    "  const one = input + 1;",
    "  const two = one * 2;",
    "  const three = two - 1;",
    "  return three;",
    "}",
    "function second(input) {",
    "  const one = input + 1;",
    "  const two = one * 2;",
    "  const three = two - 1;",
    "  return three;",
    "}",
    "class Worker {}",
  ].join("\n");

  const metrics = inspectSourceMetrics(source, "src/example.ts");
  assert.deepEqual(metrics, inspectSourceMetrics(source, "src/example.ts"));
  assert.equal(metrics.lineCount, 18);
  assert.equal(metrics.functionCount, 3);
  assert.equal(metrics.classCount, 1);
  assert.equal(metrics.dependencyCount, 1);
  assert.deepEqual(metrics.dependencies, ["package-name"]);
  assert.equal(metrics.functions[0].name, "branch");
  assert.equal(metrics.functions[0].cyclomaticComplexity, 2);
  assert.equal(metrics.functions[0].cognitiveComplexity, 1);
  assert.equal(metrics.functions[0].parameterCount, 1);
  assert.deepEqual(
    metrics.functions[0].controlFlowGraph.edges
      .filter((edge) => ["true", "false"].includes(edge.kind))
      .map((edge) => edge.kind),
    ["false", "true"],
  );
  const controlFlow = renderControlFlowGraphs({
    files: [{ filePath: "src/example.ts", metrics }],
  });
  assert.match(controlFlow, /\|true\|/);
  assert.match(controlFlow, /\|false\|/);
  assert.equal(metrics.duplication.duplicateFunctionCount, 1);
  assert.ok(metrics.duplication.percentage > 0);
  assert.ok(metrics.maintainabilityIndex >= 0);
  assert.ok(metrics.maintainabilityIndex <= 100);
  assert.ok(metrics.halstead.volume > 0);
});

test("rejects invalid source metrics and reports syntax errors by file", async () => {
  assert.throws(
    () => inspectSourceMetrics("const = ;", "broken.ts"),
    /Could not measure broken.ts/,
  );

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cleanser-metrics-"));
  try {
    await fs.writeFile(path.join(root, "broken.js"), "const = ;");
    await fs.writeFile(
      path.join(root, "valid.ts"),
      "export function ok() {}\n",
    );
    await fs.writeFile(path.join(root, "ignored.json"), "{}");

    const report = await reportProjectMetrics({
      root,
      config: DEFAULT_CONFIG,
    });
    assert.deepEqual(
      report.files.map((file) => file.filePath),
      ["broken.js", "valid.ts"],
    );
    assert.equal(report.summary.fileCount, 2);
    assert.equal(report.summary.analyzedFileCount, 1);
    assert.equal(report.summary.parseErrorCount, 1);
    assert.ok(report.summary.codeHealthScore >= 0);
    assert.ok(report.summary.codeHealthScore <= 100);
    assert.equal(
      report.summary.codeHealthScore,
      Math.max(
        0,
        report.summary.averageMaintainabilityIndex -
          report.summary.duplicationPercentage * 2,
      ),
    );
    assert.match(report.files[0].error, /Could not measure broken.js/);

    const changedOnly = await reportProjectMetrics({
      root,
      config: DEFAULT_CONFIG,
      changedFiles: ["valid.ts"],
    });
    assert.deepEqual(
      changedOnly.files.map((file) => file.filePath),
      ["valid.ts"],
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("metrics expose syntactic call and class relationships", () => {
  const source = [
    "interface Runnable { run(): void }",
    "class Base { base() {} }",
    "class Child extends Base implements Runnable {",
    "  run() { worker(); }",
    "}",
    "function worker() { helper(); }",
    "function helper() {}",
    "export function start() { worker(); }",
  ].join("\n");
  const metrics = inspectSourceMetrics(source, "src/relations.ts");
  const child = metrics.classes.find((item) => item.name === "Child");
  const start = metrics.functions.find((item) => item.name === "start");
  const worker = metrics.functions.find((item) => item.name === "worker");

  assert.deepEqual(child.extends, ["Base"]);
  assert.deepEqual(child.implements, ["Runnable"]);
  assert.deepEqual(child.methods, ["run"]);
  assert.deepEqual(start.calls, [{ name: "worker", line: 8 }]);
  assert.deepEqual(worker.calls, [{ name: "helper", line: 6 }]);

  const report = {
    files: [{ filePath: "src/relations.ts", metrics }],
  };
  const graph = renderCallGraph(report);
  assert.match(graph, /flowchart TD/);
  assert.match(graph, /function4 --> function2/);
  assert.match(graph, /function2 --> function3/);
  assert.equal(Object.hasOwn(start, "graphNode"), false);
  const controlFlow = renderControlFlowGraphs(report);
  assert.match(controlFlow, /flowchart TD/);
  assert.match(controlFlow, /statement: worker\(\);/);
});

test("estimates lexical variable reference lifetimes deterministically", () => {
  const source = [
    "export function measure(input: number) {",
    "  const early = 1;",
    "  const late = early + input;",
    "  return late;",
    "}",
  ].join("\n");
  const metrics = inspectSourceMetrics(source, "src/lifetimes.ts");
  assert.deepEqual(
    metrics.functions[0].variableLifetimes.map((item) => ({
      name: item.name,
      kind: item.kind,
      declarationLine: item.declarationLine,
      lastUseLine: item.lastUseLine,
      lifetimeLines: item.lifetimeLines,
      referenceCount: item.referenceCount,
    })),
    [
      {
        name: "input",
        kind: "parameter",
        declarationLine: 1,
        lastUseLine: 3,
        lifetimeLines: 3,
        referenceCount: 1,
      },
      {
        name: "early",
        kind: "const",
        declarationLine: 2,
        lastUseLine: 3,
        lifetimeLines: 2,
        referenceCount: 1,
      },
      {
        name: "late",
        kind: "const",
        declarationLine: 3,
        lastUseLine: 4,
        lifetimeLines: 2,
        referenceCount: 1,
      },
    ],
  );
});
