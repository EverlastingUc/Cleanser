import fs from "node:fs/promises";
import path from "node:path";
import { isSafeProjectFile } from "./cleaner.js";

const PACKAGE_FRAMEWORKS = new Map([
  ["react", { id: 223, name: "React" }],
  ["next", { id: 224, name: "Next.js" }],
  ["vue", { id: 225, name: "Vue" }],
  ["@angular/core", { id: 226, name: "Angular" }],
  ["svelte", { id: 227, name: "Svelte" }],
  ["express", { id: 229, name: "Express" }],
  ["@nestjs/core", { id: 230, name: "NestJS" }],
]);

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function packageDependencies(manifest) {
  const names = new Set();
  for (const section of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const dependencies = manifest?.[section];
    if (dependencies && typeof dependencies === "object") {
      for (const name of Object.keys(dependencies)) names.add(name);
    }
  }
  return names;
}

async function readJson(root, filePath) {
  if (!(await isSafeProjectFile(root, filePath))) return undefined;
  try {
    const value = JSON.parse(
      await fs.readFile(path.join(root, filePath), "utf8"),
    );
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function add(detections, id, name, filePath) {
  const key = `${id}\0${filePath}`;
  detections.set(key, { id, name, filePath });
}

export async function detectProjectFrameworks({ root, files }) {
  if (typeof root !== "string" || !Array.isArray(files)) {
    throw new TypeError(
      "A project root and list of project files are required.",
    );
  }
  const absoluteRoot = path.resolve(root);
  const sortedFiles = [...files].sort(compareText);
  const javascriptDirectories = new Set(
    sortedFiles
      .filter((filePath) => /\.[cm]?js$/i.test(filePath))
      .map((filePath) => path.posix.dirname(filePath)),
  );
  const detections = new Map();

  for (const filePath of sortedFiles) {
    if (path.posix.basename(filePath) !== "package.json") continue;
    const manifest = await readJson(absoluteRoot, filePath);
    if (!manifest) continue;
    const dependencies = packageDependencies(manifest);
    const directory = path.posix.dirname(filePath);
    const sourceFile =
      directory === "." ? filePath : `${directory}/package.json`;
    for (const [packageName, framework] of PACKAGE_FRAMEWORKS) {
      if (dependencies.has(packageName)) {
        add(detections, framework.id, framework.name, sourceFile);
      }
    }
    if (
      typeof manifest.engines?.node === "string" ||
      (dependencies.size > 0 && javascriptDirectories.has(directory))
    ) {
      add(detections, 228, "Node.js", sourceFile);
    }
  }

  const textCache = new Map();
  async function readText(filePath) {
    if (textCache.has(filePath)) return textCache.get(filePath);
    if (!(await isSafeProjectFile(absoluteRoot, filePath))) return "";
    const value = await fs
      .readFile(path.join(absoluteRoot, filePath), "utf8")
      .catch(() => "");
    textCache.set(filePath, value);
    return value;
  }

  const pythonFiles = sortedFiles.filter((filePath) =>
    /(?:^|\/)(?:requirements(?:[-.][^/]*)?\.txt|pyproject\.toml|Pipfile)$/i.test(
      filePath,
    ),
  );
  for (const filePath of pythonFiles) {
    const source = await readText(filePath);
    if (/^\s*["']?django(?:\[[^\]]*\])?\s*(?:[<>=!~;,"']|$)/im.test(source)) {
      add(detections, 231, "Django", filePath);
    }
    if (/^\s*["']?flask(?:\[[^\]]*\])?\s*(?:[<>=!~;,"']|$)/im.test(source)) {
      add(detections, 232, "Flask", filePath);
    }
  }

  for (const filePath of sortedFiles) {
    const basename = path.posix.basename(filePath).toLowerCase();
    if (basename === "composer.json") {
      const manifest = await readJson(absoluteRoot, filePath);
      const dependencies = new Set([
        ...Object.keys(manifest?.require ?? {}),
        ...Object.keys(manifest?.["require-dev"] ?? {}),
      ]);
      if (dependencies.has("laravel/framework")) {
        add(detections, 233, "Laravel", filePath);
      }
    } else if (basename === "pom.xml") {
      const source = await readText(filePath);
      if (/org\.springframework|spring-boot-starter/i.test(source)) {
        add(detections, 234, "Spring", filePath);
      }
    } else if (basename === "build.gradle" || basename === "build.gradle.kts") {
      const source = await readText(filePath);
      if (/org\.springframework\.boot|spring-boot/i.test(source)) {
        add(detections, 234, "Spring", filePath);
      }
    } else if (/\.csproj$/i.test(basename) || basename.endsWith(".sln")) {
      add(detections, 235, ".NET", filePath);
    } else if (basename === "cargo.toml") {
      add(detections, 236, "Cargo", filePath);
    } else if (basename === "go.mod") {
      add(detections, 237, "Go module", filePath);
    } else if (basename === "cmakelists.txt") {
      add(detections, 238, "CMake", filePath);
    }
  }

  return [...detections.values()].sort(
    (left, right) =>
      left.id - right.id || compareText(left.filePath, right.filePath),
  );
}
