import test from "node:test";
import assert from "node:assert/strict";
import {
  CHANGE_CONFIDENCE,
  CHANGE_RISK,
  classifyChange,
  classifyConfidence,
} from "../src/risk.js";

test("classifies parser-verified formatting as safe and mismatches for review", () => {
  assert.equal(
    classifyChange({ kind: "format", astEquivalent: true }),
    CHANGE_RISK.SAFE,
  );
  assert.equal(
    classifyChange({ kind: "format", astEquivalent: false }),
    CHANGE_RISK.REVIEW,
  );
  assert.equal(classifyChange({ kind: "format" }), CHANGE_RISK.LOW);
});

test("requires review for semantic or destructive changes", () => {
  assert.equal(
    classifyChange({ kind: "semantic-refactor", astEquivalent: true }),
    CHANGE_RISK.REVIEW,
  );
  assert.equal(classifyChange({ kind: "destructive" }), CHANGE_RISK.REVIEW);
  assert.equal(classifyChange({ requiresReview: true }), CHANGE_RISK.REVIEW);
  assert.equal(classifyChange({ kind: "unknown" }), CHANGE_RISK.LOW);
});

test("assigns confidence from parser evidence", () => {
  assert.equal(
    classifyConfidence({ astEquivalent: true }),
    CHANGE_CONFIDENCE.HIGH,
  );
  assert.equal(
    classifyConfidence({ astEquivalent: false }),
    CHANGE_CONFIDENCE.HIGH,
  );
  assert.equal(classifyConfidence(), CHANGE_CONFIDENCE.MEDIUM);
  assert.equal(
    classifyConfidence({ parserAvailable: false }),
    CHANGE_CONFIDENCE.LOW,
  );
});
