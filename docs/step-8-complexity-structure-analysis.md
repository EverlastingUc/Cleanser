# Step 8 — Complexity & Structure Analysis

## Cross-file duplication metrics

Project metrics now compare normalized function bodies across every safely analyzed JavaScript and TypeScript-family file, not only within an individual file.

A candidate must be a block-bodied function with at least four statements. TypeScript's printer removes comments and normalizes the syntax tree before Cleanser computes a SHA-256 signature. The first occurrence in deterministic, sorted file order is treated as the canonical copy; each later exact match contributes its function span to duplicate-line and duplicate-function totals.

Per-file duplication metrics identify where the later copies occur. Project-level duplication percentage is calculated as:

`duplicate lines / analyzed source lines × 100`

This remains a conservative exact-match metric. It does not identify renamed variables, reordered statements, semantically equivalent code, or other near-duplicates. A reported duplicate is a refactoring candidate, not proof that the functions can safely be merged.

## Safety and performance

Analysis is read-only. Signatures are used internally to compare candidates; source bodies are not copied into the final project metrics report. Files are processed in deterministic path order so results are reproducible.
