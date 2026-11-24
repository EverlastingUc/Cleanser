import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { listRules } from "./analyzer.js";
import { loadEditorConfigs } from "./editorconfig.js";

export const CONFIG_FILE = ".cleanser.clns";
export const CONFIG_JSON_FILE = ".cleanser.json";
export const CONFIG_VERSION = 1;

function deepFreeze(value) {
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === "object" && !Object.isFrozen(nested)) {
      deepFreeze(nested);
    }
  }
  return Object.freeze(value);
}

export const DEFAULT_CONFIG = deepFreeze({
  version: CONFIG_VERSION,
  enabled: true,
  mode: "safe",
  trigger: "manual",
  files: {
    include: [
      "**/*.js",
      "**/*.jsx",
      "**/*.ts",
      "**/*.tsx",
      "**/*.mjs",
      "**/*.cjs",
      "**/*.mts",
      "**/*.cts",
      "**/*.html",
      "**/*.css",
      "**/*.scss",
      "**/*.json",
      "**/*.jsonc",
      "**/*.yaml",
      "**/*.yml",
      "**/*.md",
      "**/*.vue",
      "**/*.toml",
      "**/*.xml",
      "**/*.svg",
      "**/*.sql",
      "**/*.svelte",
      "**/*.astro",
      "**/*.sh",
      "**/*.bash",
      "**/*.zsh",
      "**/*.ksh",
      "**/*.bats",
      "**/*.ps1",
      "**/*.psm1",
      "**/*.psd1",
      "**/*.java",
      "**/*.php",
    ],
    exclude: [
      "node_modules/**",
      "dist/**",
      "build/**",
      "coverage/**",
      ".git/**",
      ".cleanser-backups/**",
    ],
  },
  analysis: {
    preset: "recommended",
    rules: {},
  },
  formatting: {
    indentation: 2,
    normalize_line_endings: "preserve",
    quote_style: "double",
    semicolons: "always",
  },
  preservation: {
    variable_names: "preserve",
    function_names: "preserve",
    class_names: "preserve",
    parameter_names: "preserve",
    property_names: "preserve",
    comments: "preserve",
    strings: "preserve",
    program_logic: "preserve",
    public_api: "preserve",
  },
  cleanup: {
    remove_unused_variables: false,
    remove_unused_imports: false,
    remove_dead_code: false,
    remove_duplicate_code: false,
    simplify_expressions: false,
    reorder_imports: false,
  },
  safety: {
    preview_before_destructive_changes: true,
    create_backup: true,
    require_clean_working_tree: false,
    skip_on_syntax_error: true,
    prevent_save_loops: true,
    never_overwrite_on_error: true,
    protected_paths: [],
    maximum_changed_files: null,
    maximum_change_bytes: null,
  },
  overrides: [],
});

const KEYS = {
  root: [
    "version",
    "enabled",
    "mode",
    "trigger",
    "files",
    "analysis",
    "formatting",
    "preservation",
    "cleanup",
    "safety",
    "extends",
    "overrides",
  ],
  files: ["include", "exclude"],
  analysis: ["preset", "rules"],
  formatting: [
    "indentation",
    "normalize_line_endings",
    "quote_style",
    "semicolons",
  ],
  preservation: Object.keys(DEFAULT_CONFIG.preservation),
  cleanup: Object.keys(DEFAULT_CONFIG.cleanup),
  safety: Object.keys(DEFAULT_CONFIG.safety),
};

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`"${label}" must be a configuration object.`);
  }
}

function rejectUnknownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new Error(
        `Unknown option "${label}.${key}". Check the spelling or Cleanser config version.`,
      );
    }
  }
}

function mergeSection(defaults, supplied) {
  const merged = { ...defaults, ...supplied };
  for (const [key, value] of Object.entries(merged)) {
    if (Array.isArray(value)) merged[key] = [...value];
  }
  return merged;
}

