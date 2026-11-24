# Cleanser

**Deterministic formatting and static analysis, with safety-first project cleanup.**

Cleanser is a Node.js tool for formatting supported project files and inspecting code without intentionally changing program logic. Its safe-mode configuration preserves identifiers, comments, strings, public APIs, and program behavior. Write operations create backups and include safeguards against unsafe or interrupted changes.

> **Project status:** Active development. The current version is (0.1.0); APIs and behavior may change before the first stable release.

## What it includes

- **CLI workflows** for cleaning, checking, analyzing, auditing, reporting, security checks, dependency graphs, metrics, and cleanup scoring.
- **Multi-language formatting** through Prettier and its language plugins.
- **JavaScript and TypeScript analysis** with configurable rules and presets.
- **Safety controls** including read-only checks and previews, backups, path protections, syntax-error handling, and guarded writes.
- **Git integration** for working-tree checks and dedicated formatting commits.
- **VS Code integration** for formatting, previews, safe fixes, and workspace cleanup.
- **Extensibility** through a plugin API and language adapters.
- **Reports and diagnostics** in formats including JSON, Markdown, CSV, HTML, and SARIF where supported by the relevant command.

## Requirements

- Node.js **20.11.0 or newer**
- npm
- Git is required only for Git-related workflows.

## Get started

Clone the repository and install its dependencies:

```bash
git clone https://github.com/EverlastingUc/Cleanser.git
cd Cleanser
npm install
```

Initialize Cleanser in a project:

```bash
node /path/to/Cleanser/src/cli.js init
```

Or, when running from this repository:

```bash
node ./src/cli.js --help
node ./src/cli.js init
node ./src/cli.js check
node ./src/cli.js clean
```

Run `check` first to inspect formatting without writing changes. Review the generated project configuration before running `clean`.

## Development

Run the test suite:

```bash
npm test
```

Run the type checks separately:

```bash
npm run test:types
```

Other available scripts include `npm run test:coverage`, `npm run benchmark`, and `npm run profile`.

## Safety model

Cleanser is designed to format source code, not refactor its meaning. Its default configuration keeps cleanup transformations that could alter program behavior disabled. Always review a preview and keep your project under version control before applying changes.

A clean formatting result or analysis score is **not** a guarantee that code is correct, secure, or bug-free.

## License

[MIT](LICENSE) © 2026 Everlasting
