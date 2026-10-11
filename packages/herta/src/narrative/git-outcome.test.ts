import { describe, expect, it } from "vitest";
import { detectGitOutcome } from "./git-outcome.js";

const base = {
  exitCode: 0 as number | null,
  stdout: "",
  stderr: "",
};

describe("detectGitOutcome (ADR 0049 §4)", () => {
  it("reads the commit sha from git's own summary line", () => {
    expect(
      detectGitOutcome({
        ...base,
        argv: ["git", "commit", "-m", "fix"],
        stdout: "[main a1b2c34] fix\n 1 file changed, 1 insertion(+)\n",
      }).commit,
    ).toBe("a1b2c34");
    // Root commit and detached HEAD wear extra words before the sha.
    expect(
      detectGitOutcome({
        ...base,
        argv: ["git", "commit", "-m", "init"],
        stdout: "[main (root-commit) 0e1f2a3] init\n",
      }).commit,
    ).toBe("0e1f2a3");
    expect(
      detectGitOutcome({
        ...base,
        argv: ["git", "commit", "-m", "wip"],
        stdout: "[detached HEAD beef123] wip\n",
      }).commit,
    ).toBe("beef123");
  });

  it("a failed command landed nothing — the hook-failure case stays out", () => {
    // A pre-commit hook failure means the commit did NOT happen; a sha-shaped
    // line in its output must not become the run's identity.
    expect(
      detectGitOutcome({
        argv: ["git", "commit", "-m", "x"],
        exitCode: 1,
        stdout: "[main a1b2c34] x\n",
        stderr: "husky: pre-commit failed\n",
      }),
    ).toEqual({});
  });

  it("reads the push destination from the ref-update line (stderr)", () => {
    expect(
      detectGitOutcome({
        ...base,
        argv: ["git", "push", "origin", "main"],
        stderr: "To /tmp/origin\n   a1b2c34..d4e5f67  main -> main\n",
      }).pushedRef,
    ).toBe("main");
    expect(
      detectGitOutcome({
        ...base,
        argv: ["git", "push", "-u", "origin", "feature"],
        stderr: "To /tmp/origin\n * [new branch]      feature -> feature\n",
      }).pushedRef,
    ).toBe("feature");
    // Forced update wears a leading +.
    expect(
      detectGitOutcome({
        ...base,
        argv: ["git", "push", "--force", "origin", "main"],
        stderr: "To /tmp/origin\n + a1b2c34...d4e5f67 main -> main\n",
      }).pushedRef,
    ).toBe("main");
  });

  it("a pull/fetch prints the same ref-update shape and is NOT a push", () => {
    expect(
      detectGitOutcome({
        ...base,
        argv: ["git", "pull"],
        stderr: "From /tmp/origin\n   a1b2c34..d4e5f67  main -> origin/main\n",
      }),
    ).toEqual({});
  });

  it("requires git in the command — an echo cannot imitate an outcome", () => {
    expect(
      detectGitOutcome({
        ...base,
        argv: ["node", "print-commit.js"],
        stdout: "[main a1b2c34] fake\n",
      }),
    ).toEqual({});
  });

  it("sees through a bash script and reports both outcomes", () => {
    const g = detectGitOutcome({
      ...base,
      argv: [
        "bash",
        "-lc",
        'git add -A && git commit -m "done" && git push origin main',
      ],
      stdout: "[main c0ffee1] done\n",
      stderr: "To /tmp/origin\n   a1b2c34..c0ffee1  main -> main\n",
    });
    expect(g.commit).toBe("c0ffee1");
    expect(g.pushedRef).toBe("main");
  });
});
