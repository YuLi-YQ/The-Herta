/**
 * A deterministic ustar writer — the producer half of the voice-model archive
 * (ADR 0061). Regular files only, sorted by path, mtime 0, uid/gid 0, mode
 * 0644: the same bundle packs to the same bytes on any machine, so the
 * SHA-256 pinned in `src/main/tts/tts-release.ts` is reproducible.
 *
 * The consumer is `src/main/tts/tar-extract.ts`; the two share nothing but
 * the format, and its test round-trips through THIS packer so the pair
 * cannot drift apart.
 */
import { gzipSync } from "node:zlib";

const BLOCK = 512;

function octal(n, width) {
  const s = n.toString(8);
  if (s.length > width - 1)
    throw new Error(`value ${n} does not fit ${width} octal digits`);
  return `${s.padStart(width - 1, "0")}\0`;
}

/** Split a POSIX path into ustar `prefix` (≤155) + `name` (≤100) at a `/`. */
function splitName(path) {
  if (path.length <= 100) return { prefix: "", name: path };
  // A `/` at index i gives prefix = i chars (≤ 155) and name = the rest
  // (≤ 100): scan the window where both hold, longest prefix first.
  const hi = Math.min(155, path.length - 2);
  const lo = Math.max(1, path.length - 101);
  for (let i = hi; i >= lo; i -= 1) {
    if (path[i] === "/")
      return { prefix: path.slice(0, i), name: path.slice(i + 1) };
  }
  throw new Error(`path too long for ustar: ${path}`);
}

function header(path, size) {
  const h = Buffer.alloc(BLOCK, 0);
  const { prefix, name } = splitName(path);
  h.write(name, 0, 100, "utf8");
  h.write(octal(0o644, 8), 100, 8, "ascii");
  h.write(octal(0, 8), 108, 8, "ascii");
  h.write(octal(0, 8), 116, 8, "ascii");
  h.write(octal(size, 12), 124, 12, "ascii");
  h.write(octal(0, 12), 136, 12, "ascii");
  h.write("        ", 148, 8, "ascii"); // checksum placeholder: spaces
  h.write("0", 156, 1, "ascii"); // regular file
  h.write("ustar\0", 257, 6, "ascii");
  h.write("00", 263, 2, "ascii");
  h.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return h;
}

/**
 * @param {ReadonlyArray<{ path: string; data: Uint8Array }>} entries
 *   POSIX-relative paths (`frontend/tokens.txt`), already sorted by the
 *   caller; a path with `..`, a leading `/` or a backslash is refused.
 * @returns {Buffer} the tar stream (headers + padded data + two zero blocks)
 */
export function packTar(entries) {
  const parts = [];
  for (const { path, data } of entries) {
    if (
      path.length === 0 ||
      path.startsWith("/") ||
      path.includes("\\") ||
      path.split("/").some((seg) => seg === "" || seg === "." || seg === "..")
    ) {
      throw new Error(`refusing to pack path: ${JSON.stringify(path)}`);
    }
    parts.push(header(path, data.length), Buffer.from(data));
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (pad > 0) parts.push(Buffer.alloc(pad, 0));
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(parts);
}

/** `packTar` + gzip (level 9, header mtime 0 — Node writes none). */
export function packTarGz(entries) {
  return gzipSync(packTar(entries), { level: 9 });
}
