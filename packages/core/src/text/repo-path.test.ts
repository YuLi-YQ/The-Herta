import { describe, expect, it } from "vitest";
import {
  repoPathInsideWorkspace,
  workspaceRelativeRepoPath,
} from "./repo-path.js";

describe("workspaceRelativeRepoPath (ADR 0058 amendment — subfolder workspaces)", () => {
  it("leaves paths alone when the workspace is the repository root", () => {
    expect(workspaceRelativeRepoPath("packages/gui/src/a.ts", "")).toBe(
      "packages/gui/src/a.ts",
    );
  });

  it("strips the workspace's own prefix", () => {
    expect(
      workspaceRelativeRepoPath("packages/gui/src/a.ts", "packages/gui/"),
    ).toBe("src/a.ts");
  });

  it("climbs out for a path beside or above the workspace", () => {
    expect(
      workspaceRelativeRepoPath("packages/core/src/b.ts", "packages/gui/"),
    ).toBe("../core/src/b.ts");
    expect(workspaceRelativeRepoPath("README.md", "packages/gui/")).toBe(
      "../../README.md",
    );
    expect(workspaceRelativeRepoPath("docs/x.md", "a/b/c/")).toBe(
      "../../../docs/x.md",
    );
  });

  it("does not mistake a sibling whose name shares the prefix's start", () => {
    // `packages/gui-next/…` is NOT under `packages/gui/`.
    expect(
      workspaceRelativeRepoPath("packages/gui-next/x.ts", "packages/gui/"),
    ).toBe("../gui-next/x.ts");
  });
});

describe("repoPathInsideWorkspace", () => {
  it("answers by prefix, root included", () => {
    expect(repoPathInsideWorkspace("anything", "")).toBe(true);
    expect(repoPathInsideWorkspace("packages/gui/x.ts", "packages/gui/")).toBe(
      true,
    );
    expect(repoPathInsideWorkspace("packages/core/x.ts", "packages/gui/")).toBe(
      false,
    );
    expect(
      repoPathInsideWorkspace("packages/gui-next/x", "packages/gui/"),
    ).toBe(false);
  });
});
