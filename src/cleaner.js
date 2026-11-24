import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import prettier from "prettier";
import { resolveEditorConfigs } from "./editorconfig.js";
import { classifyChange, classifyConfidence } from "./risk.js";
import { assertCleanWorkingTree } from "./git-tools.js";
import { readCachedText } from "./file-cache.js";

let typescriptPromise;

function loadTypeScript() {
  typescriptPromise ??= import("typescript").then(
    (module) => module.default ?? module,
  );
  return typescriptPromise;
}

function loadDefaultPlugin(importer) {
  return async () => {
    const module = await importer();
    return module.default ?? module;
  };
}

const SUPPORTED_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".html",
  ".css",
  ".scss",
  ".json",
  ".jsonc",
  ".yaml",
  ".yml",
  ".md",
  ".vue",
  ".toml",
  ".xml",
  ".svg",
  ".sql",
  ".svelte",
  ".astro",
  ".sh",
  ".bash",
  ".zsh",
  ".ksh",
  ".bats",
  ".ps1",
  ".psm1",
  ".psd1",
  ".java",
  ".php",
]);
const PLUGIN_PARSERS = new Map([
  [
    ".toml",
    {
      loadPlugin: loadDefaultPlugin(() => import("prettier-plugin-toml")),
      parser: "toml",
    },
  ],
  [
    ".xml",
    {
      loadPlugin: loadDefaultPlugin(() => import("@prettier/plugin-xml")),
      parser: "xml",
    },
  ],
  [
    ".svg",
    {
      loadPlugin: loadDefaultPlugin(() => import("@prettier/plugin-xml")),
      parser: "xml",
    },
  ],
  [
    ".sql",
    {
      loadPlugin: loadDefaultPlugin(() => import("prettier-plugin-sql")),
      parser: "sql",
    },
  ],
  [
    ".svelte",
    {
      loadPlugin: loadDefaultPlugin(() => import("prettier-plugin-svelte")),
      parser: "svelte",
    },
  ],
  [
    ".astro",
    { loadPlugin: () => import("prettier-plugin-astro"), parser: "astro" },
  ],
  [".sh", { loadPlugin: () => import("prettier-plugin-sh"), parser: "sh" }],
  [".bash", { loadPlugin: () => import("prettier-plugin-sh"), parser: "sh" }],
  [".zsh", { loadPlugin: () => import("prettier-plugin-sh"), parser: "sh" }],
  [".ksh", { loadPlugin: () => import("prettier-plugin-sh"), parser: "sh" }],
  [".bats", { loadPlugin: () => import("prettier-plugin-sh"), parser: "sh" }],
  [
    ".ps1",
    {
      loadPlugin: loadDefaultPlugin(() => import("prettier-plugin-powershell")),
      parser: "powershell",
    },
  ],
  [
    ".psm1",
    {
      loadPlugin: loadDefaultPlugin(() => import("prettier-plugin-powershell")),
      parser: "powershell",
    },
  ],
  [
    ".psd1",
    {
      loadPlugin: loadDefaultPlugin(() => import("prettier-plugin-powershell")),
      parser: "powershell",
    },
  ],
  [
    ".java",
    {
      loadPlugin: loadDefaultPlugin(() => import("prettier-plugin-java")),
      parser: "java",
    },
  ],
  [".php", { loadPlugin: () => import("@prettier/plugin-php"), parser: "php" }],
]);
const AST_FORMATTING_METADATA = new Set([
  "loc",
  "location",
  "line",
  "column",
  "startLine",
  "endLine",
  "startColumn",
  "endColumn",
  "start",
  "end",
  "pos",
  "range",
  "Pos",
  "End",
  "position",
  "tokens",
  "parent",
  "extra",
  "raw",
  "rawText",
  "rawValue",
  "original",
]);

function normalizeAst(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeAst).filter((nested) => nested !== undefined);
  }
  if (!value || typeof value !== "object") return value;
  if (value.type === "BlankLine") return undefined;

  const normalized = {};
  for (const [key, nested] of Object.entries(value)) {
    if (!AST_FORMATTING_METADATA.has(key) && !key.startsWith("__")) {
      normalized[key] = normalizeAst(nested);
    }
  }
  return normalized;
}

function normalizeJavaAst(value) {
  if (Array.isArray(value)) return value.map(normalizeJavaAst);
  if (!value || typeof value !== "object") return value;

  const normalized = {};
  for (const [key, nested] of Object.entries(value)) {
    if (
      AST_FORMATTING_METADATA.has(key) ||
      (key === "value" &&
        Array.isArray(value.children) &&
        value.children.length > 0)
    ) {
      continue;
    }
    normalized[key] = normalizeJavaAst(nested);
  }
  return normalized;
}

function findAstDifference(before, after, location = "ast") {
  if (Object.is(before, after)) return null;

  if (Array.isArray(before) && Array.isArray(after)) {
    if (before.length !== after.length) {
      return `${location} length changed from ${before.length} to ${after.length}`;
    }
    for (let index = 0; index < before.length; index++) {
      const difference = findAstDifference(
        before[index],
        after[index],
        `${location}[${index}]`,
      );
      if (difference) return difference;
    }
    return null;
  }

  if (
    before &&
    after &&
    typeof before === "object" &&
    typeof after === "object"
  ) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of [...keys].sort(compareText)) {
      if (!(key in before)) return `${location}.${key} was added`;
      if (!(key in after)) return `${location}.${key} was removed`;
      const difference = findAstDifference(
        before[key],
        after[key],
        `${location}.${key}`,
      );
      if (difference) return difference;
    }
    return null;
  }

  return `${location} changed from ${String(before)} to ${String(after)}`;
}

function readSqlQuotedToken(source, start, quote, closingQuote = quote) {
  let index = start + quote.length;
  while (index < source.length) {
    if (source[index] === "\\" && index + 1 < source.length) {
      index += 2;
      continue;
    }
    if (source.startsWith(closingQuote, index)) {
      if (source.startsWith(closingQuote, index + closingQuote.length)) {
        index += closingQuote.length * 2;
        continue;
      }
      return index + closingQuote.length;
    }
    index++;
  }
  return source.length;
}

