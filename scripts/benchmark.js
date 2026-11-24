import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { cleanProject } from "../src/cleaner.js";

const templatePath = fileURLToPath(
  new URL("../templates/cleanser.clns", import.meta.url),
);

function readPositiveInteger(name, fallback, maximum) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}.`);
  }
  return value;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

export async function runBenchmark() {
  const fileCount = readPositiveInteger("CLEANSER_BENCH_FILES", 100, 5000);
  const runCount = readPositiveInteger("CLEANSER_BENCH_RUNS", 3, 20);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cleanser-benchmark-"));

  try {
    await fs.writeFile(
      path.join(root, ".cleanser.clns"),
      await fs.readFile(templatePath, "utf8"),
    );
    for (let index = 0; index < fileCount; index++) {
      const source = `export const record${index}={name:'record-${index}',values:[${index},${index + 1},${index + 2}],active:${index % 2 === 0}}`;
      await fs.writeFile(
        path.join(root, `file-${String(index).padStart(5, "0")}.js`),
        source,
      );
    }

    const config = await loadConfig(root);
    await cleanProject({ root, config, write: false });
    const elapsedMs = [];
    let resultCount = 0;
    for (let run = 0; run < runCount; run++) {
      const start = performance.now();
      const results = await cleanProject({ root, config, write: false });
      elapsedMs.push(Number((performance.now() - start).toFixed(2)));
      if (run === 0) resultCount = results.length;
      else if (results.length !== resultCount) {
        throw new Error("Benchmark runs returned inconsistent file counts.");
      }
    }

    return {
      files: resultCount,
      warmupRuns: 1,
      measuredRuns: runCount,
      elapsedMs,
      medianMs: Number(median(elapsedMs).toFixed(2)),
    };
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runBenchmark()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
