import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mkTmpWorkspace, type TmpWorkspace } from "./tmp-workspace.js";

let ws: TmpWorkspace;
afterEach(async () => {
  if (ws) await ws.cleanup();
});

describe("mkTmpWorkspace", () => {
  it("creates a directory and populates files", async () => {
    ws = await mkTmpWorkspace({
      "src/foo.ts": "export const x = 1;\n",
      "src/bar.ts": "export const y = 2;\n",
      "README.md": "# hi\n",
    });
    expect(await readFile(join(ws.root, "src/foo.ts"), "utf8")).toBe(
      "export const x = 1;\n",
    );
    expect(await readFile(join(ws.root, "README.md"), "utf8")).toBe("# hi\n");
  });

  it("supports binary content via Uint8Array", async () => {
    ws = await mkTmpWorkspace({
      "bin.dat": new Uint8Array([0, 1, 2, 0, 4]),
    });
    const buf = await readFile(join(ws.root, "bin.dat"));
    expect(buf[0]).toBe(0);
    expect(buf.length).toBe(5);
  });

  it("creates intermediate directories", async () => {
    ws = await mkTmpWorkspace({ "a/b/c/deep.txt": "deep\n" });
    expect(await readFile(join(ws.root, "a/b/c/deep.txt"), "utf8")).toBe(
      "deep\n",
    );
  });

  it("returns a real-path-resolved root", async () => {
    ws = await mkTmpWorkspace({});
    expect(ws.root.length).toBeGreaterThan(0);
  });

  it("cleanup removes the directory", async () => {
    ws = await mkTmpWorkspace({ "x.txt": "x" });
    const root = ws.root;
    await ws.cleanup();
    await expect(readFile(join(root, "x.txt"), "utf8")).rejects.toThrow();
    ws = { root: "", cleanup: async () => {} };
  });
});
