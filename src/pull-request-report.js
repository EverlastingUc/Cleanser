import { analyzeProject } from "./analyzer.js";
import { previewProject } from "./cleaner.js";
import { listFilesComparedWith } from "./git-tools.js";

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function plainMarkdown(value) {
  return String(value)
    .replace(/[\r\n]+/gu, " ")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "\\|")
    .replaceAll("`", "ˋ")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]");
}

export function renderPullRequestMarkdown(report) {
  const { base, changedFiles, summary, findings, formatting } = report;
  const lines = [
    "# Cleanser pull request report",
    "",
    `Base revision: \`${plainMarkdown(base)}\``,
    `Changed paths: ${changedFiles.length}`,
    `Formatting: ${summary.filesNeedingFormatting} need formatting; ${summary.formattingFilesScanned} scanned; ${summary.formattingSkipped} skipped.`,
    `Findings: ${summary.findings} total (errors ${summary.findingsBySeverity.error}, warnings ${summary.findingsBySeverity.warning}, info ${summary.findingsBySeverity.info}).`,
    "",
    "## Changed paths",
    "",
  ];
  if (changedFiles.length === 0) lines.push("No changed paths were found.");
  else {
    lines.push(
      ...changedFiles.map((filePath) => `- \`${plainMarkdown(filePath)}\``),
    );
  }
  lines.push("", "## Formatting", "");
  if (formatting.length === 0)
    lines.push("No configured formatting files changed.");
  else {
    for (const file of formatting) {
      lines.push(
        `- \`${plainMarkdown(file.filePath)}\`: ${plainMarkdown(file.status)}${file.risk ? ` (risk ${plainMarkdown(file.risk)})` : ""}`,
      );
    }
  }
  lines.push("", "## Findings", "");
  if (findings.length === 0)
    lines.push("No analyzer findings in changed files.");
  else {
    for (const finding of findings) {
      lines.push(
        `- \`${plainMarkdown(finding.filePath)}:${finding.line}:${finding.column}\` **${finding.severity}** \`${plainMarkdown(finding.ruleId)}\` — ${plainMarkdown(finding.message)}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

export async function createPullRequestReport({
  root = process.cwd(),
  config,
  base,
} = {}) {
  if (!config || typeof config !== "object") {
    throw new TypeError("A validated Cleanser configuration is required.");
  }
  if (typeof base !== "string" || base.trim() === "") {
    throw new TypeError("A Git base revision is required.");
  }
  const changedFiles = await listFilesComparedWith({ root, base: base.trim() });
  const [formattingResults, findings] = await Promise.all([
    previewProject({ root, config, changedFiles }),
    analyzeProject({ root, config, changedFiles }),
  ]);
  findings.sort(
    (left, right) =>
      compareText(left.filePath, right.filePath) ||
      left.line - right.line ||
      left.column - right.column ||
      compareText(left.ruleId, right.ruleId),
  );
  const findingsBySeverity = { error: 0, warning: 0, info: 0 };
  for (const finding of findings) findingsBySeverity[finding.severity]++;
  const formatting = formattingResults.map((result) => ({
    filePath: result.filePath,
    status: result.status,
    ...(result.risk ? { risk: result.risk } : {}),
    ...(result.verificationMethod
      ? { verificationMethod: result.verificationMethod }
      : {}),
  }));
  const summary = {
    changedFiles: changedFiles.length,
    formattingFilesScanned: formattingResults.length,
    filesNeedingFormatting: formattingResults.filter(
      (result) => result.status === "changed" || result.status === "unsafe",
    ).length,
    formattingSkipped: formattingResults.filter(
      (result) => result.status === "skipped",
    ).length,
    findings: findings.length,
    findingsBySeverity,
  };
  const report = {
    base: base.trim(),
    changedFiles,
    summary,
    formatting,
    findings,
  };
  return { ...report, markdown: renderPullRequestMarkdown(report) };
}
