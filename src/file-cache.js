import fs from "node:fs/promises";
import path from "node:path";

const MAX_ENTRIES = 128;
const MAX_ENTRY_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const cache = new Map();
let cachedBytes = 0;

function signature(stats) {
  return [stats.dev, stats.ino, stats.size, stats.mtimeMs, stats.ctimeMs].join(
    ":",
  );
}

function remember(filePath, source, stats) {
  const size = Buffer.byteLength(source, "utf8");
  const previous = cache.get(filePath);
  if (previous) {
    cachedBytes -= previous.bytes;
    cache.delete(filePath);
  }
  if (size > MAX_ENTRY_BYTES || size > MAX_TOTAL_BYTES) return;
  while (cache.size >= MAX_ENTRIES || cachedBytes + size > MAX_TOTAL_BYTES) {
    const oldestPath = cache.keys().next().value;
    const oldest = cache.get(oldestPath);
    cache.delete(oldestPath);
    cachedBytes -= oldest.bytes;
  }
  cache.set(filePath, { source, signature: signature(stats), bytes: size });
  cachedBytes += size;
}

/** Read a regular text file with a bounded metadata-validated process cache. */
export async function readCachedText(filePath) {
  if (typeof filePath !== "string" || filePath.length === 0) {
    throw new TypeError("A file path is required to read cached text.");
  }
  const absolutePath = path.resolve(filePath);
  const stats = await fs.lstat(absolutePath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(
      "Cached project reads require a regular, non-symbolic file.",
    );
  }
  const currentSignature = signature(stats);
  const entry = cache.get(absolutePath);
  if (entry?.signature === currentSignature) {
    cache.delete(absolutePath);
    cache.set(absolutePath, entry);
    return entry.source;
  }

  const source = await fs.readFile(absolutePath, "utf8");
  const afterRead = await fs.lstat(absolutePath);
  if (
    !afterRead.isSymbolicLink() &&
    afterRead.isFile() &&
    signature(afterRead) === currentSignature
  ) {
    remember(absolutePath, source, afterRead);
  } else {
    const stale = cache.get(absolutePath);
    if (stale) {
      cachedBytes -= stale.bytes;
      cache.delete(absolutePath);
    }
  }
  return source;
}
