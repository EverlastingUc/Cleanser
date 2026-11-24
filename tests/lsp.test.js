import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const configTemplatePath = fileURLToPath(
  new URL("../templates/cleanser.clns", import.meta.url),
);

function encodeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"),
    body,
  ]);
}

test("LSP initializes and returns AST-verified formatting edits", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cleanser-lsp-"));
  const source = "const first = 1;\nconst value=2\nconst last = 3;\n";
  const filePath = path.join(root, "sample.js");
  await fs.writeFile(
    path.join(root, ".cleanser.clns"),
    await fs.readFile(configTemplatePath, "utf8"),
  );
  await fs.writeFile(filePath, source);

  const child = spawn(process.execPath, [cliPath, "lsp"], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let buffer = Buffer.alloc(0);
  let stderr = "";
  const messages = [];
  const waiters = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = buffer.subarray(0, headerEnd).toString("ascii");
      const length = Number(header.match(/Content-Length:\s*(\d+)/i)?.[1]);
      if (!Number.isSafeInteger(length) || length < 0) return;
      const messageEnd = headerEnd + 4 + length;
      if (buffer.length < messageEnd) return;
      const message = JSON.parse(
        buffer.subarray(headerEnd + 4, messageEnd).toString("utf8"),
      );
      buffer = buffer.subarray(messageEnd);
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(message);
      else messages.push(message);
    }
  });
  child.once("error", (error) => {
    for (const waiter of waiters.splice(0)) waiter.reject(error);
  });
  child.once("exit", (code) => {
    for (const waiter of waiters.splice(0)) {
      waiter.reject(new Error(`LSP exited ${code}: ${stderr}`));
    }
  });
  const readMessage = () =>
    messages.length > 0
      ? Promise.resolve(messages.shift())
      : new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  const writeMessage = (message) => child.stdin.write(encodeMessage(message));

  try {
    writeMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { rootUri: pathToFileURL(root).href },
    });
    const initialized = await readMessage();
    assert.equal(initialized.id, 1);
    assert.equal(
      initialized.result.capabilities.documentFormattingProvider,
      true,
    );
    assert.equal(
      initialized.result.capabilities.documentRangeFormattingProvider,
      true,
    );

    const uri = pathToFileURL(filePath).href;
    writeMessage({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: {
        textDocument: {
          uri,
          languageId: "javascript",
          version: 1,
          text: source,
        },
      },
    });
    writeMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "textDocument/formatting",
      params: {
        textDocument: { uri },
        options: { tabSize: 2, insertSpaces: true },
      },
    });
    const formatted = await readMessage();
    assert.equal(formatted.id, 2);
    assert.match(formatted.result[0].newText, /const value = 2;/);
    assert.equal(await fs.readFile(filePath, "utf8"), source);

    writeMessage({
      jsonrpc: "2.0",
      id: 4,
      method: "textDocument/rangeFormatting",
      params: {
        textDocument: { uri },
        range: {
          start: { line: 1, character: 0 },
          end: { line: 1, character: 13 },
        },
        options: { tabSize: 2, insertSpaces: true },
      },
    });
    const rangeFormatted = await readMessage();
    assert.equal(rangeFormatted.id, 4);
    assert.equal(rangeFormatted.result.length, 1);
    assert.match(rangeFormatted.result[0].newText, / = 2;/);
    assert.equal(rangeFormatted.result[0].range.start.line, 1);
    assert.equal(await fs.readFile(filePath, "utf8"), source);

    writeMessage({ jsonrpc: "2.0", id: 3, method: "shutdown" });
    assert.equal((await readMessage()).result, null);
    child.stdin.end(encodeMessage({ jsonrpc: "2.0", method: "exit" }));
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error("LSP server did not exit after shutdown."));
      }, 5000);
      child.once("close", (code) => {
        clearTimeout(timeout);
        if (code === 0) resolve();
        else reject(new Error(`LSP exited ${code}: ${stderr}`));
      });
    });
  } finally {
    if (child.exitCode === null) child.kill();
    await fs.rm(root, { recursive: true, force: true });
  }
});


test("LSP rejects oversized frame headers and payload declarations", async () => {
  const invalidFrames = [
    {
      frame: "X".repeat(8 * 1024 + 1),
      expected: /header exceeds the 8 KB limit/,
    },
    {
      frame: `Content-Length: ${16 * 1024 * 1024 + 1}\r\n\r\n`,
      expected: /message exceeds the 16 MB size limit/,
    },
  ];

  for (const { frame, expected } of invalidFrames) {
    const child = spawn(process.execPath, [cliPath, "lsp"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    const closed = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error("LSP server did not exit after invalid input."));
      }, 5000);
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });

    child.stdin.end(Buffer.from(frame, "ascii"));
    const code = await closed;
    assert.equal(code, 0, stderr);
    assert.match(stderr, expected);
  }
});


test("LSP accepts a maximum-length header when its delimiter is split", async () => {
  const child = spawn(process.execPath, [cliPath, "lsp"], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const closed = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("LSP server did not exit after a valid maximum header."));
    }, 5000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });

  const body = Buffer.from(
    JSON.stringify({ jsonrpc: "2.0", method: "initialized" }),
    "utf8",
  );
  const prefix = "Content-Length: " + body.length + "\r\nX-Pad: ";
  const headerText = prefix + "x".repeat(8 * 1024 - Buffer.byteLength(prefix));
  const frame = Buffer.concat([
    Buffer.from(headerText + "\r\n\r\n", "ascii"),
    body,
  ]);
  const split = Buffer.byteLength(headerText) + 2;
  child.stdin.write(frame.subarray(0, split));
  await new Promise((resolve) => setTimeout(resolve, 20));
  child.stdin.end(frame.subarray(split));

  const code = await closed;
  assert.equal(code, 0, stderr);
  assert.doesNotMatch(stderr, /header exceeds the 8 KB limit/);
  assert.doesNotMatch(stderr, /Could not parse LSP message/);
});
