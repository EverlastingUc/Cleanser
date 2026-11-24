import crypto from "node:crypto";
import { builtinModules } from "node:module";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import YAML from "yaml";
import { isSafeProjectFile } from "./cleaner.js";
import { auditMarkdownDocuments } from "./documentation-audit.js";
import { buildDependencyGraph } from "./dependency-graph.js";
import { detectProjectFrameworks } from "./framework-detection.js";

const SKIPPED_DIRECTORIES = new Set([".git", "node_modules"]);
const BUILD_DIRECTORIES = new Set([
  "build",
  "coverage",
  "dist",
  "out",
  "target",
  ".next",
  ".nuxt",
]);
const CONFIGURATION_FILE =
  /^(?:\.cleanser\.(?:clns|json)|tsconfig(?:\.[^.]+)?\.json|jsconfig\.json|\.prettierrc(?:\..+)?|prettier\.config\..+|\.eslintrc(?:\..+)?|eslint\.config\..+|babel\.config\..+|webpack\.config\..+)$/i;
const REQUIRED_IGNORE_ENTRIES = [
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".cleanser-backups",
];
const SOURCE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
]);
const TEST_FILE_PATTERN =
  /(?:^|\/)(?:__tests__\/.*|.*\.(?:test|spec)\.[cm]?[jt]sx?)$/i;
const TEST_CALL_NAMES = new Set([
  "test",
  "it",
  "describe",
  "suite",
  "context",
  "specify",
]);
const ASSET_EXTENSIONS = new Set([
  ".avif",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".mp3",
  ".mp4",
  ".ogg",
  ".otf",
  ".pdf",
  ".png",
  ".svg",
  ".ttf",
  ".wav",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
]);
const ASSET_REFERENCE_EXTENSIONS = new Set([
  ".astro",
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".jsx",
  ".json",
  ".jsonc",
  ".md",
  ".mdx",
  ".mjs",
  ".mts",
  ".scss",
  ".svelte",
  ".ts",
  ".tsx",
  ".vue",
  ".yaml",
  ".yml",
]);
const MAX_REFERENCE_SOURCE_BYTES = 2_000_000;
const MAX_TOTAL_REFERENCE_SOURCE_BYTES = 32_000_000;
const MAX_REFERENCE_FILE_COUNT = 10_000;
const MAX_ASSET_REFERENCE_COMPARISONS = 2_000_000;
const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const BUILTIN_MODULES = new Set(
  builtinModules.flatMap((name) => [name, name.replace(/^node:/, "")]),
);
const AUDIT_GRAPH_CONFIG = {
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
    ],
    exclude: [
      "node_modules/**",
      ".git/**",
      "dist/**",
      "build/**",
      "coverage/**",
      "out/**",
      "target/**",
      ".next/**",
      ".nuxt/**",
      ".cleanser-backups/**",
    ],
  },
  safety: { protected_paths: [] },
};

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function relativePath(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join("/") || ".";
}

function finding(filePath, ruleId, message, severity = "info") {
  return {
    filePath,
    line: 1,
    column: 1,
    severity,
    ruleId,
    message,
  };
}

function packageNameFromSpecifier(specifier) {
  if (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("#") ||
    specifier.startsWith("\\") ||
    specifier.startsWith("@/") ||
    specifier.startsWith("~/") ||
    /^[a-z][a-z\d+.-]*:/i.test(specifier)
  ) {
    return undefined;
  }
  const segments = specifier.split("/");
  if (specifier.startsWith("@") && segments.length < 2) return undefined;
  return specifier.startsWith("@")
    ? segments.slice(0, 2).join("/")
    : segments[0];
}

function isBuiltinSpecifier(specifier, packageName) {
  const normalized = specifier.replace(/^node:/, "");
  return (
    BUILTIN_MODULES.has(specifier) ||
    BUILTIN_MODULES.has(normalized) ||
    BUILTIN_MODULES.has(packageName)
  );
}

