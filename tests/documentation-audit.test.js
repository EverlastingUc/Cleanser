import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { auditMarkdownDocuments } from "../src/documentation-audit.js";

test("validates local Markdown links, heading references, and heading levels", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cleanser-docs-"));
  try {
    await fs.writeFile(path.join(root, "guide.md"), "# Start\n\n## Setup\n");
    await fs.writeFile(
      path.join(root, "README.md"),
      [
        "# Project",
        "### Skipped level",
        "[missing page](./missing.md)",
        "[missing heading](guide.md#not-here)",
        "[valid heading](guide.md#setup)",
        "[external](https://example.invalid)",
      ].join("\n"),
    );

    const result = await auditMarkdownDocuments({
      root,
      files: ["README.md", "guide.md"],
    });
    assert.deepEqual(
      result.findings.map((finding) => finding.ruleId),
      [
        "markdown-heading-level",
        "broken-document-link",
        "broken-document-reference",
      ],
    );
    assert.deepEqual(result.summary, {
      documentCount: 2,
      headingCount: 4,
      localLinkCount: 3,
    });
    assert.ok(result.findings.every((finding) => finding.line > 0));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("recognizes Setext headings and ignores headings inside fenced code", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cleanser-docs-"));
  try {
    const source = [
      "Title",
      "=====",
      "#### Skipped level",
      "~~~md",
      "# not a heading",
      "~~~",
      "Section",
      "-------",
    ].join("\n");
    await fs.writeFile(path.join(root, "guide.md"), source);

    const result = await auditMarkdownDocuments({
      root,
      files: ["guide.md"],
    });
    assert.equal(result.summary.headingCount, 3);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].ruleId, "markdown-heading-level");
    assert.equal(result.findings[0].line, 3);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
