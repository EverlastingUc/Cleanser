import test from "node:test";
import assert from "node:assert/strict";
import {
  createLanguageAdapterRegistry,
  defineLanguageAdapter,
  formatWithLanguageAdapter,
} from "../src/language-adapters.js";

function sampleAdapter(overrides = {}) {
  return defineLanguageAdapter({
    id: "sample",
    extensions: [".sample"],
    format: (source) => source.trimEnd() + "\n",
    verify: (original, formatted) =>
      original.replace(/\s+/gu, "") === formatted.replace(/\s+/gu, ""),
    ...overrides,
  });
}

test("language adapters are immutable and resolve supported extensions", () => {
  const adapter = sampleAdapter();
  const registry = createLanguageAdapterRegistry([adapter]);

  assert.equal(registry.resolve("nested/file.SAMPLE"), adapter);
  assert.equal(registry.resolve("file.js"), undefined);
  assert.ok(Object.isFrozen(adapter));
  assert.ok(Object.isFrozen(adapter.extensions));
});

test("language adapters reject duplicate IDs and extension ownership", () => {
  const first = sampleAdapter();
  const second = defineLanguageAdapter({ ...first, id: "another" });
  assert.throws(
    () => createLanguageAdapterRegistry([first, first]),
    /registered more than once/,
  );
  assert.throws(
    () => createLanguageAdapterRegistry([first, second]),
    /claimed by both/,
  );
});

test("adapter formatting returns only semantically verified output", async () => {
  const adapter = sampleAdapter();
  assert.equal(
    await formatWithLanguageAdapter(adapter, "value", "file.sample"),
    "value\n",
  );

  const unsafe = sampleAdapter({
    format: () => "different program",
    verify: () => false,
  });
  await assert.rejects(
    formatWithLanguageAdapter(unsafe, "original", "file.sample"),
    /semantic equivalence was not confirmed/,
  );
});

test("language adapters validate descriptors and formatter results", async () => {
  assert.throws(
    () =>
      defineLanguageAdapter({
        id: "bad",
        extensions: [".TXT"],
        format() {},
        verify() {
          return true;
        },
      }),
    /unique, lowercase file extensions/,
  );
  assert.throws(
    () =>
      defineLanguageAdapter({
        id: "no-verifier",
        extensions: [".x"],
        format() {},
      }),
    /verification function/,
  );
  const invalidResult = sampleAdapter({ format: () => undefined });
  await assert.rejects(
    formatWithLanguageAdapter(invalidResult, "source", "file.sample"),
    /must return formatted text/,
  );
  await assert.rejects(
    formatWithLanguageAdapter(sampleAdapter(), "source", "file.js"),
    /does not support/,
  );
});
