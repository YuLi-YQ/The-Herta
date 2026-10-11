import type { RepoContextSnapshot } from "@herta/app-server";
import { describe, expect, it } from "vitest";
import { createMockHertaBridge } from "../ipc/mock-bridge.js";
import { SessionStore } from "./session-store.js";

const REPO: RepoContextSnapshot = {
  root: "/repo",
  prefix: "",
  gitDir: "/repo/.git",
  branch: "main",
  detached: false,
  headShort: "abc1234",
  upstream: "origin/main",
  ahead: 1,
  behind: 0,
  upstreamGone: false,
  defaultBranch: "main",
  inProgress: null,
  conflicted: [],
  dirty: [{ x: " ", y: "M", path: "a.ts" }],
  dirtyTotal: 1,
  recentSubjects: ["abc1234 init"],
  recentCommits: [],
};

function snapshot(workspace: string) {
  return {
    sessionId: "s1",
    workspaceRoot: "/r",
    record: [],
    overlay: null,
    backendWorkspace: workspace,
    backendWorkspaceIsDefault: false,
  };
}

describe("SessionStore — the repository card's state (ADR 0058)", () => {
  it("takes the reset snapshot's repo, then follows repo events for the active workspace", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    mock.emitReset({ ...snapshot("/repo"), repo: REPO });
    expect(store.getSnapshot().repo).toEqual(REPO);
    mock.emitRepo({ kind: "repo", workspace: "/repo", repo: null });
    expect(store.getSnapshot().repo).toBeNull();
    mock.emitRepo({ kind: "repo", workspace: "/repo", repo: REPO });
    expect(store.getSnapshot().repo?.branch).toBe("main");
    store.dispose();
  });

  it("ignores a late answer for a workspace the session has left, and keeps the last answer across a workspace change until the new one arrives", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    mock.emitReset(snapshot("/repo"));
    mock.emitRepo({ kind: "repo", workspace: "/repo", repo: REPO });
    mock.emitWorkspace({
      kind: "workspace",
      workspace: "/elsewhere",
      isDefault: false,
    });
    // The old workspace's late answer describes the wrong folder.
    mock.emitRepo({
      kind: "repo",
      workspace: "/repo",
      repo: { ...REPO, branch: "stale" },
    });
    expect(store.getSnapshot().repo?.branch).toBe("main");
    mock.emitRepo({ kind: "repo", workspace: "/elsewhere", repo: null });
    expect(store.getSnapshot().repo).toBeNull();
    store.dispose();
  });

  it("a new activation without a repo in its snapshot starts from null", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    mock.emitReset({ ...snapshot("/repo"), repo: REPO });
    mock.emitReset({ ...snapshot("/other"), sessionId: "s2" });
    expect(store.getSnapshot().repo).toBeNull();
    store.dispose();
  });
});
