import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startPlaygroundServer } from "../src/playground.js";

const configTemplatePath = fileURLToPath(
  new URL("../templates/cleanser.clns", import.meta.url),
);

test("playground formats local input without writing project files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cleanser-playground-"));
  const originalPath = path.join(root, "sample.js");
  const original = "const untouched=1";
  await fs.writeFile(
    path.join(root, ".cleanser.clns"),
    await fs.readFile(configTemplatePath, "utf8"),
  );
  await fs.writeFile(originalPath, original);
  const playground = await startPlaygroundServer({ root });

  try {
    assert.match(playground.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    const page = await fetch(playground.url);
    assert.equal(page.status, 200);
    assert.match(
      page.headers.get("content-security-policy"),
      /script-src 'nonce-/,
    );
    assert.match(await page.text(), /Cleanser Playground/);

    const formatted = await fetch(new URL("/format", playground.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        language: "javascript",
        source: "const answer=42",
      }),
    });
    assert.equal(formatted.status, 200);
    assert.equal((await formatted.json()).formatted, "const answer = 42;\n");
    assert.equal(await fs.readFile(originalPath, "utf8"), original);

    const caseInsensitiveContentType = await fetch(
      new URL("/format", playground.url),
      {
        method: "POST",
        headers: { "Content-Type": "Application/JSON ; charset=UTF-8" },
        body: JSON.stringify({
          language: "javascript",
          source: "const compatible=42",
        }),
      },
    );
    assert.equal(caseInsensitiveContentType.status, 200);
    assert.equal(
      (await caseInsensitiveContentType.json()).formatted,
      "const compatible = 42;\n",
    );

    const invalid = await fetch(new URL("/format", playground.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language: "python", source: "print(1)" }),
    });
    assert.equal(invalid.status, 400);

    const oversized = await fetch(new URL("/format", playground.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        language: "javascript",
        source: "x".repeat(1_000_000),
      }),
    });
    assert.equal(oversized.status, 413);
  } finally {
    await playground.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("playground refuses to listen on non-loopback addresses", async () => {
  await assert.rejects(
    startPlaygroundServer({ root: process.cwd(), host: "0.0.0.0" }),
    /loopback addresses/,
  );
});
