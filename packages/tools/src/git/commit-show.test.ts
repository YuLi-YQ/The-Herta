import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  describeCommit,
  parseNameStatusZ,
  parseNumstatZ,
} from "./commit-show.js";
import { type GitReadTimeout, isGitReadTimeout } from "./spawn-git.js";

/** The reader's answer minus the clock's: a read that timed out fails the
 *  test outright, so every other assertion sees `T | null` as before. */
function read<T>(value: T | null | GitReadTimeout): T | null {
  if (isGitReadTimeout(value)) throw new Error("the read timed out");
  return value;
}

const GIT_AVAILABLE = (() => {
  try {
    return spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
})();

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function mkDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

describe("parseNameStatusZ / parseNumstatZ (pure)", () => {
  it("reads plain entries and the rename's old-then-new order", () => {
    const names = parseNameStatusZ(
      "M\0src/a.ts\0A\0new.ts\0R087\0old.ts\0moved.ts\0D\0gone.ts\0",
    );
    expect(names).toEqual([
      { path: "src/a.ts", status: "modified" },
      { path: "new.ts", status: "added" },
      { path: "moved.ts", oldPath: "old.ts", status: "renamed" },
      { path: "gone.ts", status: "deleted" },
    ]);
    const nums = parseNumstatZ(
      [
        "3\t1\tsrc/a.ts",
        "-\t-\tpic.png",
        "5\t0\t",
        "old.ts",
        "moved.ts",
        "",
      ].join("\0"),
    );
    expect(nums.get("src/a.ts")).toEqual({ added: 3, deleted: 1 });
    expect(nums.get("pic.png")).toEqual({ added: null, deleted: null });
    expect(nums.get("moved.ts")).toEqual({ added: 5, deleted: 0 });
    expect(nums.has("old.ts")).toBe(false);
  });
});

describe.skipIf(!GIT_AVAILABLE)(
  "describeCommit (ADR 0059)",
  { timeout: 60_000 },
  () => {
    const git = (dir: string, ...a: string[]) =>
      spawnSync("git", a, { cwd: dir, encoding: "utf8" });
    const head = (dir: string) =>
      git(dir, "rev-parse", "HEAD").stdout?.trim() ?? "";

    function seeded(): string {
      const dir = mkDir("commit-");
      git(dir, "init", "-q", "-b", "main");
      git(dir, "config", "user.email", "t@t");
      git(dir, "config", "user.name", "Tester");
      git(dir, "config", "commit.gpgsign", "false");
      writeFileSync(join(dir, "a.ts"), "one\ntwo\n");
      writeFileSync(join(dir, "old.ts"), "keep me exactly\nas is\nplease\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-qm", "init: seed");
      return dir;
    }

    it("describes a commit: message, author, files with counts and statuses, the patch", async () => {
      const dir = seeded();
      writeFileSync(join(dir, "a.ts"), "one\nthree\n");
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src", "new.ts"), "created\n");
      git(dir, "mv", "old.ts", "moved.ts");
      writeFileSync(join(dir, "pic.png"), Buffer.from([0, 1, 2, 3]));
      git(dir, "add", "-A");
      git(dir, "commit", "-qm", "feat: the work\n\nA body line.\n");
      const sha = head(dir);

      const c = read(await describeCommit(dir, sha.slice(0, 7)));
      expect(c).not.toBeNull();
      expect(c?.sha).toBe(sha);
      expect(c?.shortSha).toBe(sha.slice(0, 7));
      expect(c?.subject).toBe("feat: the work");
      expect(c?.body).toBe("A body line.");
      expect(c?.author).toBe("Tester");
      expect(c?.authoredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(c?.parents).toHaveLength(1);
      const byPath = new Map(c?.files.map((f) => [f.path, f]));
      expect(byPath.get("a.ts")).toEqual({
        path: "a.ts",
        status: "modified",
        added: 1,
        deleted: 1,
      });
      expect(byPath.get("src/new.ts")?.status).toBe("added");
      expect(byPath.get("moved.ts")).toEqual({
        path: "moved.ts",
        oldPath: "old.ts",
        status: "renamed",
        added: 0,
        deleted: 0,
      });
      expect(byPath.get("pic.png")).toEqual({
        path: "pic.png",
        status: "added",
        added: null,
        deleted: null,
      });
      expect(c?.filesTotal).toBe(4);
      expect(c?.patch).toContain("diff --git a/a.ts b/a.ts");
      expect(c?.patch).toContain("-two");
      expect(c?.patch).toContain("+three");
      expect(c?.patchTruncated).toBe(false);
    });

    it("a root commit shows its whole tree; a merge shows the diff against its first parent", async () => {
      const dir = seeded();
      const root = read(await describeCommit(dir, head(dir)));
      expect(root?.parents).toEqual([]);
      expect(root?.files.map((f) => f.path).sort()).toEqual(["a.ts", "old.ts"]);

      git(dir, "checkout", "-qb", "side");
      writeFileSync(join(dir, "side.ts"), "side\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-qm", "side work");
      git(dir, "checkout", "-q", "main");
      writeFileSync(join(dir, "main.ts"), "main\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-qm", "main work");
      git(dir, "merge", "-q", "--no-ff", "-m", "merge side", "side");
      const merge = read(await describeCommit(dir, head(dir)));
      expect(merge?.parents).toHaveLength(2);
      // Against the first parent (main): only the side's file arrived.
      expect(merge?.files.map((f) => f.path)).toEqual(["side.ts"]);
    });

    it("answers null for an unknown id, a non-hex ref, outside a repo, and on abort", async () => {
      const dir = seeded();
      await expect(describeCommit(dir, "0000000")).resolves.toBeNull();
      await expect(describeCommit(dir, "HEAD")).resolves.toBeNull();
      await expect(describeCommit(dir, "--ext-diff")).resolves.toBeNull();
      await expect(
        describeCommit(mkDir("commit-plain-"), head(dir)),
      ).resolves.toBeNull();
      const ac = new AbortController();
      ac.abort();
      await expect(
        describeCommit(dir, head(dir), ac.signal),
      ).resolves.toBeNull();
    });
  },
);

// "A read the clock ends reports a timeout" lives in read-timeout.test.ts,
// against a git that never finishes — racing the real one against 1 ms was
// lost on the Linux CI runner (2026-09-18, 2026-09-20).
