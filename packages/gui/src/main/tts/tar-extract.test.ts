import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { packTar, packTarGz } from "../../../scripts/tar-pack.mjs";
import { extractTar, safeEntryPath } from "./tar-extract.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "herta-tar-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Feed a buffer in awkward chunk sizes so boundaries fall mid-header and
 *  mid-file. */
async function* chunked(buf: Buffer, size: number): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < buf.length; i += size) {
    yield buf.subarray(i, Math.min(buf.length, i + size));
  }
}

function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const r = rel.length > 0 ? `${rel}/${name}` : name;
      if (statSync(p).isDirectory()) walk(p, r);
      else out.push(r);
    }
  };
  walk(root, "");
  return out;
}

const ENTRIES = [
  { path: "manifest.json", data: Buffer.from('{"release":"x"}') },
  { path: "model.onnx", data: Buffer.alloc(1500, 7) },
  { path: "frontend/tokens.txt", data: Buffer.from("a 0\nb 1\n") },
  { path: "frontend/espeak-ng-data/lang/zle/ru", data: Buffer.from("") },
  {
    path: `${"d".repeat(120)}/${"f".repeat(60)}.bin`,
    data: Buffer.from([1, 2, 3]),
  },
];

describe("extractTar (round-trips the packer's output)", () => {
  it("restores every file byte for byte, across odd chunk boundaries", {
    timeout: 20_000,
  }, async () => {
    const tar = packTar(ENTRIES);
    // Sizes that put a boundary inside a header, inside a file, exactly on
    // a block, and nowhere (one chunk). Not 1: thousands of awaits per run
    // is load-sensitive under the full suite and proves nothing more.
    for (const size of [3, 7, 511, 513, 4096, tar.length]) {
      const dest = tmp();
      const res = await extractTar(chunked(tar, size), dest, {
        maxBytes: 1 << 20,
      });
      expect(res.files, `chunk ${size}`).toBe(ENTRIES.length);
      expect(res.bytes).toBe(ENTRIES.reduce((n, e) => n + e.data.length, 0));
      expect(listFiles(dest)).toEqual(ENTRIES.map((e) => e.path).sort());
      for (const e of ENTRIES) {
        expect(readFileSync(join(dest, ...e.path.split("/")))).toEqual(e.data);
      }
    }
  });

  it("reads the gzip form through a real gunzip stream", async () => {
    const gz = packTarGz(ENTRIES);
    const dest = tmp();
    const source = Readable.from(chunked(gz, 1000)).pipe(createGunzip());
    const res = await extractTar(source, dest, { maxBytes: 1 << 20 });
    expect(res.files).toBe(ENTRIES.length);
    expect(readFileSync(join(dest, "model.onnx"))).toEqual(ENTRIES[1]?.data);
  });

  it("refuses an archive whose declared sizes exceed the cap", async () => {
    const tar = packTar(ENTRIES);
    await expect(
      extractTar(chunked(tar, 4096), tmp(), { maxBytes: 100 }),
    ).rejects.toThrow(/larger than expected/);
  });

  it("refuses a truncated archive", async () => {
    const tar = packTar(ENTRIES);
    await expect(
      extractTar(chunked(tar.subarray(0, 700), 64), tmp(), {
        maxBytes: 1 << 20,
      }),
    ).rejects.toThrow(/truncated/);
  });

  it("refuses a non-ustar or corrupted header", async () => {
    const tar = packTar(ENTRIES);
    const bad = Buffer.from(tar);
    bad[0] = bad[0] === 0x41 ? 0x42 : 0x41; // flip a name byte → checksum breaks
    await expect(
      extractTar(chunked(bad, 4096), tmp(), { maxBytes: 1 << 20 }),
    ).rejects.toThrow(/checksum/);
  });

  it("refuses entry types other than files and directories", async () => {
    const tar = Buffer.from(packTar([ENTRIES[0] as (typeof ENTRIES)[0]]));
    tar[156] = 0x32; // '2' = symlink
    // Recompute the checksum so only the type is wrong.
    let sum = 0;
    for (let i = 0; i < 512; i += 1)
      sum += i >= 148 && i < 156 ? 0x20 : (tar[i] ?? 0);
    tar.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    await expect(
      extractTar(chunked(tar, 4096), tmp(), { maxBytes: 1 << 20 }),
    ).rejects.toThrow(/unsupported tar entry type/);
  });
});

describe("safeEntryPath", () => {
  it("accepts nested relative paths", () => {
    const dest = tmp();
    expect(safeEntryPath(dest, "frontend/tokens.txt")).toBe(
      join(dest, "frontend", "tokens.txt"),
    );
  });

  it("refuses traversal, absolute, backslash, empty and dot segments", () => {
    const dest = tmp();
    for (const bad of [
      "../x",
      "a/../../x",
      "/etc/passwd",
      "a\\b",
      "",
      "./a",
      "a//b",
      "a\0b",
    ]) {
      expect(() => safeEntryPath(dest, bad), bad).toThrow();
    }
  });
});

describe("extractTar — the source is released (ADR 0061 §4.4)", () => {
  /** A source that never ends on its own: only `return()` runs its finally,
   *  so the flag proves the extractor let go rather than the stream ending. */
  async function* endless(
    buf: Buffer,
    flag: { closed: boolean },
  ): AsyncGenerator<Uint8Array> {
    try {
      yield* chunked(buf, 512);
      for (;;) yield new Uint8Array(512);
    } finally {
      flag.closed = true;
    }
  }

  it("closes its source iterator at the archive's end and on a refusal", async () => {
    const tar = packTar(ENTRIES);
    const ok = { closed: false };
    await extractTar(endless(tar, ok), tmp(), { maxBytes: 1 << 20 });
    expect(ok.closed).toBe(true);
    const bad = { closed: false };
    await expect(
      extractTar(endless(tar, bad), tmp(), { maxBytes: 100 }),
    ).rejects.toThrow(/larger than expected/);
    expect(bad.closed).toBe(true);
  });
});
