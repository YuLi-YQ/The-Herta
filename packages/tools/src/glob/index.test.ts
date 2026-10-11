import { utimes } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mkTmpWorkspace, type TmpWorkspace } from "../testing/tmp-workspace.js";
import { mkToolContext } from "../testing/tool-context.js";
import { type GlobData, globTool } from "./index.js";

let ws: TmpWorkspace;
const noop = (): void => {};

async function run(input: unknown) {
  return globTool().run(
    { id: "g1", tool: "glob", input },
    mkToolContext({ workspaceRoot: ws.root }),
    noop,
  );
}

describe("globTool", () => {
  it("matches by pattern and sorts newest first", async () => {
    ws = await mkTmpWorkspace({
      "src/old.ts": "a",
      "src/new.ts": "b",
      "src/skip.js": "c",
      "docs/readme.md": "d",
    });
    try {
      const now = Date.now() / 1000;
      await utimes(join(ws.root, "src", "old.ts"), now - 1000, now - 1000);
      await utimes(join(ws.root, "src", "new.ts"), now, now);

      const r = await run({ pattern: "**/*.ts" });
      expect(r.ok).toBe(true);
      const data = r.data as GlobData;
      expect(data.files.map((f) => f.path)).toEqual([
        "src/new.ts",
        "src/old.ts",
      ]);
      expect(data.truncated).toBe(false);
      expect(r.summary).toContain("newest first");
    } finally {
      await ws.cleanup();
    }
  });

  it("matches relative to the search root when path is given", async () => {
    ws = await mkTmpWorkspace({
      "src/a.ts": "a",
      "src/deep/b.ts": "b",
      "other/c.ts": "c",
    });
    try {
      const r = await run({ pattern: "**/*.ts", path: "src" });
      expect(r.ok).toBe(true);
      const data = r.data as GlobData;
      expect(data.files.map((f) => f.path).sort()).toEqual([
        "src/a.ts",
        "src/deep/b.ts",
      ]);
    } finally {
      await ws.cleanup();
    }
  });

  it("skips walker skip-dirs and credential-shaped files", async () => {
    ws = await mkTmpWorkspace({
      "keep.pem.md": "fine",
      "node_modules/dep/index.ts": "skip",
      ".git/config.ts": "skip",
      "keys/secret.pem": "deny",
      "a.ts": "keep",
    });
    try {
      const r = await run({ pattern: "**/*" });
      expect(r.ok).toBe(true);
      const paths = (r.data as GlobData).files.map((f) => f.path);
      expect(paths).toContain("a.ts");
      expect(paths).toContain("keep.pem.md");
      expect(paths.some((p) => p.includes("node_modules"))).toBe(false);
      expect(paths.some((p) => p.includes(".git"))).toBe(false);
      expect(paths).not.toContain("keys/secret.pem");
    } finally {
      await ws.cleanup();
    }
  });

  it("caps results and reports truncation", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 8; i += 1) files[`f${i}.txt`] = "x";
    ws = await mkTmpWorkspace(files);
    try {
      const r = await run({ pattern: "*.txt", maxResults: 3 });
      expect(r.ok).toBe(true);
      const data = r.data as GlobData;
      expect(data.files).toHaveLength(3);
      expect(data.truncated).toBe(true);
      expect(r.summary).toContain("truncated");
    } finally {
      await ws.cleanup();
    }
  });

  it("lists the redacted log dir BY NAME when rooted there, and nothing else under .herta (ADR 0036; list_files' role since ADR 0067)", async () => {
    ws = await mkTmpWorkspace({
      ".herta/logs/abc-call_00_xyz.log": "exit 0\n",
      ".herta/tool-results/c.json": "{}\n",
      "a.ts": "keep",
    });
    try {
      const logs = await run({ pattern: "*.log", path: ".herta/logs" });
      expect(logs.ok).toBe(true);
      expect((logs.data as GlobData).files.map((f) => f.path)).toEqual([
        ".herta/logs/abc-call_00_xyz.log",
      ]);
      // A workspace-root glob never descends into `.herta` at all.
      const fromRoot = await run({ pattern: "**/*" });
      expect(fromRoot.ok).toBe(true);
      expect(
        (fromRoot.data as GlobData).files.some((f) =>
          f.path.startsWith(".herta"),
        ),
      ).toBe(false);
      // `.herta` itself and the unredacted tool-results stay denied.
      const herta = await run({ pattern: "**/*", path: ".herta" });
      expect(herta.ok).toBe(false);
      expect(herta.error?.code).toBe("path_denied");
      const results = await run({ pattern: "*", path: ".herta/tool-results" });
      expect(results.ok).toBe(false);
    } finally {
      await ws.cleanup();
    }
  });

  it("rejects malformed patterns and unsafe roots", async () => {
    ws = await mkTmpWorkspace({ "a.ts": "x" });
    try {
      const bad = await run({ pattern: "{unclosed" });
      expect(bad.ok).toBe(false);
      expect(bad.error?.code).toBe("invalid_pattern");
      const outside = await run({ pattern: "*", path: "../.." });
      expect(outside.ok).toBe(false);
      const missing = await run({ pattern: "*", path: "no-such-dir" });
      expect(missing.ok).toBe(false);
      expect(missing.error?.code).toBe("not_found");
    } finally {
      await ws.cleanup();
    }
  });
});
