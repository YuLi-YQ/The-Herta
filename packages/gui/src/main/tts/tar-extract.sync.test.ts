import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { packTar } from "../../../scripts/tar-pack.mjs";

/**
 * Durability of the extracted bundle (ADR 0061 §4.4): every file the
 * extractor writes is fsynced before it is closed, so the rename that
 * installs the bundle cannot outrun the data behind it. Its own file, like
 * voice-model.disk.test.ts: the hoisted mock of `node:fs/promises` must not
 * reach the sibling suite, whose extractions write real files.
 */
const seen = vi.hoisted(() => ({ order: [] as string[] }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    default: real,
    open: async (...args: Parameters<typeof real.open>) => {
      const fh = await real.open(...args);
      const path = String(args[0]);
      return new Proxy(fh, {
        get(target, prop, receiver) {
          if (prop === "sync") {
            return async () => {
              seen.order.push(`sync:${path}`);
              return target.sync();
            };
          }
          if (prop === "close") {
            return async () => {
              seen.order.push(`close:${path}`);
              return target.close();
            };
          }
          const v = Reflect.get(target, prop, receiver);
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
    },
  };
});

const { extractTar } = await import("./tar-extract.js");

const dirs: string[] = [];
afterEach(() => {
  seen.order.length = 0;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function* whole(buf: Buffer): AsyncGenerator<Uint8Array> {
  yield buf;
}

describe("extractTar — durability (ADR 0061 §4.4)", () => {
  it("fsyncs every extracted file before closing it", async () => {
    const dest = mkdtempSync(join(tmpdir(), "herta-tar-sync-"));
    dirs.push(dest);
    const entries = [
      { path: "a.bin", data: Buffer.alloc(3000, 1) },
      { path: "dir/b.txt", data: Buffer.from("b") },
    ];
    await extractTar(whole(packTar(entries)), dest, { maxBytes: 1 << 20 });
    for (const e of entries) {
      const tail = join(...e.path.split("/"));
      const sync = seen.order.findIndex(
        (s) => s.startsWith("sync:") && s.endsWith(tail),
      );
      const close = seen.order.findIndex(
        (s) => s.startsWith("close:") && s.endsWith(tail),
      );
      expect(sync, `${e.path} synced`).toBeGreaterThanOrEqual(0);
      expect(sync, `${e.path} synced before close`).toBeLessThan(close);
    }
  });
});
