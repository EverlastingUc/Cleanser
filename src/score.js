import { analyzeProject } from "./analyzer.js";
import { previewProject } from "./cleaner.js";

const SEVERITY_WEIGHTS = Object.freeze({
  error: 10,
  warning: 3,
  info: 0.5,
});

export async function reportCleanupScore({
  root = process.cwd(),
  config,
  changedFiles,
} = {}) {
  if (!config || typeof config !== "object") {
    throw new TypeError("A Cleanser configuration object is required.");
  }

  const [formatting, findings] = await Promise.all([
    previewProject({ root, config, changedFiles }),
    analyzeProject({ root, config, changedFiles }),
  ]);
  const findingsBySeverity = { error: 0, warning: 0, info: 0 };
  for (const finding of findings) {
    if (finding.severity in findingsBySeverity) {
      findingsBySeverity[finding.severity]++;
    }
  }

  const filesScanned = formatting.length;
  const filesNeedingFormatting = formatting.filter(
    (result) => result.status !== "unchanged",
  ).length;
  const formattingScore =
    filesScanned === 0
      ? 100
      : ((filesScanned - filesNeedingFormatting) / filesScanned) * 100;
  const findingPenalty = Object.entries(SEVERITY_WEIGHTS).reduce(
    (penalty, [severity, weight]) =>
      penalty + findingsBySeverity[severity] * weight,
    0,
  );
  const score = Number(
    Math.max(0, Math.min(100, formattingScore - findingPenalty)).toFixed(2),
  );

  return {
    algorithm: {
      score:
        "Start at the percentage of configured files already formatted; subtract 10 points per error, 3 per warning, and 0.5 per informational analyzer finding; clamp to 0–100 and round to two decimal places.",
      scope:
        "Read-only scan of configured files and built-in JavaScript/TypeScript analyzer findings; this score is a local progress indicator, not a quality guarantee.",
    },
    summary: {
      score,
      formattingScore: Number(formattingScore.toFixed(2)),
      filesScanned,
      filesNeedingFormatting,
      skippedFiles: formatting.filter(
        (result) => result.status === "skipped" || result.status === "unsafe",
      ).length,
      findings: findings.length,
      findingsBySeverity,
    },
  };
}
