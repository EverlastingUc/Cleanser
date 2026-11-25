# Step 5 — Code Optimization

## Supported optimization suggestions

The analyzer provides conservative suggestions for the Code Optimization catalogue (IDs 41–60), including binding declarations, template literals, nullish operators, boolean ternaries, repeated conditions, type assertions, parentheses, constant expressions, identity maps, object shorthand, empty spreads, redundant returns, and unnecessary `return await`.

## Explicit editor fixes

Quick fixes are opt-in editor actions. Analysis itself never modifies source files.

- **Nullish coalescing:** converts only a loose null check whose retained branch is the same identifier, preserving the fallback branch and its evaluation timing.
- **Optional chaining:** converts only a direct local property or element access guarded by a loose null check and paired with `void 0`.
- Both transformations reject source ranges containing comments.
- Strict-null comparisons are not rewritten because they do not have the same null-and-undefined semantics as loose null checks.
- Existing fixes for template literals, boolean ternaries, object shorthand, redundant parentheses, repeated branches, and empty spreads remain deliberately narrow.

## Deliberate limitations

- No broad algebraic simplification or speculative control-flow restructuring is performed.
- Identity `map` is reported as informational because `map` still allocates a new array.
- Constant folding is limited to literal-only expressions; variables and project-specific constants are not evaluated.
- Suggestions that lack a provably safe source transformation remain review-only.

## Verification

Feature-level fixtures are linked from `FEATURE-VERIFICATION.json`. Runtime verification for this step remains pending until the complete cross-platform CI, coverage, dependency audit, and VSIX packaging workflow passes on the final commit.
