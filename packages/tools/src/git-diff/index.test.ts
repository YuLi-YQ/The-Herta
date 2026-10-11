import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawnGit } from "../git/spawn-git.js";
import { mkTmpWorkspace } from "../testing/tmp-workspace.js";
import { mkToolContext } from "../testing/tool-context.js";
import { gitDiffTool } from "./index.js";

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
  await spawnGit(root, ["init", "-q"], sig);
  await spawnGit(root, ["config", "user.email", "test@example.com"], sig);
  await spawnGit(root, ["config", "user.name", "Test"], sig);
  await spawnGit(root, ["config", "commit.gpgsign", "false"], sig);
}

async function commitFile(
  root: string,
  rel: string,
  content: string,
  message: string,
): Promise<void> {
  await writeFile(join(root, rel), content, "utf8");
  const sig = new AbortController().signal;
  await spawnGit(root, ["add", rel], sig);
  await spawnGit(root, ["commit", "-q", "-m", message], sig);
}

// File-level timeout: every test here spawns several real git processes
// (init + config + add + commit + diff); under full-suite load these have
// been observed at 3.5s+ and one tripped the 5s default (flaked 2026-07-05).
describe.skipIf(!GIT_AVAILABLE)("git_diff tool", { timeout: 20_000 }, () => {
  it("workspaceOnly limits counts and patch to selected subproject; explicit escape input is rejected", async () => {
    const ws = await mkTmpWorkspace({});
    try {
      await seedRepo(ws.root);
      const child = join(ws.root, "selected");
      await mkdir(child);
      await commitFile(ws.root, "outside.txt", "private before\n", "outside");
      await commitFile(
        ws.root,
        "selected/inside.txt",
        "inside before\n",
        "inside",
      );
      await writeFile(
        join(ws.root, "outside.txt"),
        "PRIVATE-OUTSIDE-CONTENT\n",
      );
      await writeFile(join(child, "inside.txt"), "inside after\n");
      const result = await gitDiffTool({ workspaceOnly: true }).run(
        { id: "scope", tool: "git_diff", input: { patch: true } },
        mkToolContext({ workspaceRoot: child }),
        () => {},
      );
      expect(result.ok).toBe(true);
      expect(
        (result.data as { files: { path: string }[] }).files.map((f) => f.path),
      ).toEqual(["inside.txt"]);
      expect(JSON.stringify(result)).not.toContain("PRIVATE-OUTSIDE-CONTENT");
      expect(JSON.stringify(result)).not.toContain("outside.txt");
      const escapedRequest = await gitDiffTool({ workspaceOnly: true }).run(
        { id: "bad", tool: "git_diff", input: { path: "../outside.txt" } },
        mkToolContext({ workspaceRoot: child }),
        () => {},
      );
      expect(escapedRequest.ok).toBe(false);
    } finally {
      await ws.cleanup();
    }
  });
  it("works in a repository with no commits yet", async () => {
    // `HEAD` does not resolve before the first commit, so diffing against it
    // failed with "bad revision" — and a freshly initialised repository is the
    // state a coding agent most often starts one in. `git_status` and the
    // staged diff both answered; only the default mode was a dead end.
    const ws = await mkTmpWorkspace({});
    try {
      const sig = new AbortController().signal;
      await spawnGit(ws.root, ["init", "-q"], sig);
      await import("node:fs/promises").then((fs) =>
        fs.writeFile(join(ws.root, "new.txt"), "a\nb\n"),
      );
      await spawnGit(ws.root, ["add", "new.txt"], sig);
      const r = await gitDiffTool().run(
        { id: "c0", tool: "git_diff", input: {} },
        mkToolContext({ workspaceRoot: ws.root }),
        () => {},
      );
      expect(r.ok).toBe(true);
      const data = r.data as {
        files: ReadonlyArray<{ path: string }>;
        totalAdditions: number;
      };
      expect(data.files.map((f) => f.path)).toEqual(["new.txt"]);
      expect(data.totalAdditions).toBe(2);
    } finally {
      await ws.cleanup();
    }
  });

  it("rejects { staged: true, ref: 'HEAD' } with invalid_input", async () => {
    const ws = await mkTmpWorkspace({});
    try {
      const r = await gitDiffTool().run(
        {
          id: "c1",
          tool: "git_diff",
          input: { staged: true, ref: "HEAD" },
        },
        mkToolContext({ workspaceRoot: ws.root }),
        () => {},
      );
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe("invalid_input");
    } finally {
      await ws.cleanup();
    }
  });

  it("rejects ref with shell metacharacters via regex", async () => {
    const ws = await mkTmpWorkspace({});
    try {
      const r = await gitDiffTool().run(
        { id: "c1", tool: "git_diff", input: { ref: "HEAD; rm -rf" } },
        mkToolContext({ workspaceRoot: ws.root }),
        () => {},
      );
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe("invalid_input");
    } finally {
      await ws.cleanup();
    }
  });

  it("default mode: returns working-tree diff (staged + unstaged)", async () => {
    const ws = await mkTmpWorkspace({});
    try {
      await seedRepo(ws.root);
      await commitFile(ws.root, "a.txt", "hello\n", "init");
      await writeFile(join(ws.root, "a.txt"), "hello\nworld\n", "utf8");
      const r = await gitDiffTool().run(
        { id: "c1", tool: "git_diff", input: {} },
        mkToolContext({ workspaceRoot: ws.root }),
        () => {},
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const data = r.data as {
        mode: string;
        files: { path: string }[];
        empty: boolean;
      };
      expect(data.mode).toBe("working-tree");
      expect(data.empty).toBe(false);
      expect(data.files.some((f) => f.path === "a.txt")).toBe(true);
    } finally {
      await ws.cleanup();
    }
  });

  it("staged mode: returns only --cached diff", async () => {
    const ws = await mkTmpWorkspace({});
    try {
      await seedRepo(ws.root);
      await commitFile(ws.root, "a.txt", "hello\n", "init");
      await writeFile(join(ws.root, "a.txt"), "hello\nstaged\n", "utf8");
      await spawnGit(ws.root, ["add", "a.txt"], new AbortController().signal);
      await writeFile(
        join(ws.root, "a.txt"),
        "hello\nstaged\nunstaged\n",
        "utf8",
      );
      const r = await gitDiffTool().run(
        { id: "c1", tool: "git_diff", input: { staged: true } },
        mkToolContext({ workspaceRoot: ws.root }),
        () => {},
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const data = r.data as { mode: string; empty: boolean };
      expect(data.mode).toBe("staged");
      expect(data.empty).toBe(false);
    } finally {
      await ws.cleanup();
    }
  });

  it("ref mode with bad ref returns git_failed", async () => {
    const ws = await mkTmpWorkspace({});
    try {
      await seedRepo(ws.root);
      await commitFile(ws.root, "a.txt", "hi\n", "init");
      const r = await gitDiffTool().run(
        { id: "c1", tool: "git_diff", input: { ref: "no-such-ref" } },
        mkToolContext({ workspaceRoot: ws.root }),
        () => {},
      );
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe("git_failed");
    } finally {
      await ws.cleanup();
    }
  });

  // 2026-08-25: against real git, the `--stat` parser reported a 400-insertion
  // change as +66 (it counted a histogram git scales to terminal width) and
  // returned `.../X.tsx` for any long path — which read_file, show_excerpt and
  // report_finding all reject, so the answer could not become a next step.
  it.runIf(GIT_AVAILABLE)(
    "reports real line counts and whole paths, against real git",
    async () => {
      const ws = await mkTmpWorkspace({});
      try {
        await seedRepo(ws.root);
        await commitFile(ws.root, "f.txt", "base\n", "base");
        const deep =
          "packages/gui/src/renderer/components/Conversation/Controller.tsx";
        await import("node:fs/promises").then((fs) =>
          fs.mkdir(join(ws.root, deep, ".."), { recursive: true }),
        );
        await commitFile(ws.root, deep, "a\n", "deep");
        await writeFile(
          join(ws.root, "f.txt"),
          `base\n${Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n")}\n`,
          "utf8",
        );
        const r = await gitDiffTool().run(
          { id: "1", tool: "git_diff", input: {} },
          mkToolContext({ workspaceRoot: ws.root }),
          () => {},
        );
        expect(r.ok).toBe(true);
        const data = r.data as {
          totalAdditions: number;
          files: readonly { path: string; additions: number }[];
        };
        // The f.txt entry specifically — the workspace fixture may carry other
        // files, and the point is that THIS count is the real one.
        const f = data.files.find((x) => x.path === "f.txt");
        expect(f?.additions).toBe(400);
        for (const x of data.files)
          expect(x.path.startsWith("...")).toBe(false);
        expect(data.files.some((x) => x.path.includes("Controller.tsx"))).toBe(
          false,
        );
      } finally {
        await ws.cleanup();
      }
    },
  );

  it("rejects a ref that is really an option", async () => {
    // `-` is a literal in the ref character class, so `--ext-diff` used to
    // validate — and git parses it as an OPTION (exit 0), re-enabling the
    // external diff driver this tool passes `--no-ext-diff` to disable, in a
    // readOnly tool that raises no approval card.
    const ws = await mkTmpWorkspace({});
    try {
      for (const ref of ["--ext-diff", "-c", "--output=/tmp/x"]) {
        const r = await gitDiffTool().run(
          { id: "1", tool: "git_diff", input: { ref } },
          mkToolContext({ workspaceRoot: ws.root }),
          () => {},
        );
        expect(r.ok, ref).toBe(false);
        expect(r.error?.code, ref).toBe("invalid_input");
      }
    } finally {
      await ws.cleanup();
    }
  });
});

describe.skipIf(!GIT_AVAILABLE)(
  "git_diff { base } — merge-base semantics (ADR 0049 §3)",
  // 60s: the stale-local fixture alone runs ~10 git processes (bare origin,
  // two pushes, reset, branch, commits) before the tool's own spawns; the
  // siblings ran 18-19.5s under full-suite load and the first one tripped
  // the 20s file default.
  { timeout: 60_000 },
  () => {
    const sig = new AbortController().signal;
    const revParse = async (root: string, ref: string) => {
      const r = await spawnGit(root, ["rev-parse", ref], sig);
      return r.ok ? r.stdout.trim() : "";
    };

    it("prefers origin/<base> — a stale local base cannot inflate the answer", async () => {
      const ws = await mkTmpWorkspace({});
      const originWs = await mkTmpWorkspace({});
      try {
        await seedRepo(ws.root);
        await spawnGit(originWs.root, ["init", "-q", "--bare"], sig);
        await commitFile(ws.root, "a.txt", "A\n", "A");
        const shaA = await revParse(ws.root, "HEAD");
        await spawnGit(ws.root, ["branch", "-M", "main"], sig);
        await spawnGit(
          ws.root,
          ["remote", "add", "origin", originWs.root],
          sig,
        );
        await spawnGit(ws.root, ["push", "-q", "-u", "origin", "main"], sig);
        // origin/main advances to B…
        await commitFile(ws.root, "b.txt", "B\n", "B");
        const shaB = await revParse(ws.root, "HEAD");
        await spawnGit(ws.root, ["push", "-q", "origin", "main"], sig);
        // …while LOCAL main goes stale back at A.
        await spawnGit(ws.root, ["reset", "-q", "--hard", shaA], sig);
        // The feature forks from the REMOTE's tip (B) and does its own work.
        await spawnGit(
          ws.root,
          ["checkout", "-qb", "feature", "origin/main"],
          sig,
        );
        await commitFile(ws.root, "f.txt", "F\n", "feature work");

        const r = await gitDiffTool().run(
          { id: "b1", tool: "git_diff", input: { base: "main" } },
          mkToolContext({ workspaceRoot: ws.root }),
          () => {},
        );
        expect(r.ok).toBe(true);
        const data = r.data as {
          mode: string;
          base?: string;
          mergeBase?: string;
          files: ReadonlyArray<{ path: string }>;
        };
        expect(data.mode).toBe("base");
        expect(data.base).toBe("main");
        // Stale local main would have answered shaA — and the diff would
        // then claim B's b.txt as the feature's own work (the inflation).
        expect(data.mergeBase).toBe(shaB);
        expect(data.files.map((f) => f.path)).toEqual(["f.txt"]);
      } finally {
        await ws.cleanup();
        await originWs.cleanup();
      }
    });

    it("falls back to the local branch when there is no remote", async () => {
      const ws = await mkTmpWorkspace({});
      try {
        await seedRepo(ws.root);
        await commitFile(ws.root, "a.txt", "A\n", "A");
        const fork = await revParse(ws.root, "HEAD");
        await spawnGit(ws.root, ["branch", "-M", "main"], sig);
        await spawnGit(ws.root, ["checkout", "-qb", "feature"], sig);
        await commitFile(ws.root, "f.txt", "F\n", "feature work");
        const r = await gitDiffTool().run(
          { id: "b2", tool: "git_diff", input: { base: "main" } },
          mkToolContext({ workspaceRoot: ws.root }),
          () => {},
        );
        expect(r.ok).toBe(true);
        const data = r.data as { mergeBase?: string };
        expect(data.mergeBase).toBe(fork);
      } finally {
        await ws.cleanup();
      }
    });

    it("says plainly when the histories share no ancestor", async () => {
      const ws = await mkTmpWorkspace({});
      try {
        await seedRepo(ws.root);
        await commitFile(ws.root, "a.txt", "A\n", "A");
        await spawnGit(ws.root, ["branch", "-M", "main"], sig);
        await spawnGit(ws.root, ["checkout", "-q", "--orphan", "island"], sig);
        await commitFile(ws.root, "i.txt", "I\n", "island");
        const r = await gitDiffTool().run(
          { id: "b3", tool: "git_diff", input: { base: "main" } },
          mkToolContext({ workspaceRoot: ws.root }),
          () => {},
        );
        expect(r.ok).toBe(false);
        expect(r.error?.code).toBe("git_failed");
        expect(r.error?.message).toContain("no merge base");
      } finally {
        await ws.cleanup();
      }
    });

    it("rejects base combined with ref or staged", async () => {
      const ws = await mkTmpWorkspace({});
      try {
        for (const input of [
          { base: "main", ref: "HEAD" },
          { base: "main", staged: true },
        ]) {
          const r = await gitDiffTool().run(
            { id: "b4", tool: "git_diff", input },
            mkToolContext({ workspaceRoot: ws.root }),
            () => {},
          );
          expect(r.ok).toBe(false);
          expect(r.error?.code).toBe("invalid_input");
        }
      } finally {
        await ws.cleanup();
      }
    });
  },
);

describe.skipIf(!GIT_AVAILABLE)(
  "git_diff { patch } — hunks on demand (ADR 0049 §3)",
  { timeout: 60_000 },
  () => {
    it("returns the unified diff beside the counts", async () => {
      const ws = await mkTmpWorkspace({});
      try {
        await seedRepo(ws.root);
        await commitFile(ws.root, "a.txt", "one\n", "init");
        await writeFile(join(ws.root, "a.txt"), "one\ntwo\n", "utf8");
        const r = await gitDiffTool().run(
          { id: "p1", tool: "git_diff", input: { patch: true } },
          mkToolContext({ workspaceRoot: ws.root }),
          () => {},
        );
        expect(r.ok).toBe(true);
        const data = r.data as {
          patch?: string;
          patchTruncated?: boolean;
          totalAdditions: number;
        };
        expect(data.totalAdditions).toBe(1);
        expect(data.patch).toContain("+two");
        expect(data.patch).toContain("--- a/a.txt");
        expect(data.patchTruncated).toBeUndefined();
      } finally {
        await ws.cleanup();
      }
    });

    it("omits the patch when there is nothing to show", async () => {
      const ws = await mkTmpWorkspace({});
      try {
        await seedRepo(ws.root);
        await commitFile(ws.root, "a.txt", "one\n", "init");
        const r = await gitDiffTool().run(
          { id: "p2", tool: "git_diff", input: { patch: true } },
          mkToolContext({ workspaceRoot: ws.root }),
          () => {},
        );
        expect(r.ok).toBe(true);
        const data = r.data as { empty: boolean; patch?: string };
        expect(data.empty).toBe(true);
        expect(data.patch).toBeUndefined();
      } finally {
        await ws.cleanup();
      }
    });

    it("composes with { base } — the patch shows only the branch's own work", async () => {
      const ws = await mkTmpWorkspace({});
      try {
        await seedRepo(ws.root);
        await commitFile(ws.root, "a.txt", "A\n", "A");
        await spawnGit(
          ws.root,
          ["branch", "-M", "main"],
          new AbortController().signal,
        );
        await spawnGit(
          ws.root,
          ["checkout", "-qb", "feature"],
          new AbortController().signal,
        );
        await commitFile(ws.root, "f.txt", "F\n", "feature work");
        const r = await gitDiffTool().run(
          { id: "p3", tool: "git_diff", input: { base: "main", patch: true } },
          mkToolContext({ workspaceRoot: ws.root }),
          () => {},
        );
        expect(r.ok).toBe(true);
        const data = r.data as { patch?: string };
        expect(data.patch).toContain("+F");
        expect(data.patch).not.toContain("+A");
      } finally {
        await ws.cleanup();
      }
    });
  },
);
