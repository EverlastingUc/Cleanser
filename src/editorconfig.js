import fs from "node:fs/promises";
import path from "node:path";

function expandBraces(pattern) {
  const match = pattern.match(/\{([^{}]+)\}/);
  if (!match) return [pattern];
  const alternatives = match[1].split(",");
  if (alternatives.length < 2) return [pattern];
  return alternatives.flatMap((alternative) =>
    expandBraces(
      pattern.slice(0, match.index) +
        alternative +
        pattern.slice(match.index + match[0].length),
    ),
  );
}

function globToRegExp(pattern) {
  let expression = "^";
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    const next = pattern[index + 1];
    if (character === "*" && next === "*") {
      if (pattern[index + 2] === "/") {
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
    } else if (character === "[") {
      const end = pattern.indexOf("]", index + 1);
      if (end === -1) {
        expression += "\\[";
      } else {
        let group = pattern.slice(index + 1, end);
        if (group.startsWith("!")) group = `^${group.slice(1)}`;
        expression += `[${group}]`;
        index = end;
      }
    } else {
      expression += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${expression}$`);
}

function matchesEditorConfigSection(relativePath, section) {
  const normalizedPath = relativePath.split(path.sep).join("/");
  const normalizedSection = section.replace(/\\/g, "/");
  const patterns = expandBraces(normalizedSection).map((pattern) =>
    pattern.includes("/") ? pattern : `**/${pattern}`,
  );
  return patterns.some((pattern) => globToRegExp(pattern).test(normalizedPath));
}

export function parseEditorConfig(source) {
  if (typeof source !== "string") {
    throw new TypeError("EditorConfig source must be a string.");
  }
  const config = { root: false, defaults: {}, sections: [] };
  let current;
  for (const [index, rawLine] of source
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      const pattern = line.slice(1, -1).trim();
      if (!pattern) {
        throw new Error(`EditorConfig section on line ${index + 1} is empty.`);
      }
      try {
        const patterns = expandBraces(pattern);
        if (patterns.length === 1 && patterns[0] === pattern) {
          globToRegExp(pattern.includes("/") ? pattern : `**/${pattern}`);
        } else {
          patterns
            .map((candidate) =>
              candidate.includes("/") ? candidate : `**/${candidate}`,
            )
            .forEach(globToRegExp);
        }
      } catch (error) {
        throw new Error(
          `Invalid EditorConfig section on line ${index + 1}: ${error.message}`,
          { cause: error },
        );
      }
      current = { pattern, properties: {} };
      config.sections.push(current);
      continue;
    }

    const separator = line.search(/[:=]/);
    if (separator < 1) {
      throw new Error(`Invalid EditorConfig property on line ${index + 1}.`);
    }
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line
      .slice(separator + 1)
      .trim()
      .toLowerCase();
    if (!/^[a-z_][a-z0-9_-]*$/.test(key) || !value) {
      throw new Error(`Invalid EditorConfig property on line ${index + 1}.`);
    }
    const validValues = {
      indent_style: ["space", "tab", "unset"],
      indent_size: ["tab", "unset"],
      end_of_line: ["lf", "crlf", "cr", "unset"],
      insert_final_newline: ["true", "false", "unset"],
      trim_trailing_whitespace: ["true", "false", "unset"],
    };
    if (
      validValues[key] &&
      !validValues[key].includes(value) &&
      !(key === "indent_size" && /^\d+$/.test(value))
    ) {
      throw new Error(
        `Invalid EditorConfig value for "${key}" on line ${index + 1}.`,
      );
    }
    if (key === "tab_width" && !/^\d+$/.test(value) && value !== "unset") {
      throw new Error(
        `Invalid EditorConfig value for "${key}" on line ${index + 1}.`,
      );
    }
    if (
      ["indent_size", "tab_width"].includes(key) &&
      /^\d+$/.test(value) &&
      (Number(value) < 1 || Number(value) > 16)
    ) {
      throw new Error(
        `EditorConfig "${key}" on line ${index + 1} must be between 1 and 16.`,
      );
    }
    if (
      key === "max_line_length" &&
      !/^\d+$/.test(value) &&
      !["off", "unset"].includes(value)
    ) {
      throw new Error(
        `Invalid EditorConfig value for "${key}" on line ${index + 1}.`,
      );
    }
    if (
      key === "max_line_length" &&
      /^\d+$/.test(value) &&
      Number(value) > 1000
    ) {
      throw new Error(
        `EditorConfig "max_line_length" on line ${index + 1} must not exceed 1000.`,
      );
    }
    if (key === "root" && current) {
      throw new Error('EditorConfig "root" is valid only before sections.');
    }
    if (key === "root") {
      if (!["true", "false"].includes(value)) {
        throw new Error('EditorConfig "root" must be true or false.');
      }
      config.root = value === "true";
    } else {
      const properties = current?.properties ?? config.defaults;
      properties[key] = value;
    }
  }
  return config;
}

export function resolveEditorConfig(config, relativePath) {
  const result = {};
  if (!config) return result;
  const assign = (properties) => {
    for (const [key, value] of Object.entries(properties)) {
      if (value === "unset") delete result[key];
      else result[key] = value;
    }
  };
  assign(config.defaults);
  for (const section of config.sections) {
    if (matchesEditorConfigSection(relativePath, section.pattern)) {
      assign(section.properties);
    }
  }

  const formatting = {};
  if (result.indent_style === "space" || result.indent_style === "tab") {
    formatting.use_tabs = result.indent_style === "tab";
  }
  const tabWidth = Number.parseInt(result.tab_width, 10);
  const indentSize =
    result.indent_size === "tab"
      ? tabWidth
      : Number.parseInt(result.indent_size, 10);
  if (Number.isInteger(indentSize) && indentSize >= 1 && indentSize <= 16) {
    formatting.indentation = indentSize;
  } else if (Number.isInteger(tabWidth) && tabWidth >= 1 && tabWidth <= 16) {
    formatting.indentation = tabWidth;
  }
  if (["lf", "crlf", "cr"].includes(result.end_of_line)) {
    formatting.normalize_line_endings = result.end_of_line;
  }
  const printWidth = Number.parseInt(result.max_line_length, 10);
  if (Number.isInteger(printWidth) && printWidth >= 1 && printWidth <= 1000) {
    formatting.print_width = printWidth;
  }
  return {
    formatting,
    insertFinalNewline: result.insert_final_newline,
  };
}

export async function loadEditorConfigs(projectRoot) {
  const directories = [];
  let current = path.resolve(projectRoot);
  for (;;) {
    directories.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const configs = [];
  for (const directory of directories) {
    const filePath = path.join(directory, ".editorconfig");
    let stats;
    try {
      stats = await fs.lstat(filePath);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw new Error(`Could not inspect .editorconfig: ${error.message}`, {
        cause: error,
      });
    }
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error(
        `EditorConfig file "${filePath}" must be a regular file.`,
      );
    }
    const source = await fs.readFile(filePath, "utf8").catch((error) => {
      throw new Error(`Could not read .editorconfig: ${error.message}`, {
        cause: error,
      });
    });
    const parsed = parseEditorConfig(source);
    configs.push({ directory, parsed });
    if (parsed.root) break;
  }
  return configs.reverse();
}

export function resolveEditorConfigs(configs, root, relativePath) {
  const absoluteFile = path.resolve(root, relativePath);
  const result = { formatting: {}, insertFinalNewline: undefined };
  for (const entry of configs ?? []) {
    const localPath = path.relative(entry.directory, absoluteFile);
    if (
      localPath === ".." ||
      localPath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(localPath)
    ) {
      continue;
    }
    const resolved = resolveEditorConfig(entry.parsed, localPath);
    Object.assign(result.formatting, resolved.formatting);
    if (resolved.insertFinalNewline !== undefined) {
      result.insertFinalNewline = resolved.insertFinalNewline;
    }
  }
  return result;
}