function tokenizeSql(source) {
  const tokens = [];
  let index = 0;

  while (index < source.length) {
    const character = source[index];
    if (/\s/u.test(character)) {
      index++;
      continue;
    }

    const start = index;
    if (source.startsWith("--", index)) {
      const newline = source.indexOf("\n", index + 2);
      index = newline === -1 ? source.length : newline;
      tokens.push(source.slice(start, index));
      continue;
    }
    if (source.startsWith("/*", index)) {
      index += 2;
      let depth = 1;
      while (index < source.length && depth > 0) {
        if (source.startsWith("/*", index)) {
          depth++;
          index += 2;
        } else if (source.startsWith("*/", index)) {
          depth--;
          index += 2;
        } else {
          index++;
        }
      }
      tokens.push(source.slice(start, index));
      continue;
    }

    const dollarQuote = source.slice(index).match(/^\$(?:[A-Za-z_][\w]*)?\$/u);
    if (dollarQuote) {
      const closing = source.indexOf(
        dollarQuote[0],
        index + dollarQuote[0].length,
      );
      index = closing === -1 ? source.length : closing + dollarQuote[0].length;
      tokens.push(source.slice(start, index));
      continue;
    }

    if (character === "'" || character === '"' || character === "`") {
      index = readSqlQuotedToken(source, index, character);
      tokens.push(source.slice(start, index));
      continue;
    }
    if (character === "[") {
      index = readSqlQuotedToken(source, index, "[", "]");
      tokens.push(source.slice(start, index));
      continue;
    }

    const numeric = source
      .slice(index)
      .match(/^(?:0[xX][\da-fA-F]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/u);
    if (numeric) {
      index += numeric[0].length;
      tokens.push(numeric[0]);
      continue;
    }

    const codePoint = String.fromCodePoint(source.codePointAt(index));
    if (/[\p{L}\p{N}_$#@]/u.test(codePoint)) {
      index += codePoint.length;
      while (index < source.length) {
        const next = String.fromCodePoint(source.codePointAt(index));
        if (!/[\p{L}\p{N}_$#@]/u.test(next)) break;
        index += next.length;
      }
      tokens.push(source.slice(start, index));
      continue;
    }

    if (/[!<>=~+*/%&|^:-]/u.test(character)) {
      index++;
      while (index < source.length && /[!<>=~+*/%&|^:-]/u.test(source[index])) {
        index++;
      }
      tokens.push(source.slice(start, index));
      continue;
    }

    index += codePoint.length;
    tokens.push(source.slice(start, index));
  }

  return tokens;
}

function findSqlTokenDifference(before, after) {
  const beforeTokens = tokenizeSql(before);
  const afterTokens = tokenizeSql(after);
  const count = Math.min(beforeTokens.length, afterTokens.length);
  for (let index = 0; index < count; index++) {
    if (beforeTokens[index] !== afterTokens[index]) {
      return `SQL token ${index + 1} changed from ${JSON.stringify(beforeTokens[index])} to ${JSON.stringify(afterTokens[index])}`;
    }
  }
  if (beforeTokens.length !== afterTokens.length) {
    return `SQL token count changed from ${beforeTokens.length} to ${afterTokens.length}`;
  }
  return null;
}

function normalizeSvelteAst(ast) {
  const blockRanges = [ast.instance, ast.module, ast.css].filter(
    (block) => Number.isInteger(block?.start) && Number.isInteger(block?.end),
  );
  const nodes = ast.fragment.nodes.filter((node) => {
    if (node.type !== "Text" || !/^\s+$/u.test(node.data)) return true;
    return !blockRanges.some(
      (block) => node.start === block.end || node.end === block.start,
    );
  });
  return normalizeAst({
    ...ast,
    fragment: { ...ast.fragment, nodes },
  });
}

async function readAstroCompressValue(source, filePath) {
  const ts = await loadTypeScript();
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const values = [];
  const visit = (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      ((ts.isIdentifier(node.name) && node.name.text === "compressHTML") ||
        (ts.isStringLiteral(node.name) && node.name.text === "compressHTML"))
    ) {
      const initializer = node.initializer;
      if (
        initializer.kind === ts.SyntaxKind.TrueKeyword ||
        (ts.isStringLiteral(initializer) && initializer.text === "jsx")
      ) {
        values.push(true);
      } else if (initializer.kind === ts.SyntaxKind.FalseKeyword) {
        values.push(false);
      } else {
        values.push(undefined);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (values.length === 0) return { found: false };
  if (values.some((value) => value !== values[0])) {
    return { found: true, value: undefined };
  }
  return { found: true, value: values[0] };
}

async function allowsAstroNewlineNormalization(filePath) {
  const configNames = [
    "astro.config.mjs",
    "astro.config.js",
    "astro.config.cjs",
    "astro.config.ts",
    "astro.config.mts",
    "astro.config.cts",
  ];
  let current = path.resolve(path.dirname(filePath));
  for (let depth = 0; depth < 16; depth++) {
    const configValues = [];
    for (const name of configNames) {
      const configPath = path.join(current, name);
      let source;
      try {
        source = await fs.readFile(configPath, "utf8");
      } catch (error) {
        if (error.code === "ENOENT") continue;
        return false;
      }
      configValues.push(await readAstroCompressValue(source, configPath));
    }
    const explicitValues = configValues.filter((result) => result.found);
    if (explicitValues.length > 0) {
      return explicitValues.every((result) => result.value === true);
    }

    let packageSource;
    try {
      packageSource = await fs.readFile(
        path.join(current, "package.json"),
        "utf8",
      );
    } catch (error) {
      if (error.code !== "ENOENT") return false;
    }
    if (packageSource !== undefined) {
      let manifest;
      try {
        manifest = JSON.parse(packageSource);
      } catch {
        return false;
      }
      const dependencies = {
        ...manifest.dependencies,
        ...manifest.devDependencies,
        ...manifest.peerDependencies,
      };
      if (dependencies.astro === undefined) return true;
      const version = String(dependencies.astro).match(/^(?:\^|~)?(\d+)\./u);
      return version ? Number(version[1]) >= 3 : false;
    }

    const parent = path.dirname(current);
    if (parent === current) return true;
    current = parent;
  }
  return false;
}

async function normalizeAstroNode(
  value,
  preformatted = false,
  normalizeNewlines = false,
) {
  if (Array.isArray(value)) {
    const normalized = await Promise.all(
      value.map((nested) =>
        normalizeAstroNode(nested, preformatted, normalizeNewlines),
      ),
    );
    return normalized.filter((nested) => nested !== undefined);
  }
  if (!value || typeof value !== "object") return value;

  if (
    value.type === "text" &&
    !preformatted &&
    normalizeNewlines &&
    typeof value.value === "string" &&
    /\s*\r?\n\s*/u.test(value.value) &&
    /^\s*$/u.test(value.value)
  ) {
    return undefined;
  }

  if (value.type === "frontmatter" && typeof value.value === "string") {
    const parsed = await prettier.__debug.parse(value.value, {
      parser: "typescript",
    });
    return { type: "frontmatter", program: normalizeAst(parsed.ast) };
  }

  const name =
    value.type === "element" && typeof value.name === "string"
      ? value.name.toLowerCase()
      : "";
  const preserveWhitespace =
    preformatted || ["pre", "script", "style", "textarea"].includes(name);
  const normalized = {};
  for (const [key, nested] of Object.entries(value)) {
    if (AST_FORMATTING_METADATA.has(key) || key.startsWith("__")) continue;
    normalized[key] = await normalizeAstroNode(
      nested,
      key === "children" ? preserveWhitespace : preformatted,
      normalizeNewlines,
    );
  }
  return normalized;
}

function assertConfig(config) {
  if (!config || typeof config !== "object") {
    throw new TypeError("A Cleanser configuration object is required.");
  }
  if (
    !config.files ||
    !Array.isArray(config.files.include) ||
    !Array.isArray(config.files.exclude)
  ) {
    throw new TypeError(
      'Cleanser config must define "files.include" and "files.exclude" arrays.',
    );
  }
  if (
    !config.formatting ||
    !Number.isInteger(config.formatting.indentation) ||
    config.formatting.indentation < 1 ||
    config.formatting.indentation > 8
  ) {
    throw new TypeError(
      '"formatting.indentation" must be a whole number from 1 to 8.',
    );
  }
  if (!["single", "double"].includes(config.formatting.quote_style)) {
    throw new TypeError(
      '"formatting.quote_style" must be "single" or "double".',
    );
  }
  if (!["always", "never"].includes(config.formatting.semicolons)) {
    throw new TypeError('"formatting.semicolons" must be "always" or "never".');
  }
  if (
    !["preserve", "lf", "crlf", "cr"].includes(
      config.formatting.normalize_line_endings,
    )
  ) {
    throw new TypeError(
      '"formatting.normalize_line_endings" must be preserve, lf, crlf, or cr.',
    );
  }
  if (
    !config.safety ||
    typeof config.safety.create_backup !== "boolean" ||
    typeof config.safety.skip_on_syntax_error !== "boolean"
  ) {
    throw new TypeError("Cleanser config must define boolean safety options.");
  }
  if (
    config.safety.protected_paths !== undefined &&
    (!Array.isArray(config.safety.protected_paths) ||
      config.safety.protected_paths.some(
        (pattern) =>
          typeof pattern !== "string" ||
          pattern.trim() === "" ||
          path.isAbsolute(pattern) ||
          pattern.split(/[\\/]/).includes(".."),
      ))
  ) {
    throw new TypeError('"safety.protected_paths" must be an array of globs.');
  }
  for (const pattern of [...config.files.include, ...config.files.exclude]) {
    if (typeof pattern !== "string" || pattern.length === 0) {
      throw new TypeError("Cleanser file patterns must be non-empty strings.");
    }
  }
}

function normalizeGlobPath(value) {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function matchesPattern(relativePath, pattern) {
  if (
    typeof relativePath !== "string" ||
    typeof pattern !== "string" ||
    pattern.length === 0
  ) {
    return false;
  }

  const value = normalizeGlobPath(relativePath);
  const normalizedPattern = normalizeGlobPath(pattern);
  let expression = "^";

  for (let index = 0; index < normalizedPattern.length; index++) {
    const character = normalizedPattern[index];
    const next = normalizedPattern[index + 1];

    if (character === "*" && next === "*") {
      if (normalizedPattern[index + 2] === "/") {
        expression += "(?:.*/)?";
        index += 2;
      } else {
        expression += ".*";
        index++;
      }
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }

  expression += "$";
  return new RegExp(expression).test(value);
}

export function resolveFileConfig(config, relativePath) {
  if (!config || typeof config !== "object") {
    throw new TypeError("A Cleanser configuration object is required.");
  }
  const normalizedPath = normalizeGlobPath(relativePath);
  const effective = {
    ...config,
    formatting: { ...config.formatting },
    analysis: {
      ...config.analysis,
      rules: { ...(config.analysis?.rules ?? {}) },
    },
  };
  const editorConfig = resolveEditorConfigs(
    config._editorConfigs,
    config._root ?? process.cwd(),
    normalizedPath,
  );
  Object.assign(effective.formatting, editorConfig.formatting);
  Object.defineProperty(effective, "_editorConfigOptions", {
    value: {
      insertFinalNewline: editorConfig.insertFinalNewline,
    },
  });
  for (const override of config.overrides ?? []) {
    if (
      !override.files.some((pattern) => matchesPattern(normalizedPath, pattern))
    ) {
      continue;
    }
    Object.assign(effective.formatting, override.formatting ?? {});
    Object.assign(effective.analysis.rules, override.rules ?? {});
  }
  return effective;
}

function isIncluded(relativePath, config) {
  const included = config.files.include.some((pattern) =>
    matchesPattern(relativePath, pattern),
  );
  const excluded = config.files.exclude.some((pattern) =>
    matchesPattern(relativePath, pattern),
  );
  return included && !excluded;
}

function isExcludedDirectory(relativePath, config) {
  const directory = normalizeGlobPath(relativePath).replace(/\/$/, "");
  const protectsPath = (pattern) =>
    matchesPattern(directory, pattern) ||
    matchesPattern(`${directory}/`, pattern) ||
    matchesPattern(`${directory}/__cleanser_probe__`, pattern);
  return (
    config.files.exclude.some(protectsPath) ||
    (config.safety?.protected_paths ?? []).some(protectsPath)
  );
}

export function isProtectedProjectPath(relativePath, config) {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    return false;
  }
  const normalized = normalizeGlobPath(relativePath).replace(/^\.\//, "");
  if (
    normalized.startsWith("/") ||
    /^[a-zA-Z]:\//.test(normalized) ||
    normalized.split("/").includes("..")
  ) {
    return true;
  }
  if (normalized === ".cleanser-snapshot.json") return true;
  return (
    normalized
      .split("/")
      .some((segment) =>
        ["node_modules", ".git", ".cleanser-backups"].includes(segment),
      ) ||
    (config?.safety?.protected_paths ?? []).some((pattern) =>
      matchesPattern(normalized, pattern),
    )
  );
}

export async function isSafeProjectFile(root, filePath) {
  const absoluteRoot = path.resolve(root);
  const absoluteFile = path.resolve(absoluteRoot, filePath);
  const relative = path.relative(absoluteRoot, absoluteFile);

  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return false;
  }

  const segments = relative.split(path.sep).filter(Boolean);
  if (segments.length === 0) return false;

  let current = absoluteRoot;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    let stats;
    try {
      stats = await fs.lstat(current);
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }

    if (stats.isSymbolicLink()) return false;
    if (index < segments.length - 1 && !stats.isDirectory()) return false;
    if (index === segments.length - 1 && !stats.isFile()) return false;
  }

  return true;
}

export function isIncludedPath(relativePath, config) {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    return false;
  }

  const normalized = normalizeGlobPath(relativePath);
  if (
    normalized.startsWith("/") ||
    /^[a-zA-Z]:\//.test(normalized) ||
    normalized.split("/").includes("..")
  ) {
    return false;
  }

  if (isProtectedProjectPath(normalized, config)) return false;

  if (!isIncluded(normalized, config)) return false;

  const segments = normalized.split("/");
  let directory = "";
  for (const segment of segments.slice(0, -1)) {
    directory = directory ? `${directory}/${segment}` : segment;
    if (isExcludedDirectory(directory, config)) return false;
  }
  return true;
}

export async function collectProjectFiles(root, config, { signal } = {}) {
  const found = [];
  const pending = [root];

  while (pending.length > 0) {
    if (signal?.aborted) throw new Error("Cleanser operation was cancelled.");
    const current = pending.pop();
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      throw new Error(
        `Could not read directory "${path.relative(root, current) || "."}": ${error.message}`,
      );
    }

    entries.sort((left, right) => compareText(right.name, left.name));
    for (const entry of entries) {
      if (signal?.aborted) {
        throw new Error("Cleanser operation was cancelled.");
      }
      if (
        entry.name === "node_modules" ||
        entry.name === ".git" ||
        entry.name === ".cleanser-backups"
      ) {
        continue;
      }

      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");

      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        if (!isExcludedDirectory(relative, config)) pending.push(absolute);
      } else if (
        entry.isFile() &&
        SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) &&
        isIncludedPath(relative, config)
      ) {
        found.push(absolute);
      }
    }
  }

  return found.sort(compareText);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function mapConcurrentOrdered(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= items.length) return;
        results[index] = await mapper(items[index], index);
      }
    }),
  );
  return results;
}

