import {
  definePlugin,
  defineRule,
  getMissingPluginDependencies,
  runPlugin,
} from "cleanser/plugin-api";
import {
  createLanguageAdapterRegistry,
  defineLanguageAdapter,
  formatWithLanguageAdapter,
} from "cleanser/language-adapters";

const plugin = definePlugin({
  name: "typed-example",
  rules: [
    defineRule({
      id: "no-markers",
      description: "Find an example marker.",
      check(source, context) {
        const start = source.indexOf("marker");
        return start < 0
          ? []
          : [
              {
                start,
                end: start + "marker".length,
                message: `Marker in ${context.filePath}.`,
              },
            ];
      },
    }),
  ],
});

const findings = runPlugin(plugin, {
  source: "const marker = true;",
  filePath: "src/example.ts",
});
const missingDependencies = getMissingPluginDependencies(plugin, {
  devDependencies: { prettier: "^3.0.0" },
});
void missingDependencies;

const adapter = defineLanguageAdapter({
  id: "example",
  extensions: [".example"],
  format: async (source, context) => {
    void context.filePath;
    return source;
  },
  verify: (original, formatted) => original === formatted,
});
const adapters = createLanguageAdapterRegistry([adapter]);
const selectedAdapter = adapters.resolve("source.example");
if (selectedAdapter) {
  await formatWithLanguageAdapter(selectedAdapter, "code", "source.example");
}
const line: number | undefined = findings[0]?.line;
void line;
