import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readBundleManifest, verifyBundle } from "./bundle-verify.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "herta-verify-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function sha(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** A bundle whose manifest describes its own files. */
function makeBundle(
  root: string,
  release = "herta-best-e72",
  files: Record<string, Buffer> = {
    "model.onnx": Buffer.alloc(300, 1),
    "frontend/tokens.txt": Buffer.from("a 0\n"),
  },
): void {
  for (const [rel, data] of Object.entries(files)) {
    const p = join(root, ...rel.split("/"));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, data);
  }
  writeFileSync(
    join(root, "manifest.json"),
    JSON.stringify({
      schema: 1,
      release,
      model: "model.onnx",
      runtime_voice: "voices.bin",
      files: Object.entries(files).map(([path, data]) => ({
        path,
        bytes: data.length,
        sha256: sha(data),
      })),
    }),
  );
}

describe("verifyBundle", () => {
  it("ok for a bundle whose files match its manifest", async () => {
    const root = tmp();
    makeBundle(root);
    expect(await verifyBundle(root, "herta-best-e72")).toEqual({
      ok: true,
      files: 2,
      bytes: 304,
    });
  });

  it("names a missing, resized or altered file", async () => {
    const root = tmp();
    makeBundle(root);
    writeFileSync(join(root, "frontend", "tokens.txt"), "a 0\nb 1\n");
    expect(await verifyBundle(root, "herta-best-e72")).toEqual({
      ok: false,
      reason: "frontend/tokens.txt: size",
    });
    writeFileSync(join(root, "frontend", "tokens.txt"), "b 1\n");
    expect(await verifyBundle(root, "herta-best-e72")).toEqual({
      ok: false,
      reason: "frontend/tokens.txt: hash",
    });
    rmSync(join(root, "model.onnx"));
    expect(await verifyBundle(root, "herta-best-e72")).toEqual({
      ok: false,
      reason: "missing model.onnx",
    });
  });

  it("refuses a manifest for another release, and no manifest at all", async () => {
    const root = tmp();
    makeBundle(root, "herta-best-e30");
    const r = await verifyBundle(root, "herta-best-e72");
    expect(r.ok).toBe(false);
    expect(await verifyBundle(tmp(), "herta-best-e72")).toEqual({
      ok: false,
      reason: "no readable manifest",
    });
    expect(await readBundleManifest(tmp())).toBeNull();
  });

  it("refuses a manifest path that escapes the bundle", async () => {
    const root = tmp();
    makeBundle(root);
    writeFileSync(
      join(root, "manifest.json"),
      JSON.stringify({
        schema: 1,
        release: "herta-best-e72",
        model: "m",
        runtime_voice: "v",
        files: [{ path: "../x", bytes: 1, sha256: "0" }],
      }),
    );
    expect(await verifyBundle(root, "herta-best-e72")).toEqual({
      ok: false,
      reason: "bad manifest path ../x",
    });
  });
});