function selectChangedFiles(files, root, changedFiles) {
  if (changedFiles === undefined) return files;
  const changedPathSet = new Set(changedFiles.map(normalizeGlobPath));
  return files.filter((filePath) =>
    changedPathSet.has(path.relative(root, filePath).split(path.sep).join("/")),
  );
}

function splitSourceLines(source) {
  if (source.length === 0) return [];
  const lines = source.split(/\r\n|\r|\n/);
  if (/(?:\r\n|\r|\n)$/.test(source)) lines.pop();
  return lines;
}

export function createUnifiedDiff(filePath, before, after) {
  if (before === after) return "";
  const oldLines = splitSourceLines(before);
  const newLines = splitSourceLines(after);
  const width = newLines.length + 1;
  const cells = (oldLines.length + 1) * width;
  const operations = [];

  if (cells <= 1_000_000) {
    const lengths = new Uint32Array(cells);
    for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex--) {
      for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex--) {
        const index = oldIndex * width + newIndex;
        lengths[index] =
          oldLines[oldIndex] === newLines[newIndex]
            ? lengths[(oldIndex + 1) * width + newIndex + 1] + 1
            : Math.max(
                lengths[(oldIndex + 1) * width + newIndex],
                lengths[oldIndex * width + newIndex + 1],
              );
      }
    }

    let oldIndex = 0;
    let newIndex = 0;
    while (oldIndex < oldLines.length || newIndex < newLines.length) {
      if (
        oldIndex < oldLines.length &&
        newIndex < newLines.length &&
        oldLines[oldIndex] === newLines[newIndex]
      ) {
        operations.push(` ${oldLines[oldIndex++]}`);
        newIndex++;
      } else if (
        oldIndex < oldLines.length &&
        (newIndex >= newLines.length ||
          lengths[(oldIndex + 1) * width + newIndex] >=
            lengths[oldIndex * width + newIndex + 1])
      ) {
        operations.push(`-${oldLines[oldIndex++]}`);
      } else {
        operations.push(`+${newLines[newIndex++]}`);
      }
    }
  } else {
    operations.push(...oldLines.map((line) => `-${line}`));
    operations.push(...newLines.map((line) => `+${line}`));
  }

  const oldRange = oldLines.length === 0 ? "0,0" : `1,${oldLines.length}`;
  const newRange = newLines.length === 0 ? "0,0" : `1,${newLines.length}`;
  return [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -${oldRange} +${newRange} @@`,
    ...operations,
  ].join("\n");
}

export async function previewProject({
  root = process.cwd(),
  config,
  changedFiles,
} = {}) {
  assertConfig(config);
  if (
    changedFiles !== undefined &&
    (!Array.isArray(changedFiles) ||
      changedFiles.some(
        (filePath) => typeof filePath !== "string" || filePath.length === 0,
      ))
  ) {
    throw new TypeError(
      '"changedFiles" must be an array of project-relative paths.',
    );
  }
  const absoluteRoot = path.resolve(root);
  const candidates = selectChangedFiles(
    await collectProjectFiles(absoluteRoot, config),
    absoluteRoot,
    changedFiles,
  );
  const results = [];
  for (const filePath of candidates) {
    if (!(await isSafeProjectFile(absoluteRoot, filePath))) {
      results.push({
        filePath: path
          .relative(absoluteRoot, filePath)
          .split(path.sep)
          .join("/"),
        status: "skipped",
        reason: "File is no longer a regular file inside the project.",
      });
      continue;
    }
    const original = await readCachedText(filePath);
    const relativeFile = path
      .relative(absoluteRoot, filePath)
      .split(path.sep)
      .join("/");
    const fileConfig = resolveFileConfig(config, relativeFile);
    try {
      const formatted = await formatSource(original, filePath, fileConfig);
      const comparison =
        formatted === original
          ? { equivalent: true, difference: null, method: "unchanged" }
          : await compareAstEquivalence(
              original,
              formatted,
              filePath,
              fileConfig,
            );
      const risk = classifyChange({
        kind: "format",
        astEquivalent: comparison.equivalent,
      });
      results.push({
        filePath: path
          .relative(absoluteRoot, filePath)
          .split(path.sep)
          .join("/"),
        status:
          formatted === original
            ? "unchanged"
            : comparison.equivalent
              ? "changed"
              : "unsafe",
        astEquivalent: comparison.equivalent,
        verificationMethod: comparison.method,
        risk,
        confidence: classifyConfidence({
          astEquivalent: comparison.equivalent,
        }),
        ...(comparison.difference
          ? { verificationDifference: comparison.difference }
          : {}),
        diff: createUnifiedDiff(
          path.relative(absoluteRoot, filePath).split(path.sep).join("/"),
          original,
          formatted,
        ),
      });
    } catch (error) {
      if (!config.safety.skip_on_syntax_error) {
        throw new Error(
          `Could not preview ${path.relative(absoluteRoot, filePath)}: ${error.message}`,
          { cause: error },
        );
      }
      results.push({
        filePath: path
          .relative(absoluteRoot, filePath)
          .split(path.sep)
          .join("/"),
        status: "skipped",
        reason: error.message,
      });
    }
  }
  return results;
}

function detectLineEnding(source) {
  const counts = {
    crlf: (source.match(/\r\n/g) ?? []).length,
    lf: (source.match(/(?<!\r)\n/g) ?? []).length,
    cr: (source.match(/\r(?!\n)/g) ?? []).length,
  };
  const highest = Math.max(counts.crlf, counts.lf, counts.cr);
  if (highest === 0) return "lf";
  if (counts.crlf === highest) return "crlf";
  if (counts.lf === highest) return "lf";
  return "cr";
}

async function prettierOptions(config, filePath, source) {
  const formatting = config.formatting;
  const extension = path.extname(filePath).toLowerCase();
  const pluginParser = PLUGIN_PARSERS.get(extension);
  return {
    filepath: filePath,
    ...(pluginParser
      ? {
          parser: pluginParser.parser,
          plugins: [await pluginParser.loadPlugin()],
        }
      : {}),
    tabWidth: formatting.indentation,
    useTabs: formatting.use_tabs === true,
    printWidth: formatting.print_width,
    endOfLine:
      formatting.normalize_line_endings === "preserve"
        ? detectLineEnding(source)
        : formatting.normalize_line_endings,
    singleQuote: formatting.quote_style === "single",
    semi: formatting.semicolons === "always",
    trailingComma: "all",
    ...(pluginParser?.parser === "powershell"
      ? {
          powershellIndentStyle:
            formatting.use_tabs === true ? "tabs" : "spaces",
          powershellIndentSize: formatting.indentation,
          powershellKeywordCase: "preserve",
          powershellPreferSingleQuote: false,
          powershellRewriteAliases: false,
          powershellRewriteWriteHost: false,
          powershellSortHashtableKeys: false,
        }
      : {}),
  };
}

export async function formatSource(source, filePath, config, range) {
  if (typeof source !== "string")
    throw new TypeError("Source code must be a string.");
  if (typeof filePath !== "string" || filePath.length === 0) {
    throw new TypeError("A source file path is required.");
  }
  assertConfig(config);
  const extension = path.extname(filePath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    throw new Error(
      `Unsupported file type "${extension || "(no extension)"}". Supported: ${[...SUPPORTED_EXTENSIONS].join(", ")}.`,
    );
  }
  const options = await prettierOptions(config, filePath, source);
  if (range !== undefined) {
    if (
      !range ||
      !Number.isSafeInteger(range.start) ||
      !Number.isSafeInteger(range.end) ||
      range.start < 0 ||
      range.end < range.start ||
      range.end > source.length
    ) {
      throw new TypeError(
        "A valid source range is required for range formatting.",
      );
    }
    options.rangeStart = range.start;
    options.rangeEnd = range.end;
  }
  let formatted = await prettier.format(source, options);
  const editorConfig = config._editorConfigOptions;
  if (editorConfig?.insertFinalNewline === "false") {
    formatted = formatted.replace(/(?:\r\n|\r|\n)+$/, "");
  }
  return formatted;
}

export async function compareAstEquivalence(
  original,
  formatted,
  filePath,
  config,
) {
  if (typeof original !== "string" || typeof formatted !== "string") {
    throw new TypeError("AST verification inputs must be strings.");
  }
  if (typeof filePath !== "string" || filePath.length === 0) {
    throw new TypeError("A source file path is required for AST verification.");
  }
  assertConfig(config);

  if (path.extname(filePath).toLowerCase() === ".sql") {
    const tokenDifference = findSqlTokenDifference(original, formatted);
    if (tokenDifference) {
      return {
        equivalent: false,
        difference: tokenDifference,
        method: "sql-ast+token-stream",
      };
    }

    try {
      const sqlParserPackage = await import("node-sql-parser");
      const SqlParser = (sqlParserPackage.default ?? sqlParserPackage).Parser;
      const parser = new SqlParser();
      const parserOptions = { database: "MySQL" };
      const beforeAst = parser.astify(original, parserOptions);
      const afterAst = parser.astify(formatted, parserOptions);
      const difference = findAstDifference(
        normalizeAst(beforeAst),
        normalizeAst(afterAst),
      );
      return {
        equivalent: difference === null,
        difference,
        method: "sql-ast+token-stream",
      };
    } catch (error) {
      return {
        equivalent: false,
        difference: `SQL could not be verified with the bundled MySQL grammar: ${error.message}`,
        method: "sql-ast+token-stream",
      };
    }
  }

  if (path.extname(filePath).toLowerCase() === ".svelte") {
    const { parse: parseSvelte } = await import("svelte/compiler");
    const beforeAst = parseSvelte(original, { modern: true });
    const afterAst = parseSvelte(formatted, { modern: true });
    const difference = findAstDifference(
      normalizeSvelteAst(beforeAst),
      normalizeSvelteAst(afterAst),
    );
    return {
      equivalent: difference === null,
      difference,
      method: "svelte-compiler-ast",
    };
  }

  if (path.extname(filePath).toLowerCase() === ".astro") {
    const { parse: parseAstro } = await import("@astrojs/compiler");
    const [beforeResult, afterResult] = await Promise.all([
      parseAstro(original),
      parseAstro(formatted),
    ]);
    const normalizeNewlines = await allowsAstroNewlineNormalization(filePath);
    const difference = findAstDifference(
      await normalizeAstroNode(beforeResult.ast, false, normalizeNewlines),
      await normalizeAstroNode(afterResult.ast, false, normalizeNewlines),
    );
    return {
      equivalent: difference === null,
      difference,
      method: "astro-compiler-ast",
    };
  }

  if (path.extname(filePath).toLowerCase() === ".java") {
    const options = await prettierOptions(config, filePath, original);
    const [before, after] = await Promise.all([
      prettier.__debug.parse(original, { ...options }),
      prettier.__debug.parse(formatted, { ...options }),
    ]);
    if (!before?.ast || !after?.ast) {
      throw new Error("The Java parser did not return an AST.");
    }
    const difference = findAstDifference(
      normalizeJavaAst(before.ast),
      normalizeJavaAst(after.ast),
    );
    return {
      equivalent: difference === null,
      difference,
      method: "java-parser-ast",
    };
  }

  if (typeof prettier.__debug?.parse !== "function") {
    throw new Error("The configured formatter does not expose AST parsing.");
  }

  const options = await prettierOptions(config, filePath, original);
  const [before, after] = await Promise.all([
    prettier.__debug.parse(original, { ...options }),
    prettier.__debug.parse(formatted, { ...options }),
  ]);
  if (!before?.ast || !after?.ast) {
    throw new Error("The formatter parser did not return an AST.");
  }

  const difference = findAstDifference(
    normalizeAst(before.ast),
    normalizeAst(after.ast),
  );
  return {
    equivalent: difference === null,
    difference,
    method: "prettier-ast",
  };
}

export async function writeAtomically(filePath, content, mode) {
  const temporaryPath = `${filePath}.cleanser-tmp-${randomUUID()}`;
  const permissions = mode & 0o777;
  let temporaryFile;

  try {
    temporaryFile = await fs.open(temporaryPath, "wx", permissions);
    await temporaryFile.writeFile(content, "utf8");
    await temporaryFile.chmod(permissions);
    await temporaryFile.sync();
    await temporaryFile.close();
    temporaryFile = undefined;

    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    if (temporaryFile) await temporaryFile.close().catch(() => {});
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function createBackup(root, filePath, original) {
  const backupRoot = path.join(root, ".cleanser-backups");
  const relative = path.relative(root, filePath);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Backup path must stay inside the project directory.");
  }

  const backupPath = path.join(backupRoot, relative);
  const directory = path.dirname(backupPath);
  const directoryRelative = path.relative(root, directory);
  let current = root;

  for (const segment of directoryRelative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      await fs.mkdir(current);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }

    const stats = await fs.lstat(current);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(
        `Backup directory is not a safe directory: "${current}".`,
      );
    }
  }

  try {
    await fs.writeFile(backupPath, original, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = await fs.lstat(backupPath).catch(() => null);
    if (!existing?.isFile()) throw error;
  }
}

async function cleanProjectOperation({
  root = process.cwd(),
  config,
  write = true,
  changedFiles,
  limits,
  onProgress,
  approveChange,
  signal,
  allowDirty = false,
} = {}) {
  assertConfig(config);
  if (typeof write !== "boolean")
    throw new TypeError('"write" must be true or false.');
  if (typeof allowDirty !== "boolean") {
    throw new TypeError('"allowDirty" must be true or false.');
  }
  if (onProgress !== undefined && typeof onProgress !== "function") {
    throw new TypeError('"onProgress" must be a function when provided.');
  }
  if (approveChange !== undefined && typeof approveChange !== "function") {
    throw new TypeError('"approveChange" must be a function when provided.');
  }
  if (
    signal !== undefined &&
    (!signal ||
      typeof signal !== "object" ||
      typeof signal.aborted !== "boolean" ||
      typeof signal.addEventListener !== "function")
  ) {
    throw new TypeError('"signal" must be an AbortSignal when provided.');
  }
  const throwIfAborted = () => {
    if (signal?.aborted) throw new Error("Cleanser operation was cancelled.");
  };
  throwIfAborted();
  if (
    limits !== undefined &&
    (!limits ||
      typeof limits !== "object" ||
      Object.entries(limits).some(
        ([key, value]) =>
          !["maxFiles", "maxBytes"].includes(key) ||
          !Number.isSafeInteger(value) ||
          value < 0,
      ))
  ) {
    throw new TypeError(
      '"limits" must contain non-negative safe integer maxFiles or maxBytes values.',
    );
  }
  if (
    changedFiles !== undefined &&
    (!Array.isArray(changedFiles) ||
      changedFiles.some(
        (filePath) => typeof filePath !== "string" || filePath.length === 0,
      ))
  ) {
    throw new TypeError(
      '"changedFiles" must be an array of project-relative paths.',
    );
  }

  const absoluteRoot = path.resolve(root);
  const rootStats = await fs.stat(absoluteRoot).catch((error) => {
    throw new Error(
      `Could not access project root "${absoluteRoot}": ${error.message}`,
    );
  });
  if (!rootStats.isDirectory()) {
    throw new Error(`Project root is not a directory: "${absoluteRoot}".`);
  }
  if (write && config.safety.require_clean_working_tree && !allowDirty) {
    await assertCleanWorkingTree({ root: absoluteRoot });
  }

  const files = selectChangedFiles(
    await collectProjectFiles(absoluteRoot, config, { signal }),
    absoluteRoot,
    changedFiles,
  );
  const results = [];
  const prepared = [];
  let completed = 0;

  const reportProgress = (filePath, status) => {
    completed++;
    onProgress?.({ completed, total: files.length, filePath, status });
  };

  const progressQueue = new Array(files.length);
  let nextProgressIndex = 0;
  let progressStopped = false;
  const queueProgress = (index, filePath, status) => {
    progressQueue[index] = { filePath, status };
    while (!progressStopped && progressQueue[nextProgressIndex]) {
      const next = progressQueue[nextProgressIndex++];
      if (next.status === "error") {
        progressStopped = true;
        break;
      }
      reportProgress(next.filePath, next.status);
    }
  };

  let firstErrorIndex = Infinity;
  const preparation = await mapConcurrentOrdered(
    files,
    4,
    async (filePath, index) => {
      if (index > firstErrorIndex) return { ignored: true };
      let outcome;
      try {
        throwIfAborted();
        if (!(await isSafeProjectFile(absoluteRoot, filePath))) {
          outcome = {
            result: {
              filePath,
              status: "skipped",
              reason: "File is no longer a regular file inside the project.",
            },
            progressStatus: "skipped",
          };
        } else {
          const original = await readCachedText(filePath);
          const stats = await fs.stat(filePath);
          const relativeFile = path
            .relative(absoluteRoot, filePath)
            .split(path.sep)
            .join("/");
          const fileConfig = resolveFileConfig(config, relativeFile);
          let formatted;
          try {
            formatted = await formatSource(original, filePath, fileConfig);
          } catch (error) {
            if (fileConfig.safety.skip_on_syntax_error) {
              outcome = {
                result: { filePath, status: "skipped", reason: error.message },
                progressStatus: "skipped",
              };
            } else {
              throw new Error(
                `Could not format ${path.relative(absoluteRoot, filePath)}: ${error.message}`,
                { cause: error },
              );
            }
          }

          if (!outcome) {
            let astEquivalent = true;
            let verificationMethod = "unchanged";
            if (formatted !== original) {
              let comparison;
              try {
                comparison = await compareAstEquivalence(
                  original,
                  formatted,
                  filePath,
                  fileConfig,
                );
              } catch (error) {
                throw new Error(
                  `Could not verify AST equivalence for ${relativeFile}: ${error.message}. No files were changed.`,
                  { cause: error },
                );
              }
              astEquivalent = comparison.equivalent;
              verificationMethod = comparison.method;
              if (!astEquivalent) {
                throw new Error(
                  `Source equivalence check failed for ${relativeFile}: ${comparison.difference}. No files were changed.`,
                );
              }
            }

            outcome = {
              prepared: {
                filePath,
                original,
                formatted,
                mode: stats.mode,
                astEquivalent,
                verificationMethod,
                risk: classifyChange({ kind: "format", astEquivalent }),
                confidence: classifyConfidence({ astEquivalent }),
              },
              progressStatus: formatted === original ? "unchanged" : "changed",
            };
          }
        }
      } catch (error) {
        firstErrorIndex = Math.min(firstErrorIndex, index);
        outcome = { error };
      }

      queueProgress(index, filePath, outcome.progressStatus ?? "error");
      return outcome;
    },
  );

  for (const outcome of preparation) {
    if (outcome.error) throw outcome.error;
    if (outcome.result) results.push(outcome.result);
    if (outcome.prepared) prepared.push(outcome.prepared);
  }
  throwIfAborted();

  const changes = prepared.filter((item) => item.formatted !== item.original);
  const configuredMaxFiles = config.safety.maximum_changed_files;
  const configuredMaxBytes = config.safety.maximum_change_bytes;
  const maxFiles = Math.min(
    configuredMaxFiles ?? Infinity,
    limits?.maxFiles ?? Infinity,
  );
  const maxBytes = Math.min(
    configuredMaxBytes ?? Infinity,
    limits?.maxBytes ?? Infinity,
  );
  const changeBytes = changes.reduce(
    (sum, item) => sum + Buffer.byteLength(item.formatted, "utf8"),
    0,
  );
  if (changes.length > maxFiles || changeBytes > maxBytes) {
    throw new Error(
      `Change limits exceeded: ${changes.length} file(s), ${changeBytes} byte(s); limits are ${Number.isFinite(maxFiles) ? maxFiles : "unlimited"} file(s) and ${Number.isFinite(maxBytes) ? maxBytes : "unlimited"} byte(s). No files were changed.`,
    );
  }

  const approvedFiles = new Set();
  const declinedFiles = new Set();
  for (const item of changes) {
    throwIfAborted();
    const approved =
      write && approveChange
        ? await approveChange({
            filePath: item.filePath,
            original: item.original,
            formatted: item.formatted,
            risk: item.risk,
            confidence: item.confidence,
            astEquivalent: item.astEquivalent,
            verificationMethod: item.verificationMethod,
          })
        : true;
    if (typeof approved !== "boolean") {
      throw new TypeError(
        "The change approval callback must return true or false.",
      );
    }
    if (approved) approvedFiles.add(item.filePath);
    else declinedFiles.add(item.filePath);
  }
  throwIfAborted();
  const approvedChanges = changes.filter((item) =>
    approvedFiles.has(item.filePath),
  );

  if (write && config.safety.create_backup) {
    for (const item of approvedChanges) {
      throwIfAborted();
      await createBackup(absoluteRoot, item.filePath, item.original);
    }
  }

  const written = [];
  try {
    for (const item of prepared) {
      throwIfAborted();
      const { filePath, original, formatted, mode } = item;
      if (formatted === original) {
        results.push({ filePath, status: "unchanged" });
        continue;
      }

      if (declinedFiles.has(filePath)) {
        results.push({
          filePath,
          status: "not-approved",
          risk: item.risk,
          confidence: item.confidence,
        });
        continue;
      }

      if (write) {
        if (!(await isSafeProjectFile(absoluteRoot, filePath))) {
          results.push({
            filePath,
            status: "skipped",
            reason: "File path changed before writing; no changes were made.",
          });
          continue;
        }
        let current;
        try {
          current = await fs.readFile(filePath, "utf8");
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        if (current !== original) {
          results.push({
            filePath,
            status: "skipped",
            reason:
              current === undefined
                ? "File was removed during formatting; no file was recreated."
                : "File changed during formatting; the newer content was preserved.",
          });
          continue;
        }
        try {
          await writeAtomically(filePath, formatted, mode);
          written.push(item);
        } catch (error) {
          throw new Error(
            `Could not safely write ${path.relative(absoluteRoot, filePath)}: ${error.message}`,
            { cause: error },
          );
        }
      }

      results.push({
        filePath,
        status: write ? "cleaned" : "would-clean",
        risk: item.risk,
        confidence: item.confidence,
        verificationMethod: item.verificationMethod,
      });
    }
    throwIfAborted();
  } catch (error) {
    const rollbackErrors = [];
    for (const item of written.reverse()) {
      try {
        if (!(await isSafeProjectFile(absoluteRoot, item.filePath))) {
          throw new Error("File is no longer a safe regular project file.");
        }
        const current = await fs.readFile(item.filePath, "utf8");
        if (current !== item.formatted) {
          throw new Error("File changed after Cleanser wrote it.");
        }
        await writeAtomically(item.filePath, item.original, item.mode);
      } catch (rollbackError) {
        rollbackErrors.push(
          `${path.relative(absoluteRoot, item.filePath)}: ${rollbackError.message}`,
        );
      }
    }
    const rollbackSummary =
      rollbackErrors.length > 0
        ? ` Rollback could not restore: ${rollbackErrors.join("; ")}. Original backups remain in .cleanser-backups.`
        : written.length > 0
          ? " Previously written files were restored to their original contents."
          : " No files had been changed.";
    throw new Error(`${error.message}${rollbackSummary}`, { cause: error });
  }

  const order = new Map(files.map((filePath, index) => [filePath, index]));
  return results.sort(
    (left, right) => order.get(left.filePath) - order.get(right.filePath),
  );
}

async function createProjectLock(root) {
  const lockPath = path.join(root, ".cleanser.lock");
  const token = randomUUID();
  let lock;
  try {
    lock = await fs.open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") {
      let owner = "";
      try {
        const lockInfo = JSON.parse(await fs.readFile(lockPath, "utf8"));
        owner = Number.isInteger(lockInfo.pid)
          ? ` (process ${lockInfo.pid}, started ${lockInfo.startedAt})`
          : "";
      } catch {
        owner = "";
      }
      throw new Error(
        `Another Cleanser write operation holds .cleanser.lock${owner}. Remove the lock only after confirming no Cleanser process is running.`,
      );
    }
    throw error;
  }

  try {
    await lock.writeFile(
      JSON.stringify({
        pid: process.pid,
        token,
        startedAt: new Date().toISOString(),
      }),
      "utf8",
    );
    await lock.sync();
  } catch (error) {
    await lock.close().catch(() => {});
    await fs.rm(lockPath, { force: true }).catch(() => {});
    throw error;
  }

  return async () => {
    await lock.close().catch(() => {});
    try {
      const lockInfo = JSON.parse(await fs.readFile(lockPath, "utf8"));
      if (lockInfo.token === token) await fs.rm(lockPath, { force: true });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  };
}

export async function cleanProject(options = {}) {
  const { root = process.cwd(), write = true } = options;
  if (!write) return cleanProjectOperation(options);
  const absoluteRoot = path.resolve(root);
  const rootStats = await fs.stat(absoluteRoot).catch((error) => {
    throw new Error(
      `Could not access project root "${absoluteRoot}": ${error.message}`,
    );
  });
  if (!rootStats.isDirectory()) {
    throw new Error(`Project root is not a directory: "${absoluteRoot}".`);
  }
  const release = await createProjectLock(absoluteRoot);
  try {
    return await cleanProjectOperation(options);
  } finally {
    await release();
  }
}
