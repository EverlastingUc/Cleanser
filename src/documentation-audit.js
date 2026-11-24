import fs from "node:fs/promises";
import path from "node:path";

function toProjectPath(root, absolutePath) {
  return path.relative(root, absolutePath).split(path.sep).join("/");
}

function parseHeadings(source) {
  const headings = [];
  const slugCounts = new Map();
  const lines = (source.match(/.*(?:\r\n|\r|\n|$)/gu) ?? []).filter(
    (line) => line.length > 0,
  );
  let offset = 0;
  let previousLine;
  let previousOffset = 0;
  let fence;
  function add(text, level, headingOffset) {
    const normalizedText = text
      .replace(/`([^`]*)`/g, "$1")
      .replace(/<[^>]*>/g, "")
      .trim();
    const base = normalizedText
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_ -]/gu, "")
      .trim()
      .replace(/\s+/g, "-");
    if (!base) return;
    const occurrence = slugCounts.get(base) ?? 0;
    slugCounts.set(base, occurrence + 1);
    headings.push({
      level,
      slug: occurrence === 0 ? base : `${base}-${occurrence}`,
      offset: headingOffset,
    });
  }
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.replace(/(?:\r\n|\r|\n)$/u, "");
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/u);
    if (fence) {
      if (
        fenceMatch &&
        fenceMatch[1][0] === fence[0] &&
        fenceMatch[1].length >= fence.length
      ) {
        fence = undefined;
      }
      previousLine = undefined;
      offset += rawLine.length;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      previousLine = undefined;
      offset += rawLine.length;
      continue;
    }

    const atx = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/u);
    if (atx) {
      add(atx[2], atx[1].length, offset);
    } else if (previousLine !== undefined) {
      const setext = line.match(/^ {0,3}(=+|-+)\s*$/u);
      if (setext && previousLine.trim() !== "") {
        add(previousLine.trim(), setext[1][0] === "=" ? 1 : 2, previousOffset);
      }
    }
    previousLine = line;
    previousOffset = offset;
    offset += rawLine.length;
  }
  return headings;
}

async function hasSafeTarget(root, targetPath) {
  const relative = path.relative(root, targetPath);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return false;
  }
  let current = root;
  const segments = relative.split(path.sep).filter(Boolean);
  if (segments.length === 0) return true;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    let stats;
    try {
      stats = await fs.lstat(current);
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
    if (stats.isSymbolicLink()) return false;
    if (index < segments.length - 1 && !stats.isDirectory()) return false;
  }
  return true;
}

function createFinding(filePath, source, offset, ruleId, message) {
  const location = source.slice(0, offset).split(/\r?\n/);
  return {
    filePath,
    line: location.length,
    column: location.at(-1).length + 1,
    severity: "info",
    ruleId,
    message,
  };
}

export async function auditMarkdownDocuments({ root, files } = {}) {
  const absoluteRoot = path.resolve(root);
  const documents = new Map();
  for (const filePath of files ?? []) {
    const absolutePath = path.resolve(absoluteRoot, filePath);
    const source = await fs.readFile(absolutePath, "utf8");
    documents.set(absolutePath, {
      filePath: toProjectPath(absoluteRoot, absolutePath),
      source,
      headings: parseHeadings(source),
    });
  }

  const findings = [];
  let headingCount = 0;
  let linkCount = 0;
  for (const [absolutePath, document] of documents) {
    headingCount += document.headings.length;
    let previousLevel = 0;
    for (const heading of document.headings) {
      if (previousLevel > 0 && heading.level > previousLevel + 1) {
        findings.push(
          createFinding(
            document.filePath,
            document.source,
            heading.offset,
            "markdown-heading-level",
            `Heading level skips from H${previousLevel} to H${heading.level}.`,
          ),
        );
      }
      previousLevel = heading.level;
    }

    const markdownLinks = [
      ...document.source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g),
    ];
    for (const match of markdownLinks) {
      const rawTarget = match[1].trim();
      const targetMatch = rawTarget.match(/^<([^>]+)>|^([^\s]+)/);
      if (!targetMatch) continue;
      const target = targetMatch[1] ?? targetMatch[2];
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) continue;
      linkCount++;

      let decodedTarget;
      try {
        decodedTarget = decodeURIComponent(target);
      } catch {
        decodedTarget = target;
      }
      const hashIndex = decodedTarget.indexOf("#");
      const queryIndex = decodedTarget.indexOf("?");
      const pathEnd = [hashIndex, queryIndex]
        .filter((index) => index >= 0)
        .reduce(
          (minimum, index) => Math.min(minimum, index),
          decodedTarget.length,
        );
      const linkedPath = decodedTarget.slice(0, pathEnd);
      const fragment =
        hashIndex >= 0
          ? decodedTarget.slice(
              hashIndex + 1,
              queryIndex > hashIndex ? queryIndex : undefined,
            )
          : "";
      const targetPath = linkedPath
        ? path.resolve(path.dirname(absolutePath), linkedPath)
        : absolutePath;

      if (!(await hasSafeTarget(absoluteRoot, targetPath))) {
        findings.push(
          createFinding(
            document.filePath,
            document.source,
            match.index,
            "broken-document-link",
            "Local Markdown link target does not exist inside the project.",
          ),
        );
        continue;
      }

      if (fragment) {
        const linkedDocument = documents.get(targetPath);
        if (
          linkedDocument &&
          !linkedDocument.headings.some(
            (heading) => heading.slug === fragment.toLowerCase(),
          )
        ) {
          findings.push(
            createFinding(
              document.filePath,
              document.source,
              match.index,
              "broken-document-reference",
              `Heading reference "#${fragment}" does not exist in the linked document.`,
            ),
          );
        }
      }
    }
  }

  return {
    findings,
    summary: {
      documentCount: documents.size,
      headingCount,
      localLinkCount: linkCount,
    },
  };
}