function validateConfig(config) {
  if (config.version !== CONFIG_VERSION) {
    throw new Error(
      `Unsupported config version "${config.version}". ` +
        `This Cleanser release supports version ${CONFIG_VERSION}.`,
    );
  }
  if (typeof config.enabled !== "boolean") {
    throw new Error('"cleanser.enabled" must be true or false.');
  }
  if (!["recommended", "strict", "security"].includes(config.analysis.preset)) {
    throw new Error(
      '"cleanser.analysis.preset" must be "recommended", "strict", or "security".',
    );
  }
  if (!["safe"].includes(config.mode)) {
    throw new Error('Only "safe" mode is supported in this version.');
  }
  if (!["manual", "onSave"].includes(config.trigger)) {
    throw new Error('"cleanser.trigger" must be "manual" or "onSave".');
  }

  for (const key of ["include", "exclude"]) {
    const patterns = config.files[key];
    if (
      !Array.isArray(patterns) ||
      patterns.some((item) => typeof item !== "string" || item.trim() === "")
    ) {
      throw new Error(
        `"cleanser.files.${key}" must be a list of non-empty glob patterns.`,
      );
    }
    if (
      patterns.some(
        (item) => path.isAbsolute(item) || item.split(/[\\/]/).includes(".."),
      )
    ) {
      throw new Error(
        `"cleanser.files.${key}" patterns must stay inside the project directory.`,
      );
    }
  }
  if (config.files.include.length === 0) {
    throw new Error(
      '"cleanser.files.include" must contain at least one pattern.',
    );
  }

  const formatting = config.formatting;
  if (
    !Number.isInteger(formatting.indentation) ||
    formatting.indentation < 1 ||
    formatting.indentation > 8
  ) {
    throw new Error(
      '"cleanser.formatting.indentation" must be a whole number from 1 to 8.',
    );
  }
  if (!["single", "double"].includes(formatting.quote_style)) {
    throw new Error(
      '"cleanser.formatting.quote_style" must be "single" or "double".',
    );
  }
  if (!["always", "never"].includes(formatting.semicolons)) {
    throw new Error(
      '"cleanser.formatting.semicolons" must be "always" or "never".',
    );
  }
  if (
    !["preserve", "lf", "crlf", "cr"].includes(
      formatting.normalize_line_endings,
    )
  ) {
    throw new Error(
      '"cleanser.formatting.normalize_line_endings" must be "preserve", "lf", "crlf", or "cr".',
    );
  }

  for (const [key, value] of Object.entries(config.preservation)) {
    if (value !== "preserve") {
      throw new Error(
        `"cleanser.preservation.${key}" is locked to "preserve" in safe mode.`,
      );
    }
  }
  const ruleIds = new Set(listRules().map((rule) => rule.id));
  for (const [ruleId, severity] of Object.entries(config.analysis.rules)) {
    if (!ruleIds.has(ruleId)) {
      throw new Error(`Unknown analysis rule "${ruleId}".`);
    }
    if (!["off", "info", "warning", "error"].includes(severity)) {
      throw new Error(
        `"cleanser.analysis.rules.${ruleId}" must be off, info, warning, or error.`,
      );
    }
  }
  if (!Array.isArray(config.overrides)) {
    throw new Error('"cleanser.overrides" must be a list of file overrides.');
  }
  for (const [index, override] of config.overrides.entries()) {
    const label = `cleanser.overrides[${index}]`;
    assertObject(override, label);
    rejectUnknownKeys(override, ["files", "formatting", "rules"], label);
    if (
      !Array.isArray(override.files) ||
      override.files.length === 0 ||
      override.files.some(
        (pattern) =>
          typeof pattern !== "string" ||
          pattern.trim() === "" ||
          path.isAbsolute(pattern) ||
          pattern.split(/[\\/]/).includes(".."),
      )
    ) {
      throw new Error(
        `"${label}.files" must contain relative glob patterns that stay inside the project.`,
      );
    }
    if (override.formatting !== undefined) {
      assertObject(override.formatting, `${label}.formatting`);
      rejectUnknownKeys(
        override.formatting,
        KEYS.formatting,
        `${label}.formatting`,
      );
      const formatting = {
        ...DEFAULT_CONFIG.formatting,
        ...override.formatting,
      };
      if (
        !Number.isInteger(formatting.indentation) ||
        formatting.indentation < 1 ||
        formatting.indentation > 8 ||
        !["single", "double"].includes(formatting.quote_style) ||
        !["always", "never"].includes(formatting.semicolons) ||
        !["preserve", "lf", "crlf", "cr"].includes(
          formatting.normalize_line_endings,
        )
      ) {
        throw new Error(`"${label}.formatting" contains an invalid value.`);
      }
    }
    if (override.rules !== undefined) {
      assertObject(override.rules, `${label}.rules`);
      for (const [ruleId, severity] of Object.entries(override.rules)) {
        if (!ruleIds.has(ruleId)) {
          throw new Error(`Unknown analysis rule "${ruleId}" in ${label}.`);
        }
        if (!["off", "info", "warning", "error"].includes(severity)) {
          throw new Error(
            `"${label}.rules.${ruleId}" must be off, info, warning, or error.`,
          );
        }
      }
    }
  }
  for (const [key, value] of Object.entries(config.cleanup)) {
    if (value !== false) {
      throw new Error(
        `"cleanser.cleanup.${key}" is not available in this version; keep it false.`,
      );
    }
  }
  for (const key of [
    "create_backup",
    "require_clean_working_tree",
    "skip_on_syntax_error",
  ]) {
    if (typeof config.safety[key] !== "boolean") {
      throw new Error(`"cleanser.safety.${key}" must be true or false.`);
    }
  }
  if (
    !Array.isArray(config.safety.protected_paths) ||
    config.safety.protected_paths.some(
      (pattern) =>
        typeof pattern !== "string" ||
        pattern.trim() === "" ||
        path.isAbsolute(pattern) ||
        pattern.split(/[\\/]/).includes(".."),
    )
  ) {
    throw new Error(
      '"cleanser.safety.protected_paths" must contain relative glob patterns that stay inside the project.',
    );
  }
  for (const key of ["maximum_changed_files", "maximum_change_bytes"]) {
    const value = config.safety[key];
    if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error(
        `"cleanser.safety.${key}" must be a non-negative safe integer or null.`,
      );
    }
  }
  for (const key of [
    "preview_before_destructive_changes",
    "prevent_save_loops",
    "never_overwrite_on_error",
  ]) {
    if (config.safety[key] !== true) {
      throw new Error(
        `"cleanser.safety.${key}" is a mandatory safety guarantee and must remain true.`,
      );
    }
  }
}

