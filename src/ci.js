import fs from "node:fs/promises";
import path from "node:path";
import { withProjectWriteLock } from "./cleaner.js";

const CI_CONFIGS = Object.freeze({
  gitlab: {
    filePath: ".gitlab-ci.yml",
    content: [
      "image: node:22",
      "stages:",
      "  - test",
      "cleanser-test:",
      "  stage: test",
      "  script:",
      "    - npm ci",
      "    - npm test",
      "    - npm run check",
      "",
    ].join("\n"),
  },
  bitbucket: {
    filePath: "bitbucket-pipelines.yml",
    content: [
      "image: node:22",
      "pipelines:",
      "  default:",
      "    - step:",
      "        name: Test and check formatting",
      "        caches:",
      "          - node",
      "        script:",
      "          - npm ci",
      "          - npm test",
      "          - npm run check",
      "",
    ].join("\n"),
  },
});

async function createCiConfigOperation({
  root = process.cwd(),
  provider,
} = {}) {
  if (!Object.hasOwn(CI_CONFIGS, provider)) {
    throw new Error('CI provider must be "gitlab" or "bitbucket".');
  }
  const config = CI_CONFIGS[provider];
  const filePath = path.join(path.resolve(root), config.filePath);
  let handle;
  try {
    handle = await fs.open(filePath, "wx", 0o644);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(
        `${config.filePath} already exists; Cleanser left it unchanged.`,
      );
    }
    throw error;
  }
  try {
    await handle.writeFile(config.content, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.rm(filePath, { force: true }).catch(() => {});
    throw error;
  }
  await handle.close();
  return { provider, filePath: config.filePath };
}

export async function createCiConfig(options = {}) {
  const { root = process.cwd(), provider } = options;
  if (!Object.hasOwn(CI_CONFIGS, provider)) {
    throw new Error('CI provider must be "gitlab" or "bitbucket".');
  }
  return withProjectWriteLock(root, () => createCiConfigOperation(options));
}
