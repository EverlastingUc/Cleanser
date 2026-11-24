import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG } from "../src/config.js";
import { cleanProject } from "../src/cleaner.js";
import { reportCleanupScore } from "../src/score.js";

test("cleanup score is deterministic, read-only, and improves after formatting", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cleanser-score-"));
  try {
    const file = path.join(root, "answer.js");
    const source = "/** The answer constant. */\nexport const answer=42";
    await fs.writeFile(file, source);

    const first = await reportCleanupScore({ root, config: DEFAULT_CONFIG });
    const second = await reportCleanupScore({ root, config: DEFAULT_CONFIG });
    assert.deepEqual(first, second);
    assert.equal(first.summary.filesScanned, 1);
    assert.equal(first.summary.filesNeedingFormatting, 1);
    assert.equal(first.summary.formattingScore, 0);
    assert.equal(await fs.readFile(file, "utf8"), source);

    await cleanProject({ root, config: DEFAULT_CONFIG, write: true });
    const clean = await reportCleanupScore({ root, config: DEFAULT_CONFIG });
    assert.equal(clean.summary.filesNeedingFormatting, 0);
    assert.equal(clean.summary.score, 100);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
