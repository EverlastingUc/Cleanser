/** Severity assigned to findings returned by a custom rule. */
export type RuleSeverity = "error" | "warning" | "info";

/** A rule finding before Cleanser attaches its file and location details. */
export interface CustomFindingInput {
  /** Short explanation shown to the user. */
  message: string;
  /** Zero-based start offset in the source string. Defaults to the start of the file. */
  start?: number;
  /** Zero-based exclusive end offset in the source string. Defaults to `start`. */
  end?: number;
}

/** Read-only project information passed to a custom rule. */
export interface RuleContext {
  /** Project-relative path of the analyzed file, using forward slashes. */
  readonly filePath: string;
}

/** Input definition for one deterministic, read-only source rule. */
export interface CustomRuleDefinition {
  /** Stable lowercase rule identifier using letters, digits, and hyphens. */
  id: string;
  /** Human-readable explanation of what the rule checks. */
  description: string;
  /** Finding severity. Defaults to `warning`. */
  severity?: RuleSeverity;
  /** Inspect source text and return findings without modifying it. */
  check(source: string, context: RuleContext): readonly CustomFindingInput[];
}

/** Validated immutable form of a custom rule definition. */
export interface CustomRule extends Required<CustomRuleDefinition> {}

/** Input definition for a named collection of custom rules. */
export interface CustomPluginDefinition {
  /** Stable lowercase plugin identifier. */
  name: string;
  /** npm packages required by this plugin; Cleanser never installs them. */
  dependencies?: readonly string[];
  /** One or more rules exported by this plugin. */
  rules: readonly CustomRuleDefinition[];
}

/** Validated immutable form of a custom plugin definition. */
export interface CustomPlugin {
  readonly name: string;
  readonly dependencies: readonly string[];
  readonly rules: readonly CustomRule[];
}

/** A validated finding with a project-relative location. */
export interface CustomFinding {
  readonly filePath: string;
  readonly ruleId: string;
  readonly severity: RuleSeverity;
  readonly message: string;
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly column: number;
}

/** Validate and freeze a custom rule definition. */
export function defineRule(rule: CustomRuleDefinition): CustomRule;
/** Validate and freeze a named collection of unique custom rules. */
export function definePlugin(plugin: CustomPluginDefinition): CustomPlugin;
/** Return dependencies missing from all dependency sections of a package manifest. */
export function getMissingPluginDependencies(
  plugin: CustomPlugin,
  packageJson: Record<string, unknown>,
): string[];
/** Run a plugin against source text and return deterministic read-only findings. */
export function runPlugin(
  plugin: CustomPlugin,
  input: { source: string; filePath: string },
): CustomFinding[];