function collectExternalImports(sourceText, fileName) {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );
  const imports = new Set();
  const add = (specifier) => {
    const packageName = packageNameFromSpecifier(specifier);
    if (packageName && !isBuiltinSpecifier(specifier, packageName)) {
      imports.add(packageName);
    }
  };

  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      add(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      ((ts.isIdentifier(node.expression) &&
        node.expression.text === "require") ||
        node.expression.kind === ts.SyntaxKind.ImportKeyword)
    ) {
      add(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return imports;
}

function containsRecognizedTestCall(sourceText, fileName) {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );
  if (sourceFile.parseDiagnostics.length > 0) return true;
  let found = false;
  function visit(node) {
    if (found) return;
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      if (ts.isIdentifier(expression) && TEST_CALL_NAMES.has(expression.text)) {
        found = true;
        return;
      }
      if (
        ts.isPropertyAccessExpression(expression) &&
        (TEST_CALL_NAMES.has(expression.name.text) ||
          (ts.isIdentifier(expression.expression) &&
            TEST_CALL_NAMES.has(expression.expression.text)))
      ) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return found;
}

async function readJsonFile(filePath) {
  try {
    const stats = await fs.lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      return { exists: false };
    }
    const source = await fs.readFile(filePath, "utf8");
    try {
      const value = JSON.parse(source);
      YAML.parse(source, { uniqueKeys: true });
      return { exists: true, value };
    } catch (error) {
      return { exists: true, error };
    }
  } catch (error) {
    if (error.code === "ENOENT") return { exists: false };
    throw error;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getDependencySections(manifest) {
  const sections = new Map();
  for (const sectionName of DEPENDENCY_SECTIONS) {
    const section = manifest?.[sectionName];
    if (!isPlainObject(section)) continue;
    for (const [name, version] of Object.entries(section)) {
      const entries = sections.get(name) ?? [];
      entries.push({ section: sectionName, version: String(version) });
      sections.set(name, entries);
    }
  }
  return sections;
}

async function addPackageFindings({
  manifest,
  lockfile,
  root,
  sourceFiles,
  findings,
}) {
  const manifestRelative = "package.json";
  const lockfileRelative = "package-lock.json";
  if (!manifest?.exists) {
    if (lockfile?.exists) {
      findings.push(
        finding(
          lockfileRelative,
          "lockfile-mismatch",
          "package-lock.json exists without a root package.json manifest.",
          "warning",
        ),
      );
    }
    return;
  }
  if (manifest.error || !isPlainObject(manifest.value)) {
    if (
      manifest?.error ||
      (manifest?.exists && !isPlainObject(manifest.value))
    ) {
      findings.push(
        finding(
          manifestRelative,
          "invalid-package-manifest",
          "package.json must contain a valid JSON object.",
          "warning",
        ),
      );
    }
    return;
  }

  const manifestValue = manifest.value;
  const dependencies = getDependencySections(manifestValue);
  const importFiles = new Map();
  for (const relative of sourceFiles) {
    const absolute = path.join(root, relative);
    if (!(await isSafeProjectFile(root, relative))) continue;
    let source;
    try {
      source = await fs.readFile(absolute, "utf8");
    } catch {
      continue;
    }
    for (const name of collectExternalImports(source, absolute)) {
      const files = importFiles.get(name) ?? [];
      files.push(relative);
      importFiles.set(name, files);
    }
  }

  const declared = new Set(dependencies.keys());
  for (const [name, files] of importFiles) {
    const suppliedByEditorHost =
      name === "vscode" && typeof manifestValue.engines?.vscode === "string";
    if (
      declared.has(name) ||
      name === manifestValue.name ||
      suppliedByEditorHost
    ) {
      continue;
    }
    findings.push(
      finding(
        files.sort(compareText)[0],
        "missing-dependency",
        `External package "${name}" is imported but is not listed in package.json.`,
        "warning",
      ),
    );
  }

  for (const [name, entries] of dependencies) {
    if (entries.length > 1) {
      const versions = new Set(entries.map((entry) => entry.version));
      if (versions.size > 1) {
        findings.push(
          finding(
            manifestRelative,
            "dependency-version-conflict",
            `Package "${name}" has different declared version ranges in ${entries.map((entry) => entry.section).join(" and ")}; verify that they are compatible.`,
            "warning",
          ),
        );
      } else {
        findings.push(
          finding(
            manifestRelative,
            "duplicate-dependency",
            `Package "${name}" is repeated in ${entries.map((entry) => entry.section).join(" and ")}.`,
          ),
        );
      }
    }
  }

  const directDependencies = new Set(
    ["dependencies", "devDependencies", "optionalDependencies"].flatMap(
      (sectionName) => Object.keys(manifestValue[sectionName] ?? {}),
    ),
  );
  const packageScripts = Object.values(manifestValue.scripts ?? {})
    .filter((script) => typeof script === "string")
    .join("\n");
  for (const name of directDependencies) {
    const executableName = name.split("/").at(-1);
    const escapedExecutable = [...executableName]
      .map((character) =>
        "\\.^$|?*+()[]{}".includes(character) ? `\\${character}` : character,
      )
      .join("");
    const usedByScript = new RegExp(
      `(?:^|[\\s/\\\\])${escapedExecutable}(?:$|[\\s:/\\\\])`,
      "i",
    ).test(packageScripts);
    if (!importFiles.has(name) && !usedByScript) {
      findings.push(
        finding(
          manifestRelative,
          "unused-dependency",
          `Package "${name}" is not imported by scanned JavaScript or TypeScript files or recognized as a script executable; config-driven, generated, and dynamic references are not evaluated.`,
        ),
      );
    }
  }

  if (!lockfile?.exists) return;
  if (lockfile.error || !isPlainObject(lockfile.value)) {
    findings.push(
      finding(
        lockfileRelative,
        "lockfile-mismatch",
        "package-lock.json must contain a valid JSON object.",
        "warning",
      ),
    );
    return;
  }

  const lockValue = lockfile.value;
  const mismatches = [];
  if (
    lockValue.name &&
    manifestValue.name &&
    lockValue.name !== manifestValue.name
  ) {
    mismatches.push("the package name");
  }
  if (
    lockValue.version &&
    manifestValue.version &&
    lockValue.version !== manifestValue.version
  ) {
    mismatches.push("the package version");
  }
  const lockedRoot = lockValue.packages?.[""];
  if (isPlainObject(lockedRoot)) {
    for (const sectionName of DEPENDENCY_SECTIONS) {
      const declaredSection = manifestValue[sectionName] ?? {};
      const lockedSection = lockedRoot[sectionName] ?? {};
      if (
        JSON.stringify(Object.entries(declaredSection).sort()) !==
        JSON.stringify(Object.entries(lockedSection).sort())
      ) {
        mismatches.push(sectionName);
      }
    }
  } else if (isPlainObject(lockValue.dependencies)) {
    for (const name of dependencies.keys()) {
      if (!Object.hasOwn(lockValue.dependencies, name)) {
        mismatches.push(`dependency ${name}`);
      }
    }
  }
  if (mismatches.length > 0) {
    findings.push(
      finding(
        lockfileRelative,
        "lockfile-mismatch",
        `Lockfile does not match package.json for ${[...new Set(mismatches)].join(", ")}.`,
        "warning",
      ),
    );
  }
}

function packageEntrypointValues(manifest) {
  if (!isPlainObject(manifest)) return [];
  const values = [];
  for (const key of ["main", "module", "browser", "types", "typings"]) {
    if (typeof manifest[key] === "string") values.push(manifest[key]);
  }
  if (typeof manifest.bin === "string") values.push(manifest.bin);
  else if (isPlainObject(manifest.bin)) {
    values.push(
      ...Object.values(manifest.bin).filter(
        (value) => typeof value === "string",
      ),
    );
  }

  function addExportPaths(value) {
    if (typeof value === "string") {
      if (!value.includes("*") && value.startsWith(".")) values.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const nested of value) addExportPaths(nested);
      return;
    }
    if (isPlainObject(value)) {
      for (const nested of Object.values(value)) addExportPaths(nested);
    }
  }

  addExportPaths(manifest.exports);
  return [...new Set(values)];
}

function resolvePackageEntrypoint(value, graphNodes) {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const normalized = path.posix
    .normalize(value.replace(/\\/g, "/"))
    .replace(/^\.\//, "");
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized) ||
    normalized.includes("*")
  ) {
    return undefined;
  }

  const extension = path.posix.extname(normalized).toLowerCase();
  const extensions = [
    ".js",
    ".jsx",
    ".ts",
    ".tsx",
    ".mjs",
    ".cjs",
    ".mts",
    ".cts",
  ];
  const candidates = extension
    ? [
        normalized,
        ...(extension === ".js" ? [normalized.slice(0, -3) + ".ts"] : []),
        ...(extension === ".mjs" ? [normalized.slice(0, -4) + ".mts"] : []),
        ...(extension === ".cjs" ? [normalized.slice(0, -4) + ".cts"] : []),
      ]
    : [
        normalized,
        ...extensions.map((item) => `${normalized}${item}`),
        ...extensions.map((item) => `${normalized}/index${item}`),
      ];
  return candidates.find((candidate) => graphNodes.has(candidate));
}

