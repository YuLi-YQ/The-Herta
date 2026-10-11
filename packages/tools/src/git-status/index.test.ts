import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawnGit } from "../git/spawn-git.js";
import { mkTmpWorkspace } from "../testing/tmp-workspace.js";
import { mkToolContext } from "../testing/tool-context.js";
import { gitStatusTool } from "./index.js";

const GIT_AVAILABLE = (() => {
  try {
    const r = spawnSync("git", ["--version"], { stdio: "ignore" });
    return r.status === 0;
  } catch {
    return false;
  }
})();

async function seedRepo(root: string): Promise<void> {
  const sig = new AbortController().signal;
  for (const args of [
    ["init", "-q"],
    ["config", "user.email", "test@example.com"],
    ["config", "user.name", "Test"],
  ]) {
    // Surface a failed seed as itself. Silently ignoring these turned any
    // setup problem into `expect(r.ok).toBe(true)` failing with "expected
    // false to be true" — which says nothing about which git call broke.
    const r = await spawnGit(root, args, sig);
    if (!r.ok) throw new Error(`git ${args.join(" ")} failed: ${r.message}`);
  }
}

// File-level timeout: same load-dependent flake git_diff hit on 2026-07-05
// (see the note in ../git-diff/index.test.ts). The two tests below spawn four
// real git processes each (init + 2×config + status); measured under a full
// `vitest run` on Windows they take 1.9-2.8s against the 5s default, and a
// heavier run crosses it — observed failing twice in three consecutive full
// runs on 2026-07-26 while always passing in isolation (~600ms) and in the
// packages/tools-only run. The single-spawn test in this file never flaked.
describe.skipIf(!GIT_AVAILABLE)("git_status tool", { timeout: 20_000 }, () => {
  it("workspaceOnly excludes parent files and spells the selected subproject paths correctly", async () => {
    const ws = await mkTmpWorkspace({ "outside.txt": "private" });
    try {
      await seedRepo(ws.root);
      const child = join(ws.root, "selected");
      await mkdir(child);
      await writeFile(join(child, "inside.txt"), "in");
      const result = await gitStatusTool({ workspaceOnly: true }).run(
        { id: "scope", tool: "git_status", input: {} },
        mkToolContext({ workspaceRoot: child }),
        () => {},
      );
      expect(result.ok).toBe(true);
      expect(
        (result.data as { files: { path: string }[] }).files.map((f) => f.path),
      ).toEqual(["inside.txt"]);
      const outsideRequest = await gitStatusTool({ workspaceOnly: true }).run(
        { id: "bad", tool: "git_status", input: { path: "../outside.txt" } },
        mkToolContext({ workspaceRoot: child }),
        () => {},
      );
      expect(outsideRequest.ok).toBe(false);
    } finally {
      await ws.cleanup();
    }
  });
  it("returns clean=true for empty fresh repo", async () => {
    const ws = await mkTmpWorkspace({});
    try {
      await seedRepo(ws.root);
      const r = await gitStatusTool().run(
        { id: "c1", tool: "git_status", input: {} },
        mkToolContext({ workspaceRoot: ws.root }),
        () => {},
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const data = r.data as { clean: boolean; files: unknown[] };
      expect(data.clean).toBe(true);
      expect(data.files).toEqual([]);
    } finally {
      await ws.cleanup();
    }
  });

  it("returns clean=false with one untracked file", async () => {
    const ws = await mkTmpWorkspace({ "new.txt": "hi" });
    try {
      await seedRepo(ws.root);
      const r = await gitStatusTool().run(
        { id: "c1", tool: "git_status", input: {} },
        mkToolContext({ workspaceRoot: ws.root }),
        () => {},
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const data = r.data as {
        clean: boolean;
        files: { path: string }[];
      };
      expect(data.clean).toBe(false);
      expect(data.files.length).toBe(1);
      expect(data.files[0]?.path).toBe("new.txt");
    } finally {
      await ws.cleanup();
    }
  });

  it("returns not_a_repo for non-git workspace", async () => {
    const ws = await mkTmpWorkspace({});
    try {
      const r = await gitStatusTool().run(
        { id: "c1", tool: "git_status", input: {} },
        mkToolContext({ workspaceRoot: ws.root }),
        () => {},
      );
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe("not_a_repo");
    } finally {
      await ws.cleanup();
    }
  });
});
