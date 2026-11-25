# Step 7 — Security & Risk Detection

## Scope

Step 7 strengthens static security analysis while keeping Cleanser read-only by default. Findings are heuristic indicators for human review, not proof of exploitability or a substitute for a dedicated SAST, dependency audit, or penetration test.

## Regular-expression denial-of-service heuristic

The analyzer reports `regex-dos-risk` for regular-expression literals containing a repeated group with an inner quantifier or a repeated group with alternatives. These structures can trigger catastrophic or excessive backtracking on adversarial input.

The heuristic intentionally targets a narrow syntax pattern. It can miss risky expressions and can flag patterns that are safe under a particular input bound or engine. It does not rewrite regular expressions.

## DOM HTML insertion sinks

The existing `xss-risk` rule also reports non-literal values passed to `insertAdjacentHTML`, `document.write`, and `document.writeln`. Literal HTML strings are excluded from these call-based checks.

This is a sink-oriented heuristic, not taint analysis: it does not trace whether a value originates from an attacker or has been safely sanitized. Review each finding in its application context.

## Existing security checks retained

The analyzer continues to cover credential-like literals, PEM private-key blocks, suspicious URL schemes and embedded credentials, remote cleartext HTTP, dynamic code execution, shell invocation, weak hashes, insecure randomness, dynamic SQL, HTML injection sinks, path traversal indicators, unsafe deserialization, and permissive file modes.

Credential values are not included in finding messages.

## Safety and limitations

- Analysis does not execute project code or send source to a remote service.
- Findings are diagnostics only; no security quick fixes are applied.
- Pattern-based checks are conservative and incomplete. They do not perform full interprocedural taint analysis, framework-aware sink modeling, dependency CVE matching, or runtime exploitability assessment.
- A clean report is not a security guarantee.

## Verification

Regression coverage checks nested quantifiers and repeated alternatives, while ensuring simple and bounded expressions are not reported. CI evidence is recorded only after the full workflow completes.
