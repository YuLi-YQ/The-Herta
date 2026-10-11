import type {
  HertaTool,
  ToolCallRequest,
  ToolContext,
  ToolResult,
  ToolSchema,
} from "@herta/core";
import { errResult } from "../errors.js";
import {
  type GitStatusData,
  parseStatusPorcelainZ,
} from "../git/parse-status.js";
import { scopedRepoPath, workspaceGitPrefix } from "../git/repo-probe.js";
import { hardenedGitArgs, spawnGit } from "../git/spawn-git.js";
import { formatInputIssues } from "../input-issues.js";
import { gitStatusInputSchema, gitStatusJsonSchema } from "./schema.js";

export type { GitStatusData, GitStatusFile } from "../git/parse-status.js";
export type { GitStatusInput } from "./schema.js";

export function gitStatusTool(
  scope: { workspaceOnly?: boolean } = {},
): HertaTool {
  return {
    name: "git_status",
    readOnly: true,
    schema(): ToolSchema {
      return {
        name: "git_status",
        description:
          "Return structured git working-tree status: branch + ahead/behind + per-file index/worktree status. Read-only.",
        inputSchema: gitStatusJsonSchema,
      };
    },
    async run(
      call: ToolCallRequest,
      ctx: ToolContext,
    ): Promise<ToolResult<GitStatusData>> {
      const parsed = gitStatusInputSchema.safeParse(call.input);
      if (!parsed.success) {
        return errResult(
          "invalid_input",
          formatInputIssues(parsed.error),
          "usage: {} — git_status takes no arguments",
          "invalid input",
        );
      }

      const r = await spawnGit(
        ctx.workspaceRoot,
        hardenedGitArgs([
          "status",
          "--porcelain=v1",
          "-z",
          "--branch",
          "--untracked-files=all",
          ...(scope.workspaceOnly ? ["--no-renames", "--", "."] : []),
        ]),
        ctx.signal,
      );
      if (!r.ok) {
        if (r.code === "not_a_repo") {
          return errResult(
            "not_a_repo",
            r.message,
            "this workspace is not a git repository — git tools are unavailable",
            "not a git repo",
          );
        }
        if (r.code === "git_timeout") {
          return errResult(
            "git_timeout",
            r.message,
            undefined,
            "git timed out",
          );
        }
        if (r.code === "spawn_failed") {
          return errResult(
            "spawn_failed",
            r.message,
            r.cause === "git_not_found"
              ? "install git, or add it to PATH, and restart"
              : r.cause === "workspace_missing"
                ? "the workspace path is gone — reopen the project"
                : undefined,
            "spawn failed",
          );
        }
        return errResult("git_failed", r.message, undefined, "git failed");
      }

      const data = parseStatusPorcelainZ(r.stdout);
      if (scope.workspaceOnly) {
        const prefix = await workspaceGitPrefix(ctx.workspaceRoot, ctx.signal);
        if (prefix === null)
          return errResult(
            "git_failed",
            "Cannot determine selected workspace Git prefix",
            undefined,
            "git scope unknown",
          );
        data.files = data.files.flatMap((file) => {
          const path = scopedRepoPath(file.path, prefix);
          return path === null ? [] : [{ ...file, path }];
        });
        data.clean = data.files.length === 0;
      }
      const summary = data.clean ? "clean" : `${data.files.length} changed`;
      return { ok: true, data, summary };
    },
  };
}
