# Step 6 — Import & Dependency Management

## Scope

Step 6 strengthens the existing import diagnostics with one narrowly scoped source transformation. The change is opt-in through the existing safe quick-fix mechanism; analysis itself remains read-only.

## Duplicate named-import merge

Cleanser can merge two adjacent import declarations when all of these conditions hold:

- Both declarations import named bindings from the exact same module specifier.
- Neither declaration includes a default binding, namespace binding, import attributes, or legacy assertion.
- Both declarations use the same declaration-level `import type` mode.
- The imports are adjacent top-level statements with whitespace only between them.
- No comments occur across the replacement range.
- No imported local binding name collides.

The fix preserves each named import specifier, including aliases and per-specifier type modifiers, and preserves whether the first declaration ends in a semicolon.

## Deliberate non-transformations

Cleanser does not automatically merge side-effect imports, default imports, namespace imports, mixed import modes, non-adjacent imports, imports with comments or attributes, or declarations with binding collisions. These cases remain diagnostics for human review.

Unused-import removal, import path normalization, and relative-extension normalization remain report-only. They can change side effects, module resolution, or runtime behavior and are not safe to infer from syntax alone.

## Verification

Dedicated regression assertions cover a valid named-import merge, binding-collision rejection, and comment-preservation rejection. Runtime status remains pending until the Step 6 CI workflow completes.
