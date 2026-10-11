import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultWorkspaceFor,
  dreamDirFor,
  narrativeDirFor,
  resolveEffectiveWorkspace,
  workspacesBaseDir,
} from "./workspace-paths.js";

describe("workspace-paths", () => {
  it("workspacesBaseDir is <home>/.herta/workspaces", () => {
    expect(workspacesBaseDir("/home/u")).toBe(
      join("/home/u", ".herta", "workspaces"),
    );
  });
  it("defaultWorkspaceFor is <base>/<sessionId>", () => {
    expect(defaultWorkspaceFor("/home/u", "abc")).toBe(
      join("/home/u", ".herta", "workspaces", "abc"),
    );
  });
  it("effective = latest workspace_set when present", () => {
    expect(
      resolveEffectiveWorkspace(
        {
          version: 1,
          sessionId: "a",
          startedAt: "t",
          workspaceRoot: "/r",
          backendWorkspace: "/b",
        },
        "/latest",
      ),
    ).toBe("/latest");
  });
  it("effective = header.backendWorkspace when no workspace_set", () => {
    expect(
      resolveEffectiveWorkspace({
        version: 1,
        sessionId: "a",
        startedAt: "t",
        workspaceRoot: "/r",
        backendWorkspace: "/b",
      }),
    ).toBe("/b");
  });
  it("effective falls back to workspaceRoot for legacy sessions", () => {
    expect(
      resolveEffectiveWorkspace({
        version: 1,
        sessionId: "a",
        startedAt: "t",
        workspaceRoot: "/r",
      }),
    ).toBe("/r");
  });

  it("narrative/dream dirs: zh keeps the original path, en gets a parallel one", () => {
    // zh MUST stay `.herta/narrative` / `.herta/dream` — existing corpora don't
    // migrate; a change here silently orphans every prior dream.
    expect(narrativeDirFor("/w", "zh")).toBe(join("/w", ".herta", "narrative"));
    expect(dreamDirFor("/w", "zh")).toBe(join("/w", ".herta", "dream"));
    // en is isolated so the two corpora never mix registers.
    expect(narrativeDirFor("/w", "en")).toBe(
      join("/w", ".herta", "narrative-en"),
    );
    expect(dreamDirFor("/w", "en")).toBe(join("/w", ".herta", "dream-en"));
  });
});
