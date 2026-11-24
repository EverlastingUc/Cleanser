import path from "node:path";

const ADAPTER_ID = /^[a-z][a-z0-9-]*$/u;
const EXTENSION = /^\.[a-z0-9][a-z0-9.+-]*$/u;
const VALID_ADAPTERS = new WeakSet();

function validateAdapter(adapter) {
  if (!adapter || !VALID_ADAPTERS.has(adapter)) {
    throw new TypeError(
      "A Cleanser language adapter created by defineLanguageAdapter is required.",
    );
  }
}

export function defineLanguageAdapter({
  id,
  extensions,
  format,
  verify,
  description = "",
} = {}) {
  if (typeof id !== "string" || !ADAPTER_ID.test(id)) {
    throw new Error(
      "Language adapter IDs must use lowercase letters, digits, and hyphens.",
    );
  }
  if (
    !Array.isArray(extensions) ||
    extensions.length === 0 ||
    extensions.some(
      (extension) =>
        typeof extension !== "string" ||
        extension !== extension.toLowerCase() ||
        !EXTENSION.test(extension),
    ) ||
    new Set(extensions).size !== extensions.length
  ) {
    throw new Error(
      `Language adapter "${id}" needs unique, lowercase file extensions such as ".foo".`,
    );
  }
  if (typeof format !== "function") {
    throw new Error(`Language adapter "${id}" needs a format function.`);
  }
  if (typeof verify !== "function") {
    throw new Error(
      `Language adapter "${id}" needs a semantic verification function.`,
    );
  }
  if (typeof description !== "string") {
    throw new Error(`Language adapter "${id}" description must be a string.`);
  }

  const adapter = Object.freeze({
    id,
    extensions: Object.freeze([...extensions]),
    description: description.trim(),
    format,
    verify,
  });
  VALID_ADAPTERS.add(adapter);
  return adapter;
}

export function createLanguageAdapterRegistry(adapters = []) {
  if (!Array.isArray(adapters)) {
    throw new TypeError("Language adapters must be provided as an array.");
  }
  const ids = new Set();
  const extensions = new Map();
  for (const adapter of adapters) {
    validateAdapter(adapter);
    if (ids.has(adapter.id)) {
      throw new Error(
        `Language adapter "${adapter.id}" is registered more than once.`,
      );
    }
    ids.add(adapter.id);
    for (const extension of adapter.extensions) {
      const existing = extensions.get(extension);
      if (existing) {
        throw new Error(
          `File extension "${extension}" is claimed by both "${existing}" and "${adapter.id}".`,
        );
      }
      extensions.set(extension, adapter.id);
    }
  }
  const byId = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  return Object.freeze({
    adapters: Object.freeze([...adapters]),
    resolve(filePath) {
      if (typeof filePath !== "string" || filePath.length === 0) {
        throw new TypeError(
          "A file path is required to resolve a language adapter.",
        );
      }
      const adapterId = extensions.get(path.extname(filePath).toLowerCase());
      return adapterId ? byId.get(adapterId) : undefined;
    },
  });
}

export async function formatWithLanguageAdapter(adapter, source, filePath) {
  validateAdapter(adapter);
  if (typeof source !== "string") {
    throw new TypeError("Language adapter source must be a string.");
  }
  if (typeof filePath !== "string" || filePath.length === 0) {
    throw new TypeError("A project-relative file path is required.");
  }
  const extension = path.extname(filePath).toLowerCase();
  if (!adapter.extensions.includes(extension)) {
    throw new Error(
      `Language adapter "${adapter.id}" does not support "${extension || "(no extension)"}".`,
    );
  }

  const context = Object.freeze({ filePath });
  const formatted = await adapter.format(source, context);
  if (typeof formatted !== "string") {
    throw new Error(
      `Language adapter "${adapter.id}" must return formatted text.`,
    );
  }
  let equivalent;
  try {
    equivalent = await adapter.verify(source, formatted, context);
  } catch (error) {
    throw new Error(
      `Language adapter "${adapter.id}" verification failed: ${error.message}`,
      { cause: error },
    );
  }
  if (equivalent !== true) {
    throw new Error(
      `Language adapter "${adapter.id}" output was rejected because semantic equivalence was not confirmed.`,
    );
  }
  return formatted;
}