async function addUnusedModuleCandidates({ root, manifest, findings }) {
  const entrypointValues = packageEntrypointValues(manifest);
  if (entrypointValues.length === 0) return;

  const graph = await buildDependencyGraph({
    root,
    config: AUDIT_GRAPH_CONFIG,
  });
  const graphNodes = new Set(graph.nodes);
  const entrypoints = entrypointValues.map((value) =>
    resolvePackageEntrypoint(value, graphNodes),
  );
  if (entrypoints.length === 0 || entrypoints.some((item) => !item)) return;

  const reachable = new Set();
  const pending = [...entrypoints];
  const adjacency = new Map(graph.nodes.map((node) => [node, []]));
  for (const edge of graph.edges) {
    if (edge.targetPath) adjacency.get(edge.sourcePath)?.push(edge.targetPath);
  }
  while (pending.length > 0) {
    const current = pending.pop();
    if (reachable.has(current)) continue;
    reachable.add(current);
    pending.push(...(adjacency.get(current) ?? []));
  }

  const testFilePattern = /(?:^|[./_-])(?:test|spec)(?:[./_-]|$)/i;
  for (const filePath of graph.nodes) {
    if (reachable.has(filePath) || testFilePattern.test(filePath)) continue;
    findings.push(
      finding(
        filePath,
        "unused-module-candidate",
        "No local import path from the declared package entrypoints reaches this module. Dynamic imports, framework conventions, and direct script use may not be detected; review before removal.",
      ),
    );
  }
}

