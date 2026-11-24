import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isIncludedPath,
  isSafeProjectFile,
  formatSource,
  compareAstEquivalence,
} from "./cleaner.js";
import { loadConfig } from "./config.js";

const HEADER_END = Buffer.from("\r\n\r\n");
const MAX_HEADER_BYTES = 8 * 1024;
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

function lineEndPosition(source) {
  const lines = source.split(/\r\n|\r|\n/u);
  return {
    line: lines.length - 1,
    character: lines.at(-1).length,
  };
}

function offsetAt(source, position) {
  if (
    !Number.isSafeInteger(position?.line) ||
    !Number.isSafeInteger(position?.character) ||
    position.line < 0 ||
    position.character < 0
  ) {
    return undefined;
  }
  let line = 0;
  let start = 0;
  while (line < position.line) {
    const match = /\r\n|\r|\n/u.exec(source.slice(start));
    if (!match) return undefined;
    start += match.index + match[0].length;
    line++;
  }
  let end = start;
  while (end < source.length && source[end] !== "\r" && source[end] !== "\n") {
    end++;
  }
  return Math.min(start + position.character, end);
}

function positionAt(source, offset) {
  const prefix = source.slice(0, offset);
  const lines = prefix.split(/\r\n|\r|\n/u);
  return { line: lines.length - 1, character: lines.at(-1).length };
}

function minimalTextEdit(source, formatted) {
  let start = 0;
  const limit = Math.min(source.length, formatted.length);
  while (start < limit && source[start] === formatted[start]) start++;
  while (
    start > 0 &&
    /[\uD800-\uDBFF]/u.test(source[start - 1]) &&
    /[\uDC00-\uDFFF]/u.test(source[start] ?? "")
  ) {
    start--;
  }
  let suffix = 0;
  while (
    suffix < source.length - start &&
    suffix < formatted.length - start &&
    source[source.length - suffix - 1] ===
      formatted[formatted.length - suffix - 1]
  ) {
    suffix++;
  }
  return {
    range: {
      start: positionAt(source, start),
      end: positionAt(source, source.length - suffix),
    },
    newText: formatted.slice(start, formatted.length - suffix),
  };
}

function createMessageParser(onMessage, onError) {
  let buffer = Buffer.alloc(0);
  let failed = false;

  const append = (chunk, start, end) => {
    if (end <= start) return;
    const part = chunk.subarray(start, end);
    buffer = buffer.length === 0 ? part : Buffer.concat([buffer, part]);
  };

  const fail = (message) => {
    failed = true;
    buffer = Buffer.alloc(0);
    onError(message);
  };

  return (chunk) => {
    if (failed) return;
    let offset = 0;

    while (true) {
      let headerEnd = buffer.indexOf(HEADER_END);
      if (headerEnd < 0) {
        if (offset >= chunk.length) return;
        const capacity = MAX_HEADER_BYTES + 1 - buffer.length;
        if (capacity <= 0) {
          fail("LSP message header exceeds the 8 KB limit.");
          return;
        }
        const nextOffset = Math.min(chunk.length, offset + capacity);
        append(chunk, offset, nextOffset);
        offset = nextOffset;
        headerEnd = buffer.indexOf(HEADER_END);
        if (headerEnd < 0) {
          if (buffer.length > MAX_HEADER_BYTES) {
            fail("LSP message header exceeds the 8 KB limit.");
          }
          return;
        }
      }

      if (headerEnd > MAX_HEADER_BYTES) {
        fail("LSP message header exceeds the 8 KB limit.");
        return;
      }

      const header = buffer.subarray(0, headerEnd).toString("ascii");
      const lengthMatch = header.match(/(?:^|\r\n)content-length:\s*(\d+)/i);
      const messageStart = headerEnd + HEADER_END.length;
      if (!lengthMatch) {
        buffer = buffer.subarray(messageStart);
        onError("LSP message is missing Content-Length.");
        continue;
      }

      const contentLength = Number(lengthMatch[1]);
      if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
        buffer = buffer.subarray(messageStart);
        onError("LSP Content-Length must be a non-negative safe integer.");
        continue;
      }
      if (contentLength > MAX_MESSAGE_BYTES) {
        fail("LSP message exceeds the 16 MB size limit.");
        return;
      }

      const messageEnd = messageStart + contentLength;
      if (buffer.length < messageEnd) {
        if (offset >= chunk.length) return;
        const nextOffset = Math.min(
          chunk.length,
          offset + messageEnd - buffer.length,
        );
        append(chunk, offset, nextOffset);
        offset = nextOffset;
        if (buffer.length < messageEnd) return;
      }

      const body = buffer.subarray(messageStart, messageEnd).toString("utf8");
      buffer = buffer.subarray(messageEnd);
      try {
        onMessage(JSON.parse(body));
      } catch (error) {
        onError("Could not parse LSP message: " + error.message);
      }
    }
  };
}

