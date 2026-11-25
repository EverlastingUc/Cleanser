import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const cataloguePath = fileURLToPath(
  new URL("../feature-catalogue.json", import.meta.url),
);

async function readCatalogue() {
  return JSON.parse(await fs.readFile(cataloguePath, "utf8"));
}

test("feature catalogue has one documented status for every numbered feature", async () => {
  const catalogue = await readCatalogue();
  const entries = catalogue.features;

  assert.equal(catalogue.numberedFeatureCount, 341);
  assert.equal(catalogue.canonicalFeatureCount, 337);
  assert.equal(entries.length, 341);
  assert.deepEqual(
    entries.map((entry) => entry.id),
    Array.from({ length: 341 }, (_, index) => index + 1),
  );
  assert.ok(
    entries.every(
      (entry) =>
        entry.name.length > 0 &&
        entry.category.length > 0 &&
        entry.notes.length > 0 &&
        ["Implemented", "Partial", "Duplicate", "Overlap", "Planned"].includes(
          entry.status,
        ),
    ),
  );
});

test("catalogue records exact duplicates and separate overlapping surfaces", async () => {
  const catalogue = await readCatalogue();
  const duplicateEntries = catalogue.features
    .filter((entry) => entry.status === "Duplicate")
    .map((entry) => entry.id);
  assert.deepEqual(duplicateEntries, [104, 262, 301, 334]);
  assert.deepEqual(
    catalogue.relationships
      .filter((relationship) => relationship.relationship === "Duplicate")
      .map((relationship) => relationship.entries),
    [
      [67, 104],
      [148, 262],
      [144, 301],
      [248, 334],
    ],
  );
  assert.deepEqual(
    catalogue.relationships
      .filter((relationship) => relationship.relationship !== "Duplicate")
      .map((relationship) => relationship.entries),
    [
      [267, 283],
      [125, 287],
    ],
  );
});

test("catalogue keeps the ten composite ideas and the additional AST Explorer", async () => {
  const catalogue = await readCatalogue();
  assert.equal(catalogue.compositeIdeas.length, 10);
  assert.deepEqual(catalogue.additionalFeatures, [
    {
      id: 341,
      name: "AST Explorer",
      status: "Implemented",
      notes:
        "ast <file> emits a bounded deterministic JSON syntax tree and parse diagnostics for local JS/TS files.",
    },
  ]);
});
