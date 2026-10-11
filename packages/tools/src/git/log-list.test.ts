import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { describeBranches, describeLog, isSafeRefName } from "./log-list.js";
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

describe("isSafeRefName", () => {
  it("accepts branch-shaped names and refuses options, expressions and control characters", () => {
    for (const ok of ["main", "feature/x-1", "origin/main", "v1.2.3", "a_b"])
      expect(isSafeRefName(ok)).toBe(true);
    for (const bad of [
      "",
      "-x",
      "--output=x",
      "a b",
      "a..b",
      "a@{1}",
      "a^",
      "a~1",
      "a:b",
      "a?",
      "a*",
      "a[b",
      "a\\b",
      "/a",
      "a/",
      "a.lock",
      "a\tb",
      "a\nb",
      "x".repeat(256),
    ])
      expect(isSafeRefName(bad)).toBe(false);
  });
});

describe.skipIf(!GIT_AVAILABLE)(
  "describeLog (ADR 0059 §6)",
  { timeout: 60_000 },
  () => {
    const git = (dir: string, ...a: string[]) =>
      spawnSync("git", a, { cwd: dir, encoding: "utf8" });

    function seeded(commits: number): string {
      const dir = mkDir("log-");
      git(dir, "init", "-q", "-b", "main");
      git(dir, "config", "user.email", "t@t");
      git(dir, "config", "user.name", "Tester");
      git(dir, "config", "commit.gpgsign", "false");
      writeFileSync(join(dir, "a.ts"), "one\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-qm", "step 1");
      for (let i = 2; i <= commits; i += 1) {
        git(dir, "commit", "-q", "--allow-empty", "-m", `step ${i}`);
      }
      return dir;
    }

    it("pages newest first, and hasMore is a fact from the extra row", async () => {
      const dir = seeded(7);
      const first = read(await describeLog(dir, { skip: 0, limit: 3 }));
      expect(first?.entries.map((e) => e.subject)).toEqual([
        "step 7",
        "step 6",
        "step 5",
      ]);
      expect(first?.hasMore).toBe(true);
      expect(first?.upstream).toBeNull();
      expect(first?.entries[0]?.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(first?.entries[0]?.shortSha).toMatch(/^[0-9a-f]{4,}$/);
      expect(first?.entries[0]?.author).toBe("Tester");
      expect(first?.entries[0]?.authoredAt).toMatch(/^\d{4}-/);
      expect(first?.entries.every((e) => !e.unpushed)).toBe(true);
      const last = read(await describeLog(dir, { skip: 6, limit: 3 }));
      expect(last?.entries.map((e) => e.subject)).toEqual(["step 1"]);
      expect(last?.hasMore).toBe(false);
      expect(last?.skip).toBe(6);
    });

    it("marks the commits not on the upstream — the rev-list set, not the first N", async () => {
      const dir = seeded(2);
      const origin = mkDir("log-origin-");
      git(origin, "init", "-q", "--bare");
      git(dir, "remote", "add", "origin", origin);
      git(dir, "push", "-q", "-u", "origin", "main");
      git(dir, "commit", "-q", "--allow-empty", "-m", "local only 1");
      git(dir, "commit", "-q", "--allow-empty", "-m", "local only 2");
      const page = read(await describeLog(dir, { skip: 0, limit: 10 }));
      expect(page?.upstream).toBe("origin/main");
      expect(page?.entries.map((e) => [e.subject, e.unpushed])).toEqual([
        ["local only 2", true],
        ["local only 1", true],
        ["step 2", false],
        ["step 1", false],
      ]);
    });

    it("reads another branch's history by ref, marked against THAT branch's upstream (§6 amendment)", async () => {
      const dir = seeded(2);
      const origin = mkDir("log-origin-");
      git(origin, "init", "-q", "--bare");
      git(dir, "remote", "add", "origin", origin);
      git(dir, "push", "-q", "-u", "origin", "main");
      git(dir, "checkout", "-qb", "feature/x");
      git(dir, "commit", "-q", "--allow-empty", "-m", "feature work");
      git(dir, "push", "-q", "-u", "origin", "feature/x");
      git(dir, "commit", "-q", "--allow-empty", "-m", "feature local");
      git(dir, "checkout", "-q", "main");
      // HEAD is main: its history has no feature commits.
      const main = read(await describeLog(dir, { skip: 0, limit: 10 }));
      expect(main?.entries.map((e) => e.subject)).toEqual(["step 2", "step 1"]);
      // The feature branch, read without checking it out.
      const feature = read(
        await describeLog(dir, {
          skip: 0,
          limit: 10,
          ref: "feature/x",
        }),
      );
      expect(feature?.upstream).toBe("origin/feature/x");
      expect(feature?.entries.map((e) => [e.subject, e.unpushed])).toEqual([
        ["feature local", true],
        ["feature work", false],
        ["step 2", false],
        ["step 1", false],
      ]);
      // A remote-tracking ref reads too (no upstream of its own).
      const remote = read(
        await describeLog(dir, {
          skip: 0,
          limit: 10,
          ref: "origin/feature/x",
        }),
      );
      expect(remote?.entries[0]?.subject).toBe("feature work");
      expect(remote?.upstream).toBeNull();
      // Still on main.
      expect(git(dir, "rev-parse", "--abbrev-ref", "HEAD").stdout.trim()).toBe(
        "main",
      );
      // An unknown ref is an empty history; an option-shaped one is null.
      const missing = read(
        await describeLog(dir, {
          skip: 0,
          limit: 10,
          ref: "nope",
        }),
      );
      expect(missing?.entries).toEqual([]);
      await expect(
        describeLog(dir, { skip: 0, limit: 10, ref: "--output=x" }),
      ).resolves.toBeNull();
    });

    it("filters by commit message — case-insensitive, a fixed string — with paging over the matches", async () => {
      const dir = seeded(6);
      git(dir, "commit", "-q", "--allow-empty", "-m", "Fix: the (odd) one");
      const hits = read(
        await describeLog(dir, { skip: 0, limit: 2, query: "STEP" }),
      );
      expect(hits?.entries.map((e) => e.subject)).toEqual(["step 6", "step 5"]);
      expect(hits?.hasMore).toBe(true);
      const rest = read(
        await describeLog(dir, {
          skip: 4,
          limit: 10,
          query: "step",
        }),
      );
      expect(rest?.entries.map((e) => e.subject)).toEqual(["step 2", "step 1"]);
      expect(rest?.hasMore).toBe(false);
      // A fixed string: regex metacharacters and a leading dash are text.
      const odd = read(
        await describeLog(dir, {
          skip: 0,
          limit: 10,
          query: "(odd)",
        }),
      );
      expect(odd?.entries.map((e) => e.subject)).toEqual([
        "Fix: the (odd) one",
      ]);
      const dash = read(
        await describeLog(dir, {
          skip: 0,
          limit: 10,
          query: "--no-such-option",
        }),
      );
      expect(dash?.entries).toEqual([]);
      const none = read(
        await describeLog(dir, { skip: 0, limit: 10, query: "zzz" }),
      );
      expect(none?.entries).toEqual([]);
      expect(none?.hasMore).toBe(false);
    });

    it("lists the branches, locals then remotes, HEAD's own marked, newest first", async () => {
      const dir = seeded(1);
      const origin = mkDir("log-origin-");
      git(origin, "init", "-q", "--bare");
      git(dir, "remote", "add", "origin", origin);
      git(dir, "push", "-q", "-u", "origin", "main");
      git(dir, "checkout", "-qb", "feature/y");
      git(dir, "commit", "-q", "--allow-empty", "-m", "y");
      const list = read(await describeBranches(dir));
      expect(list?.current).toBe("feature/y");
      expect(
        list?.branches.map((b) => [b.name, b.kind, b.upstream, b.current]),
      ).toEqual([
        ["feature/y", "local", null, true],
        ["main", "local", "origin/main", false],
        ["origin/main", "remote", null, false],
      ]);
      git(dir, "checkout", "-q", "--detach");
      expect(read(await describeBranches(dir))?.current).toBeNull();
      await expect(describeBranches(mkDir("log-plain-"))).resolves.toBeNull();
    });

    it("an unborn repository has an empty page; bad paging and no repo answer null", async () => {
      const dir = mkDir("log-unborn-");
      git(dir, "init", "-q", "-b", "main");
      const page = read(await describeLog(dir, { skip: 0, limit: 10 }));
      expect(page?.entries).toEqual([]);
      expect(page?.hasMore).toBe(false);
      const seededDir = seeded(1);
      await expect(
        describeLog(seededDir, { skip: -1, limit: 10 }),
      ).resolves.toBeNull();
      await expect(
        describeLog(seededDir, { skip: 0, limit: 0 }),
      ).resolves.toBeNull();
      await expect(
        describeLog(mkDir("log-plain-"), { skip: 0, limit: 10 }),
      ).resolves.toBeNull();
    });
  },
);

describe.skipIf(!GIT_AVAILABLE)(
  "describeLog — a gone upstream (ADR 0058 §7)",
  { timeout: 20_000 },
  () => {
    const git = (dir: string, ...a: string[]) =>
      spawnSync("git", a, { cwd: dir, encoding: "utf8" });

    it("names the upstream, says it is gone, and marks every commit unpushed", async () => {
      const dir = mkDir("log-gone-");
      git(dir, "init", "-q", "-b", "main");
      git(dir, "config", "user.email", "t@t");
      git(dir, "config", "user.name", "T");
      git(dir, "config", "commit.gpgsign", "false");
      writeFileSync(join(dir, "a.ts"), "one\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-qm", "step 1");
      const origin = mkDir("log-gone-origin-");
      git(origin, "init", "-q", "--bare");
      git(origin, "config", "receive.denyDeleteCurrent", "ignore");
      git(dir, "remote", "add", "origin", origin);
      git(dir, "push", "-q", "-u", "origin", "main");
      git(dir, "commit", "-q", "--allow-empty", "-m", "step 2");
      git(dir, "push", "-q", "origin", "--delete", "main");
      git(dir, "fetch", "-q", "--prune");
      const page = read(await describeLog(dir, { skip: 0, limit: 10 }));
      expect(page?.upstream).toBe("origin/main");
      expect(page?.upstreamGone).toBe(true);
      expect(page?.entries.map((e) => [e.subject, e.unpushed])).toEqual([
        ["step 2", true],
        ["step 1", true],
      ]);
    });

    it("a branch with no upstream is not gone", async () => {
      const dir = mkDir("log-noup-");
      git(dir, "init", "-q", "-b", "main");
      git(dir, "config", "user.email", "t@t");
      git(dir, "config", "user.name", "T");
      git(dir, "config", "commit.gpgsign", "false");
      git(dir, "commit", "-q", "--allow-empty", "-m", "step 1");
      const page = read(await describeLog(dir, { skip: 0, limit: 10 }));
      expect(page?.upstream).toBeNull();
      expect(page?.upstreamGone).toBe(false);
    });
  },
);

describe.skipIf(!GIT_AVAILABLE)(
  "describeLog — a one-commit history reads as one entry",
  { timeout: 60_000 },
  () => {
    // "A read the clock ends reports a timeout" lives in
    // read-timeout.test.ts, against a git that never finishes — racing the
    // real one against 1 ms was lost on the Linux CI runner (2026-09-18,
    // 2026-09-20: scheduled CI red on this test alone). What stays here is
    // the half that needs a real repository.
    it("an empty commit is a history of one", async () => {
      const dir = mkDir("log-one-");
      const git = (...a: string[]) =>
        spawnSync("git", a, { cwd: dir, encoding: "utf8" });
      git("init", "-q", "-b", "main");
      git("config", "user.email", "t@t");
      git("config", "user.name", "T");
      git("config", "commit.gpgsign", "false");
      git("commit", "-q", "--allow-empty", "-m", "step 1");
      const ok = read(await describeLog(dir, { skip: 0, limit: 10 }));
      expect(
        ok !== null && !isGitReadTimeout(ok) && ok.entries.length === 1,
      ).toBe(true);
    });
  },
);