function presetRules(preset) {
  const rules = {};
  const registry = listRules();
  if (preset === "strict") {
    for (const rule of registry) {
      if (rule.severity === "info") rules[rule.id] = "warning";
    }
  } else if (preset === "security") {
    for (const rule of registry) rules[rule.id] = "off";
    for (const rule of registry) {
      if (
        rule.id === "syntax-error" ||
        rule.id === "broken-import" ||
        rule.id === "circular-dependency" ||
        /^(?:hardcoded-|private-key|suspicious-url|unsafe-|dangerous-shell|insecure-|weak-crypto|sql-injection|xss-|path-traversal)/.test(
          rule.id,
        )
      ) {
        delete rules[rule.id];
      }
    }
  }
  return rules;
}

function parseConfigDocument(source, fileName) {
  try {
    if (fileName.toLowerCase().endsWith(".json")) JSON.parse(source);
    const parsed = YAML.parse(source, { prettyErrors: true, uniqueKeys: true });
    assertObject(parsed, fileName);
    rejectUnknownKeys(parsed, ["cleanser"], fileName);
    assertObject(parsed.cleanser, `${fileName}.cleanser`);
    return parsed.cleanser;
  } catch (error) {
    const formatName = fileName.toLowerCase().endsWith(".json")
      ? "JSON"
      : "YAML";
    throw new Error(`Invalid ${formatName} in ${fileName}: ${error.message}`, {
      cause: error,
    });
  }
}

function mergeConfigLayers(parent, child) {
  const merged = { ...parent, ...child };
  for (const section of [
    "files",
    "analysis",
    "formatting",
    "preservation",
    "cleanup",
    "safety",
  ]) {
    if (parent[section] || child[section]) {
      merged[section] = { ...parent[section], ...child[section] };
    }
  }
  merged.analysis = {
    ...parent.analysis,
    ...child.analysis,
    rules: { ...parent.analysis?.rules, ...child.analysis?.rules },
  };
  merged.overrides = [...(parent.overrides ?? []), ...(child.overrides ?? [])];
  delete merged.extends;
  return merged;
}

