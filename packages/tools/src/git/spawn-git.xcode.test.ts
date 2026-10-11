import { describe, expect, it, vi } from "vitest";

// A Mac without the developer tools, where `/usr/bin/git` is Apple's
// placeholder (git-usable.ts). Own file: the mocks are module-wide.
vi.mock("./git-usable.js", () => ({
  gitUsable: async () => ({
    ok: false,
    message: "git on this Mac is Apple's placeholder",
  }),
}));
const spawn = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (...a: unknown[]) => spawn(...a),
}));

const { spawnGit } = await import("./spawn-git.js");
const { classifyProbeFailure } = await import("./repo-probe.js");

describe("spawnGit on a Mac whose git is the developer-tools placeholder (2026-09-23)", () => {
  it("answers 'no git' WITHOUT spawning — the placeholder would open the install dialog", async () => {
    const r = await spawnGit(
      "/Users/x/proj",
      ["status"],
      new AbortController().signal,
    );
    expect(spawn).not.toHaveBeenCalled();
    expect(r).toMatchObject({
      ok: false,
      code: "spawn_failed",
      cause: "git_not_found",
    });
    // …which the repository card reads as a definite "absent": the card
    // retracts and no retry timer re-asks (the retry re-opened the dialog).
    if (!r.ok) expect(classifyProbeFailure(r)).toBe("absent");
  });

  it("still reports a cancelled call as a cancellation, not as missing git", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      spawnGit("/Users/x/proj", ["status"], ac.signal),
    ).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
  });
});