async function hashFile(filePath) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function isTemporaryFile(name) {
  return (
    /\.(?:tmp|temp|swp|swo)$/i.test(name) ||
    /^\.#/.test(name) ||
    /^~\$/.test(name)
  );
}

function isBackupFile(name, relative) {
  return (
    relative.startsWith(".cleanser-backups/") ||
    /\.(?:bak|backup|old|orig)$/i.test(name) ||
    /~$/.test(name)
  );
}

async function addUnusedAssetCandidates({
  root,
  assets,
  referenceFiles,
  referenceScanComplete,
  findings,
}) {
  if (
    assets.length === 0 ||
    !referenceScanComplete ||
    assets.length * referenceFiles.length > MAX_ASSET_REFERENCE_COMPARISONS
  ) {
    return;
  }

  const referenceSources = [];
  for (const filePath of referenceFiles) {
    if (!(await isSafeProjectFile(root, filePath))) continue;
    try {
      const source = await fs.readFile(path.join(root, filePath), "utf8");
      referenceSources.push({
        filePath,
        source: source.toLowerCase(),
      });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  const basenameCounts = new Map();
  for (const filePath of assets) {
    const basename = path.posix.basename(filePath).toLowerCase();
    basenameCounts.set(basename, (basenameCounts.get(basename) ?? 0) + 1);
  }

  for (const filePath of assets) {
    const normalized = filePath.toLowerCase();
    const baseCandidates = new Set([normalized, `./${normalized}`]);
    if (normalized.startsWith("public/")) {
      baseCandidates.add(normalized.slice("public/".length));
      baseCandidates.add(`/${normalized.slice("public/".length)}`);
    }
    if (normalized.startsWith("static/")) {
      baseCandidates.add(normalized.slice("static/".length));
      baseCandidates.add(`/${normalized.slice("static/".length)}`);
    }
    const basename = path.posix.basename(normalized);
    if (basenameCounts.get(basename) === 1) baseCandidates.add(basename);
    let referenced = false;
    for (const reference of referenceSources) {
      const relative = path.posix.relative(
        path.posix.dirname(reference.filePath),
        normalized,
      );
      const candidates = new Set(baseCandidates);
      candidates.add(relative);
      candidates.add(`./${relative}`);
      if (
        [...candidates].some(
          (candidate) => candidate && reference.source.includes(candidate),
        )
      ) {
        referenced = true;
        break;
      }
    }
    if (!referenced) {
      findings.push(
        finding(
          filePath,
          "unused-asset-candidate",
          "No static reference to this asset was found in scanned text files; dynamic paths, generated manifests, and external consumers may still use it.",
        ),
      );
    }
  }
}

async function addOrphanedConfigurationCandidates({
  root,
  configurationFiles,
  sourceFiles,
  manifest,
  findings,
}) {
  const rootConfigurationNames = new Set(
    configurationFiles.filter((filePath) => !filePath.includes("/")),
  );
  if (rootConfigurationNames.size === 0) return;

  const sourceExtensions = new Set(
    sourceFiles.map((filePath) => path.posix.extname(filePath).toLowerCase()),
  );
  const hasTypeScriptSources = [".ts", ".tsx", ".mts", ".cts"].some(
    (extension) => sourceExtensions.has(extension),
  );
  const hasJavaScriptSources = [".js", ".jsx", ".mjs", ".cjs"].some(
    (extension) => sourceExtensions.has(extension),
  );
  const scripts = Object.values(manifest?.scripts ?? {})
    .filter((script) => typeof script === "string")
    .join("\n");
  const declaredDependencies = getDependencySections(manifest);
  const usesTypeScriptTool =
    /\b(?:tsc|vue-tsc|ts-node|tsx)\b|tsconfig\.json/i.test(scripts) ||
    ["typescript", "vue-tsc", "ts-node", "tsx"].some((name) =>
      declaredDependencies.has(name),
    );

  if (rootConfigurationNames.has("tsconfig.json") && !usesTypeScriptTool) {
    const config = await readJsonFile(path.join(root, "tsconfig.json"));
    const referencedProjects = config.value?.references;
    const coversJavaScript =
      config.value?.compilerOptions?.allowJs === true ||
      config.value?.compilerOptions?.checkJs === true;
    if (
      !config.error &&
      config.exists &&
      !hasTypeScriptSources &&
      !(coversJavaScript && hasJavaScriptSources) &&
      (!Array.isArray(referencedProjects) || referencedProjects.length === 0)
    ) {
      findings.push(
        finding(
          "tsconfig.json",
          "orphaned-configuration-candidate",
          "No matching TypeScript sources, declared TypeScript tooling, or project references were found; editor-only, generated, and external-tool usage may still depend on this config.",
        ),
      );
    }
  }

  if (
    rootConfigurationNames.has("jsconfig.json") &&
    !hasJavaScriptSources &&
    !/jsconfig\.json/i.test(scripts)
  ) {
    const config = await readJsonFile(path.join(root, "jsconfig.json"));
    if (!config.error && config.exists) {
      findings.push(
        finding(
          "jsconfig.json",
          "orphaned-configuration-candidate",
          "No JavaScript sources or package script references were found; editor-only, generated, and external-tool usage may still depend on this config.",
        ),
      );
    }
  }
}

function isIgnoredByGitignore(patterns, directory) {
  return patterns.some((pattern) => {
    const normalized = pattern.trim().replace(/^\//, "").replace(/\/$/, "");
    return (
      normalized === directory ||
      normalized === `${directory}/**` ||
      normalized === `**/${directory}` ||
      normalized === `**/${directory}/**`
    );
  });
}

async function existsAsDirectory(root, name) {
  try {
    const stats = await fs.lstat(path.join(root, name));
    return stats.isDirectory() && !stats.isSymbolicLink();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function auditProject({ root = process.cwd() } = {}) {
  const absoluteRoot = path.resolve(root);
  const rootStats = await fs.stat(absoluteRoot).catch((error) => {
    throw new Error(
      `Could not access project root "${absoluteRoot}": ${error.message}`,
    );
  });
  if (!rootStats.isDirectory()) {
    throw new Error(`Project root is not a directory: "${absoluteRoot}".`);
  }

  const findings = [];
  const configurationGroups = new Map();
  const fileContentGroups = new Map();
  const markdownFiles = [];
  const sourceFiles = [];
  const testFiles = [];
  const configurationFiles = [];
  const assets = [];
  const projectFiles = [];
  const assetReferenceFiles = [];
  let assetReferenceBytes = 0;
  let assetReferenceScanComplete = true;
  const summary = {
    fileCount: 0,
    directoryCount: 0,
    totalBytes: 0,
    extensions: {},
  };

  async function visit(directory) {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      throw new Error(
        `Could not read directory "${relativePath(absoluteRoot, directory)}": ${error.message}`,
        { cause: error },
      );
    }
    entries.sort((left, right) => compareText(left.name, right.name));
    const directoryRelative = relativePath(absoluteRoot, directory);
    if (directoryRelative !== "." && entries.length === 0) {
      findings.push(
        finding(
          directoryRelative,
          "empty-directory",
          "Directory contains no entries.",
        ),
      );
    }

    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const fileRelative = relativePath(absoluteRoot, absolutePath);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
        summary.directoryCount++;
        if (BUILD_DIRECTORIES.has(entry.name)) {
          findings.push(
            finding(
              fileRelative,
              "build-artifact",
              "Directory name matches a common generated build output.",
            ),
          );
          continue;
        }
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;

      const stats = await fs.stat(absolutePath);
      projectFiles.push(fileRelative);
      summary.fileCount++;
      summary.totalBytes += stats.size;
      const extension =
        path.extname(entry.name).toLowerCase() || "[no extension]";
      summary.extensions[extension] = (summary.extensions[extension] ?? 0) + 1;
      if (extension === ".md") markdownFiles.push(fileRelative);
      if (SOURCE_EXTENSIONS.has(extension)) sourceFiles.push(fileRelative);
      if (
        SOURCE_EXTENSIONS.has(extension) &&
        TEST_FILE_PATTERN.test(fileRelative)
      ) {
        testFiles.push(fileRelative);
      }
      if (ASSET_EXTENSIONS.has(extension)) assets.push(fileRelative);
      if (
        ASSET_REFERENCE_EXTENSIONS.has(extension) &&
        entry.name.toLowerCase() !== "package-lock.json"
      ) {
        if (
          stats.size > MAX_REFERENCE_SOURCE_BYTES ||
          assetReferenceBytes + stats.size > MAX_TOTAL_REFERENCE_SOURCE_BYTES ||
          assetReferenceFiles.length >= MAX_REFERENCE_FILE_COUNT
        ) {
          assetReferenceScanComplete = false;
        } else {
          assetReferenceFiles.push(fileRelative);
          assetReferenceBytes += stats.size;
        }
      }

      if (stats.size === 0) {
        findings.push(
          finding(fileRelative, "empty-file", "File has no content."),
        );
      }
      if (isTemporaryFile(entry.name)) {
        findings.push(
          finding(
            fileRelative,
            "temporary-file",
            "File name matches a common editor or temporary-file pattern.",
          ),
        );
      }
      if (isBackupFile(entry.name, fileRelative)) {
        findings.push(
          finding(
            fileRelative,
            "backup-file",
            "File appears to be a backup copy.",
          ),
        );
      }
      if (extension === ".log") {
        findings.push(
          finding(
            fileRelative,
            "log-file",
            "Log file is present in the project tree.",
          ),
        );
      }
      const isConfigurationFile = CONFIGURATION_FILE.test(entry.name);
      if (isConfigurationFile) configurationFiles.push(fileRelative);
      if (stats.size > 0 || isConfigurationFile) {
        const digest = await hashFile(absolutePath);
        if (isConfigurationFile) {
          const groupKey = `${entry.name.toLowerCase()}\0${digest}`;
          const group = configurationGroups.get(groupKey) ?? [];
          group.push(fileRelative);
          configurationGroups.set(groupKey, group);
        }
        if (stats.size > 0) {
          const groupKey = `${extension}\0${stats.size}\0${digest}`;
          const group = fileContentGroups.get(groupKey) ?? [];
          group.push(fileRelative);
          fileContentGroups.set(groupKey, group);
        }
      }
    }
  }

  await visit(absoluteRoot);

  const frameworks = await detectProjectFrameworks({
    root: absoluteRoot,
    files: projectFiles,
  });
  summary.frameworkCount = frameworks.length;
  for (const framework of frameworks) {
    findings.push(
      finding(
        framework.filePath,
        "framework-detected",
        `Detected likely ${framework.name} project metadata; this audit does not validate framework-specific source conventions.`,
      ),
    );
  }

  for (const filePath of testFiles) {
    const absolutePath = path.join(absoluteRoot, filePath);
    if (!(await isSafeProjectFile(absoluteRoot, filePath))) continue;
    const source = await fs.readFile(absolutePath, "utf8");
    if (!containsRecognizedTestCall(source, absolutePath)) {
      findings.push(
        finding(
          filePath,
          "test-file-without-tests",
          "File matches a common test naming pattern but contains no recognized test or suite calls; dynamic registration may not be detected.",
        ),
      );
    }
  }

  const manifest = await readJsonFile(path.join(absoluteRoot, "package.json"));
  await addPackageFindings({
    manifest,
    lockfile: await readJsonFile(path.join(absoluteRoot, "package-lock.json")),
    root: absoluteRoot,
    sourceFiles,
    findings,
  });
  await addUnusedModuleCandidates({
    root: absoluteRoot,
    manifest: manifest.value,
    findings,
  });
  await addUnusedAssetCandidates({
    root: absoluteRoot,
    assets,
    referenceFiles: assetReferenceFiles,
    referenceScanComplete: assetReferenceScanComplete,
    findings,
  });
  await addOrphanedConfigurationCandidates({
    root: absoluteRoot,
    configurationFiles,
    sourceFiles,
    manifest: manifest.value,
    findings,
  });

  const documentation = await auditMarkdownDocuments({
    root: absoluteRoot,
    files: markdownFiles,
  });
  findings.push(...documentation.findings);
  summary.documentation = documentation.summary;

  for (const files of configurationGroups.values()) {
    if (files.length < 2) continue;
    files.sort(compareText);
    for (const file of files.slice(1)) {
      findings.push(
        finding(
          file,
          "duplicate-configuration",
          `Configuration content duplicates ${files[0]}.`,
        ),
      );
    }
  }

  for (const files of fileContentGroups.values()) {
    if (files.length < 2) continue;
    files.sort(compareText);
    for (const file of files.slice(1)) {
      findings.push(
        finding(
          file,
          "duplicate-file",
          `File content exactly matches ${files[0]}.`,
        ),
      );
    }
  }

  const gitignorePath = path.join(absoluteRoot, ".gitignore");
  const ignorePatterns = await fs
    .readFile(gitignorePath, "utf8")
    .then((source) =>
      source
        .split(/\r?\n/)
        .filter((line) => line.trim() && !line.trim().startsWith("#")),
    )
    .catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
  for (const directory of REQUIRED_IGNORE_ENTRIES) {
    if (
      (await existsAsDirectory(absoluteRoot, directory)) &&
      !isIgnoredByGitignore(ignorePatterns, directory)
    ) {
      findings.push(
        finding(
          ".gitignore",
          "missing-gitignore-entry",
          `Add an ignore pattern for the existing ${directory}/ directory.`,
        ),
      );
    }
  }

  summary.extensions = Object.fromEntries(
    Object.entries(summary.extensions).sort(([left], [right]) =>
      compareText(left, right),
    ),
  );
  findings.sort(
    (left, right) =>
      compareText(left.filePath, right.filePath) ||
      compareText(left.ruleId, right.ruleId),
  );

  return { summary, findings };
}
