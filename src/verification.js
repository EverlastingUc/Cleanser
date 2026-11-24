import fs from "node:fs/promises";
import path from "node:path";
import { collectProjectFiles, formatSource } from "./cleaner.js";
import { compareCompilerOutput } from "./compiler-compare.js";

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export async function verifyDeterministicFormatting({
  config,
  root = process.cwd(),
  compilerOutput = false,
} = {}) {
  if (typeof compilerOutput !== "boolean") {
    throw new TypeError("Compiler-output comparison must be a boolean.");
  }
  const absoluteRoot = path.resolve(root);
  const files = await collectProjectFiles(absoluteRoot, config);
  const results = [];

  for (const absolutePath of files) {
    const filePath = path
      .relative(absoluteRoot, absolutePath)
      .split(path.sep)
      .join("/");
    try {
      const source = await fs.readFile(absolutePath, "utf8");
      const first = await formatSource(source, absolutePath, config);
      const second = await formatSource(source, absolutePath, config);
      const result = {
        filePath,
        status: first === second ? "deterministic" : "nondeterministic",
      };
      if (compilerOutput) {
        const comparison = compareCompilerOutput(source, first, absolutePath);
        if (comparison.applicable) {
          result.compilerOutputEquivalent = comparison.equivalent;
          if (!comparison.equivalent) {
            result.compilerOutputDifference = comparison.difference;
            result.status = "compiler-output-mismatch";
          }
        }
      }
      results.push(result);
    } catch (error) {
      results.push({
        filePath,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  results.sort((left, right) => compareText(left.filePath, right.filePath));
  const summary = {
    filesScanned: results.length,
    deterministic: results.filter((item) => item.status === "deterministic")
      .length,
    nondeterministic: results.filter(
      (item) => item.status === "nondeterministic",
    ).length,
    errors: results.filter((item) => item.status === "error").length,
  };
  if (compilerOutput) {
    summary.compilerFilesScanned = results.filter((item) =>
      Object.hasOwn(item, "compilerOutputEquivalent"),
    ).length;
    summary.compilerMismatches = results.filter(
      (item) => item.status === "compiler-output-mismatch",
    ).length;
  }

  return { files: results, summary };
}
