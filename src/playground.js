import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import { formatSource } from "./cleaner.js";
import { loadConfig } from "./config.js";

const MAX_REQUEST_BYTES = 1_000_000;
const EXTENSIONS = new Map([
  ["javascript", ".js"],
  ["javascriptreact", ".jsx"],
  ["typescript", ".ts"],
  ["typescriptreact", ".tsx"],
  ["json", ".json"],
  ["css", ".css"],
  ["html", ".html"],
  ["yaml", ".yaml"],
  ["markdown", ".md"],
]);

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

function page(nonce) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Cleanser Playground</title>
  <style nonce="${nonce}">
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { margin: 0 auto; max-width: 1200px; padding: 24px; }
    header { align-items: center; display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 18px; }
    h1 { font-size: 1.4rem; margin: 0 auto 0 0; }
    button, select { font: inherit; padding: 8px 12px; }
    .panes { display: grid; gap: 16px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    label { display: grid; gap: 8px; }
    textarea { box-sizing: border-box; font: 14px/1.5 ui-monospace, monospace; min-height: 65vh; padding: 12px; resize: vertical; width: 100%; }
    #status { min-height: 1.5em; padding-top: 12px; }
    @media (max-width: 700px) { .panes { grid-template-columns: 1fr; } textarea { min-height: 38vh; } }
  </style>
</head>
<body>
  <header>
    <h1>Cleanser Playground</h1>
    <label for="language">Language</label>
    <select id="language">
      <option value="javascript">JavaScript</option>
      <option value="javascriptreact">JavaScript JSX</option>
      <option value="typescript">TypeScript</option>
      <option value="typescriptreact">TypeScript JSX</option>
      <option value="json">JSON</option>
      <option value="css">CSS</option>
      <option value="html">HTML</option>
      <option value="yaml">YAML</option>
      <option value="markdown">Markdown</option>
    </select>
    <button id="format" type="button">Format</button>
  </header>
  <main class="panes">
    <label>Source<textarea id="source" spellcheck="false">const answer=42</textarea></label>
    <label>Formatted output<textarea id="result" spellcheck="false" readonly></textarea></label>
  </main>
  <div id="status" role="status" aria-live="polite">Formatting runs locally and does not save project files.</div>
  <script nonce="${nonce}">
    const language = document.querySelector("#language");
    const source = document.querySelector("#source");
    const result = document.querySelector("#result");
    const status = document.querySelector("#status");
    document.querySelector("#format").addEventListener("click", async () => {
      status.textContent = "Formatting…";
      try {
        const response = await fetch("/format", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ language: language.value, source: source.value }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Formatting failed.");
        result.value = data.formatted;
        status.textContent = "Formatted locally. Project files were not changed.";
      } catch (error) {
        status.textContent = error.message;
      }
    });
  </script>
</body>
</html>`;
}

async function readJsonBody(request, response) {
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    sendJson(response, 413, { error: "Input is larger than the 1 MB limit." });
    request.resume();
    return undefined;
  }
  const chunks = [];
  let byteCount = 0;
  for await (const chunk of request) {
    byteCount += chunk.length;
    if (byteCount > MAX_REQUEST_BYTES) {
      sendJson(response, 413, {
        error: "Input is larger than the 1 MB limit.",
      });
      request.resume();
      return undefined;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    sendJson(response, 400, { error: "Request body must be valid JSON." });
    return undefined;
  }
}

export async function startPlaygroundServer({
  root = process.cwd(),
  host = "127.0.0.1",
  port = 0,
} = {}) {
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new Error(
      "The Cleanser playground only listens on loopback addresses.",
    );
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new TypeError("Playground port must be an integer from 0 to 65535.");
  }
  const absoluteRoot = path.resolve(root);
  const config = await loadConfig(absoluteRoot);
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/") {
      const nonce = randomUUID().replaceAll("-", "");
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'`,
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(page(nonce));
      return;
    }
    if (request.method === "POST" && request.url === "/format") {
      const mediaType = (request.headers["content-type"] ?? "")
        .split(";")[0]
        .trim()
        .toLowerCase();
      if (mediaType !== "application/json") {
        sendJson(response, 415, {
          error: "Content-Type must be application/json.",
        });
        request.resume();
        return;
      }
      const input = await readJsonBody(request, response);
      if (input === undefined) return;
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        sendJson(response, 400, {
          error: "Request body must be a JSON object.",
        });
        return;
      }
      if (
        typeof input.source !== "string" ||
        typeof input.language !== "string" ||
        !EXTENSIONS.has(input.language)
      ) {
        sendJson(response, 400, {
          error: "Choose a supported language and provide source text.",
        });
        return;
      }
      if (!config.enabled) {
        sendJson(response, 409, {
          error: "Cleanser is disabled in the project configuration.",
        });
        return;
      }
      try {
        const extension = EXTENSIONS.get(input.language);
        const formatted = await formatSource(
          input.source,
          path.join(absoluteRoot, `cleanser-playground${extension}`),
          config,
        );
        sendJson(response, 200, { formatted });
      } catch (error) {
        sendJson(response, 422, { error: error.message.split("\n")[0] });
      }
      return;
    }
    sendJson(response, 404, { error: "Not found." });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  return {
    server,
    url: `http://${host === "::1" ? "[::1]" : host}:${address.port}/`,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
