import test from "node:test";
import assert from "node:assert/strict";
import { inspectSourceAst } from "../src/ast-explorer.js";

test("AST Explorer returns bounded, deterministic TypeScript syntax data", () => {
  const result = inspectSourceAst("const answer = 42;", "src/example.ts", {
    maximumDepth: 2,
  });

  assert.equal(result.filePath, "src/example.ts");
  assert.equal(result.language, "ts");
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.tree.kind, "SourceFile");
  assert.ok(result.tree.children.some((child) => child.kind === "SyntaxList"));
  assert.equal(Object.hasOwn(result.tree, "omittedChildren"), false);
  assert.deepEqual(
    inspectSourceAst("const answer = 42;", "src/example.ts", {
      maximumDepth: 2,
    }),
    result,
  );
});

test("AST Explorer reports parse errors and rejects unsupported extensions", () => {
  const result = inspectSourceAst("const = ;", "broken.js");
  assert.equal(result.diagnostics.length > 0, true);
  assert.throws(
    () => inspectSourceAst("body {}", "page.html"),
    /supports .js, .jsx, .ts, .tsx/,
  );
});

test("AST Explorer supports Node ESM and TypeScript module extensions", () => {
  for (const extension of ["mjs", "cjs", "mts", "cts"]) {
    const result = inspectSourceAst(
      "export const value = 1;",
      `sample.${extension}`,
    );
    assert.equal(result.filePath, `sample.${extension}`);
    assert.deepEqual(result.diagnostics, []);
  }
});