export function startLanguageServer({
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  let root;
  let config;
  let shutdownRequested = false;
  let messageQueue = Promise.resolve();
  const documents = new Map();

  const send = (message) => {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    stdout.write(
      Buffer.concat([
        Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"),
        body,
      ]),
    );
  };
  const logError = (message) => {
    stderr.write(`Cleanser LSP: ${message}\n`);
  };
  const respondError = (id, error) => {
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: error.message ?? String(error) },
    });
  };

  async function formatDocument(params, requestedRange) {
    if (!config || !root) throw new Error("Initialize the Cleanser LSP first.");
    const uri = params?.textDocument?.uri;
    if (typeof uri !== "string" || !uri.startsWith("file:")) return [];
    const filePath = path.resolve(fileURLToPath(uri));
    const relativePath = path.relative(root, filePath);
    if (
      relativePath === ".." ||
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath)
    ) {
      return [];
    }
    const normalized = relativePath.split(path.sep).join("/");
    if (
      !isIncludedPath(normalized, config) ||
      !(await isSafeProjectFile(root, filePath))
    ) {
      return [];
    }
    const source = documents.has(uri)
      ? documents.get(uri)
      : await fs.readFile(filePath, "utf8");
    let range;
    if (requestedRange !== undefined) {
      const start = offsetAt(source, requestedRange.start);
      const end = offsetAt(source, requestedRange.end);
      if (start === undefined || end === undefined || end < start) {
        throw new Error("The requested formatting range is invalid.");
      }
      range = { start, end };
    }
    const formatted = await formatSource(source, filePath, config, range);
    if (formatted === source) return [];
    const verification = await compareAstEquivalence(
      source,
      formatted,
      filePath,
      config,
    );
    if (!verification.equivalent) {
      logError(
        `Skipped ${normalized}: source-equivalence check failed (${verification.difference}).`,
      );
      return [];
    }
    return range
      ? [minimalTextEdit(source, formatted)]
      : [
          {
            range: {
              start: { line: 0, character: 0 },
              end: lineEndPosition(source),
            },
            newText: formatted,
          },
        ];
  }

  async function handle(message) {
    const hasId = Object.hasOwn(message, "id");
    try {
      if (message.method === "initialize") {
        const rootUri = message.params?.rootUri;
        const rootPath =
          typeof rootUri === "string" && rootUri.startsWith("file:")
            ? fileURLToPath(rootUri)
            : (message.params?.rootPath ?? process.cwd());
        root = path.resolve(rootPath);
        config = await loadConfig(root);
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            capabilities: {
              textDocumentSync: { openClose: true, change: 1 },
              documentFormattingProvider: true,
              documentRangeFormattingProvider: true,
            },
            serverInfo: { name: "Cleanser", version: "0.1.0" },
          },
        });
        return;
      }
      if (message.method === "shutdown") {
        shutdownRequested = true;
        if (hasId) send({ jsonrpc: "2.0", id: message.id, result: null });
        return;
      }
      if (message.method === "exit") {
        process.exitCode = shutdownRequested ? 0 : 1;
        stdin.pause?.();
        return;
      }
      if (message.method === "textDocument/didOpen") {
        const document = message.params?.textDocument;
        if (
          typeof document?.uri === "string" &&
          typeof document.text === "string"
        ) {
          documents.set(document.uri, document.text);
        }
        return;
      }
      if (message.method === "textDocument/didChange") {
        const document = message.params?.textDocument;
        const lastChange = message.params?.contentChanges?.at(-1);
        if (
          typeof document?.uri === "string" &&
          typeof lastChange?.text === "string"
        ) {
          documents.set(document.uri, lastChange.text);
        }
        return;
      }
      if (message.method === "textDocument/didClose") {
        const uri = message.params?.textDocument?.uri;
        if (typeof uri === "string") documents.delete(uri);
        return;
      }
      if (message.method === "textDocument/formatting") {
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: await formatDocument(message.params),
        });
        return;
      }
      if (message.method === "textDocument/rangeFormatting") {
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: await formatDocument(message.params, message.params?.range),
        });
        return;
      }
      if (hasId) {
        send({
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32601,
            message: `Method not found: ${message.method}`,
          },
        });
      }
    } catch (error) {
      if (hasId) respondError(message.id, error);
      else logError(error.message ?? String(error));
    }
  }

  const parseChunk = createMessageParser((message) => {
    messageQueue = messageQueue
      .then(() => handle(message))
      .catch((error) => logError(error.message ?? String(error)));
  }, logError);
  stdin.on("data", parseChunk);
  stdin.on("error", (error) => logError(error.message));
  return { stop: () => stdin.off("data", parseChunk) };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  startLanguageServer();
}
