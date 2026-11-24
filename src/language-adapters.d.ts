/** Immutable context provided to a custom language adapter. */
export interface LanguageAdapterContext {
  /** Project-relative file path. */
  readonly filePath: string;
}

/** A custom formatter and mandatory semantic verification function. */
export interface LanguageAdapterDefinition {
  /** Stable lowercase adapter identifier. */
  id: string;
  /** Unique lowercase file extensions, including the leading dot. */
  extensions: readonly string[];
  /** Optional short explanation of the adapter. */
  description?: string;
  /** Return formatted source without writing project files. */
  format(
    source: string,
    context: LanguageAdapterContext,
  ): string | Promise<string>;
  /** Return true only when formatting preserved the program's meaning. */
  verify(
    original: string,
    formatted: string,
    context: LanguageAdapterContext,
  ): boolean | Promise<boolean>;
}

/** Validated immutable language adapter. */
export interface LanguageAdapter extends Required<LanguageAdapterDefinition> {
  readonly extensions: readonly string[];
}

/** Create a registry that rejects duplicate IDs and file extensions. */
export function createLanguageAdapterRegistry(
  adapters?: readonly LanguageAdapter[],
): {
  readonly adapters: readonly LanguageAdapter[];
  resolve(filePath: string): LanguageAdapter | undefined;
};

/** Validate and freeze a custom language adapter. */
export function defineLanguageAdapter(
  adapter: LanguageAdapterDefinition,
): LanguageAdapter;

/** Format source and refuse output unless the adapter confirms equivalence. */
export function formatWithLanguageAdapter(
  adapter: LanguageAdapter,
  source: string,
  filePath: string,
): Promise<string>;