async function readConfigLayer(configPath, projectRoot, ancestry = []) {
  const absolutePath = path.resolve(configPath);
  const relative = path.relative(projectRoot, absolutePath);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Config inheritance must stay inside the project root.");
  }
  const cycleKey =
    process.platform === "win32" ? absolutePath.toLowerCase() : absolutePath;
  if (ancestry.includes(cycleKey)) {
    throw new Error(
      `Config inheritance cycle detected: ${[...ancestry, cycleKey].map((item) => path.relative(projectRoot, item)).join(" -> ")}.`,
    );
  }
  if (ancestry.length >= 16) {
    throw new Error(
      "Config inheritance exceeds the maximum depth of 16 files.",
    );
  }

  const segments = relative.split(path.sep).filter(Boolean);
  let current = projectRoot;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    let stats;
    try {
      stats = await fs.lstat(current);
    } catch (error) {
      throw new Error(
        `Could not read inherited config "${path.relative(projectRoot, absolutePath)}": ${error.message}`,
        { cause: error },
      );
    }
    if (
      stats.isSymbolicLink() ||
      (index < segments.length - 1 && !stats.isDirectory()) ||
      (index === segments.length - 1 && !stats.isFile())
    ) {
      throw new Error(
        `Inherited config "${path.relative(projectRoot, absolutePath)}" must use regular files and directories without symlinks.`,
      );
    }
  }

  let source;
  try {
    source = await fs.readFile(absolutePath, "utf8");
  } catch (error) {
    throw new Error(
      `Could not read inherited config "${path.relative(projectRoot, absolutePath)}": ${error.message}`,
      { cause: error },
    );
  }
  const configFile = path.basename(absolutePath);
  const supplied = parseConfigDocument(source, configFile);
  if (supplied.version !== undefined && supplied.version !== CONFIG_VERSION) {
    throw new Error(
      `Unsupported config version "${supplied.version}" in ${configFile}. This Cleanser release supports version ${CONFIG_VERSION}.`,
    );
  }
  rejectUnknownKeys(supplied, KEYS.root, "cleanser");
  for (const section of [
    "files",
    "analysis",
    "formatting",
    "preservation",
    "cleanup",
    "safety",
  ]) {
    if (supplied[section] !== undefined) {
      assertObject(supplied[section], `cleanser.${section}`);
      rejectUnknownKeys(
        supplied[section],
        KEYS[section],
        `cleanser.${section}`,
      );
    }
  }
  if (supplied.analysis?.rules !== undefined) {
    assertObject(supplied.analysis.rules, "cleanser.analysis.rules");
  }

  if (supplied.extends === undefined) return { ...supplied };
  if (
    typeof supplied.extends !== "string" ||
    supplied.extends.trim() === "" ||
    path.isAbsolute(supplied.extends) ||
    supplied.extends.split(/[\\/]/).includes("..")
  ) {
    throw new Error(
      '"cleanser.extends" must be a relative config path that stays inside the project root.',
    );
  }
  const parentPath = path.resolve(path.dirname(absolutePath), supplied.extends);
  const parent = await readConfigLayer(parentPath, projectRoot, [
    ...ancestry,
    cycleKey,
  ]);
  return mergeConfigLayers(parent, supplied);
}

async function resolveConfigFile(cwd) {
  const root = path.resolve(cwd);
  const existing = [];
  for (const fileName of [CONFIG_FILE, CONFIG_JSON_FILE]) {
    try {
      const stats = await fs.lstat(path.join(root, fileName));
      if (stats.isSymbolicLink() || !stats.isFile()) {
        throw new Error(`${fileName} must be a regular project file.`);
      }
      existing.push(fileName);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
  }

  if (existing.length > 1) {
    throw new Error(
      `Found both ${CONFIG_FILE} and ${CONFIG_JSON_FILE}; keep only one Cleanser config file.`,
    );
  }
  if (existing.length === 0) {
    throw new Error(
      `Missing ${CONFIG_FILE} or ${CONFIG_JSON_FILE}. Run "cleanser init" first.`,
    );
  }
  return existing[0];
}

export async function getConfigFile(cwd = process.cwd()) {
  return resolveConfigFile(cwd);
}

export async function loadConfig(cwd = process.cwd()) {
  const absoluteRoot = path.resolve(cwd);
  const configFile = await resolveConfigFile(absoluteRoot);
  const supplied = await readConfigLayer(
    path.join(absoluteRoot, configFile),
    absoluteRoot,
  );
  const { extends: _extends, ...resolved } = supplied;

  const config = {
    ...DEFAULT_CONFIG,
    ...resolved,
    files: mergeSection(DEFAULT_CONFIG.files, resolved.files ?? {}),
    analysis: {
      ...DEFAULT_CONFIG.analysis,
      ...resolved.analysis,
      rules: {
        ...presetRules(
          resolved.analysis?.preset ?? DEFAULT_CONFIG.analysis.preset,
        ),
        ...DEFAULT_CONFIG.analysis.rules,
        ...(resolved.analysis?.rules ?? {}),
      },
    },
    formatting: mergeSection(
      DEFAULT_CONFIG.formatting,
      resolved.formatting ?? {},
    ),
    preservation: mergeSection(
      DEFAULT_CONFIG.preservation,
      resolved.preservation ?? {},
    ),
    cleanup: mergeSection(DEFAULT_CONFIG.cleanup, resolved.cleanup ?? {}),
    safety: mergeSection(DEFAULT_CONFIG.safety, resolved.safety ?? {}),
  };

  validateConfig(config);
  if (!config.enabled) {
    throw new Error(
      `Cleanser is disabled in ${configFile}. Set "cleanser.enabled: true" to enable it.`,
    );
  }

  Object.defineProperties(config, {
    _root: { value: absoluteRoot },
    _editorConfigs: { value: await loadEditorConfigs(absoluteRoot) },
  });

  return config;
}
