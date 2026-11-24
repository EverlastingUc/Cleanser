const SEVERITIES = new Set(["error", "warning", "info"]);
const RULE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const PLUGIN_NAME = /^[a-z][a-z0-9-]*$/;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function defineRule({
  id,
  description,
  severity = "warning",
  check,
} = {}) {
  if (typeof id !== "string" || !RULE_ID.test(id)) {
    throw new Error(
      "Custom rule IDs must use lowercase letters, digits, and hyphens.",
    );
  }
  if (typeof description !== "string" || description.trim() === "") {
    throw new Error(`Custom rule "${id}" needs a description.`);
  }
  if (!SEVERITIES.has(severity)) {
    throw new Error(`Custom rule "${id}" has an unsupported severity.`);
  }
  if (typeof check !== "function") {
    throw new Error(`Custom rule "${id}" needs a check function.`);
  }
  return Object.freeze({
    id,
    description: description.trim(),
    severity,
    check,
  });
}

export function definePlugin({ name, rules, dependencies = [] } = {}) {
  if (typeof name !== "string" || !PLUGIN_NAME.test(name)) {
    throw new Error(
      "Plugin names must use lowercase letters, digits, and hyphens.",
    );
  }
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new Error(`Plugin "${name}" must define at least one rule.`);
  }
  if (
    !Array.isArray(dependencies) ||
    dependencies.some(
      (dependency) =>
        typeof dependency !== "string" || !PACKAGE_NAME.test(dependency),
    ) ||
    new Set(dependencies).size !== dependencies.length
  ) {
    throw new Error(
      `Plugin "${name}" dependencies must be unique npm package names.`,
    );
  }
  const ruleIds = new Set();
  const validatedRules = rules.map((rule) => {
    const validated = defineRule(rule);
    if (ruleIds.has(validated.id)) {
      throw new Error(`Plugin "${name}" repeats rule "${validated.id}".`);
    }
    ruleIds.add(validated.id);
    return validated;
  });
  return Object.freeze({
    name,
    dependencies: Object.freeze([...dependencies]),
    rules: Object.freeze(validatedRules),
  });
}

export function getMissingPluginDependencies(plugin, packageJson) {
  if (
    !plugin ||
    typeof plugin.name !== "string" ||
    !Array.isArray(plugin.dependencies)
  ) {
    throw new TypeError(
      "A Cleanser plugin created by definePlugin is required.",
    );
  }
  if (
    !packageJson ||
    typeof packageJson !== "object" ||
    Array.isArray(packageJson)
  ) {
    throw new TypeError("A project package.json object is required.");
  }
  const declared = new Set();
  for (const section of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    const values = packageJson[section];
    if (values === undefined) continue;
    if (!values || typeof values !== "object" || Array.isArray(values)) {
      throw new TypeError(`package.json ${section} must be an object.`);
    }
    for (const name of Object.keys(values)) declared.add(name);
  }
  return plugin.dependencies.filter((dependency) => !declared.has(dependency));
}

export function runPlugin(plugin, { source, filePath } = {}) {
  if (
    !plugin ||
    typeof plugin.name !== "string" ||
    !Array.isArray(plugin.rules)
  ) {
    throw new TypeError(
      "A Cleanser plugin created by definePlugin is required.",
    );
  }
  if (typeof source !== "string") {
    throw new TypeError("Custom rule source must be a string.");
  }
  if (typeof filePath !== "string" || filePath.length === 0) {
    throw new TypeError("A project-relative file path is required.");
  }

  const findings = [];
  for (const rule of plugin.rules) {
    const ruleId = `custom/${plugin.name}/${rule.id}`;
    let candidates;
    try {
      candidates = rule.check(source, Object.freeze({ filePath }));
    } catch (error) {
      throw new Error(`Custom rule ${ruleId} failed: ${error.message}`, {
        cause: error,
      });
    }
    if (!Array.isArray(candidates)) {
      throw new Error(
        `Custom rule ${ruleId} must return an array of findings.`,
      );
    }
    for (const candidate of candidates) {
      const start = candidate?.start ?? 0;
      const end = candidate?.end ?? start;
      if (
        typeof candidate?.message !== "string" ||
        candidate.message.trim() === "" ||
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        end < start ||
        end > source.length
      ) {
        throw new Error(`Custom rule ${ruleId} returned an invalid finding.`);
      }
      const location = source.slice(0, start).split(/\r\n|\r|\n/u);
      findings.push({
        filePath,
        ruleId,
        severity: rule.severity,
        message: candidate.message.trim(),
        start,
        end,
        line: location.length,
        column: location.at(-1).length + 1,
      });
    }
  }
  findings.sort(
    (left, right) =>
      left.start - right.start ||
      compareText(left.ruleId, right.ruleId) ||
      compareText(left.message, right.message),
  );
  return findings;
}
