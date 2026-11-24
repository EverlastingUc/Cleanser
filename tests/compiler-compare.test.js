import test from "node:test";
import assert from "node:assert/strict";
import { compareCompilerOutput } from "../src/compiler-compare.js";

test("compares JavaScript emitted from formatted TypeScript without running it", () => {
  const source = 'export const message:string="hello"';
  const formatted = 'export const message: string = "hello";\n';
  const comparison = compareCompilerOutput(source, formatted, "sample.ts");

  assert.equal(comparison.applicable, true);
  assert.equal(comparison.equivalent, true);
  assert.equal(comparison.method, "typescript-transpile-ast");
});

test("detects different emitted JavaScript and skips unsupported languages", () => {
  const changed = compareCompilerOutput(
    "export const value = 1;",
    "export const value = 2;",
    "sample.js",
  );
  assert.equal(changed.equivalent, false);
  assert.match(changed.difference, /different JavaScript syntax trees/);

  assert.deepEqual(
    compareCompilerOutput("text", "formatted text", "readme.md"),
    {
      applicable: false,
      equivalent: true,
      difference: undefined,
      method: "not-applicable",
    },
  );
});
