import type {
  HertaTool,
  ToolCallRequest,
  ToolContext,
  ToolResult,
  ToolSchema,
} from "@herta/core";
import { errResult } from "../errors.js";
import { type GitDiffFile, parseDiffStatZ } from "../git/parse-diff-stat.js";
import { scopedRepoPath, workspaceGitPrefix } from "../git/repo-probe.js";
import { hardenedGitArgs, spawnGit } from "../git/spawn-git.js";
import { formatInputIssues } from "../input-issues.js";
import { gitDiffInputSchema, gitDiffJsonSchema } from "./schema.js";

export type { GitDiffFile } from "../git/parse-diff-stat.js";
export type { GitDiffInput } from "./schema.js";

/** git's empty tree — the well-known hash of a tree with no entries, which is
 *  what "before the first commit" means to `git diff`. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export interface GitDiffData {
  mode: "working-tree" | "staged" | "ref" | "base";
  ref?: string;
  /** The requested base branch (mode "base"). */
  base?: string;
  /** The resolved merge-base commit id (mode "base") — returned so the
   *  answer is checkable (ADR 0049 §3 / PHILOSOPHY §9). */
  mergeBase?: string;
  files: readonly GitDiffFile[];
  totalAdditions: number;
  totalDeletions: number;
  empty: boolean;
  /** Unified diff text, present when the call asked `{patch: true}`. */
  patch?: string;
  /** The patch was cut at a cap — what's here is a PREFIX, and a caller
   *  quoting it must say so. */
  patchTruncated?: boolean;
}

/** Hard cap on the returned patch text. The transcript layer already
 *  persists oversized results (preview + path, ADR 0025 slice 2); this cap
 *  keeps the in-memory result/event from carrying megabytes. */
const MAX_PATCH_CHARS = 200_000;

export function gitDiffTool(
  scope: { workspaceOnly?: boolean } = {},
): HertaTool {
  return {
    name: "git_diff",
    readOnly: true,
    schema(): ToolSchema {
      return {
        name: "git_diff",
        description:
          'Return a structured per-file diff summary: exact added/deleted line counts and full repo-relative paths. Modes (mutually exclusive): default = working tree vs HEAD; { staged: true } = staged only; { ref } = vs that commit (two-dot — includes changes the REF itself accumulated, so on a feature branch { ref: "main" } is usually the wrong question); { base: "main" } = what THIS branch changed since it forked from base (merge-base semantics; the remote-tracking origin/<base> is preferred over a possibly-stale local branch, and the result carries the resolved mergeBase commit id). Add { patch: true } to include the unified diff text (bounded; patchTruncated flags a cut). Read-only.',
        inputSchema: gitDiffJsonSchema,
      };
    },
    async run(
      call: ToolCallRequest,
      ctx: ToolContext,
    ): Promise<ToolResult<GitDiffData>> {
      const parsed = gitDiffInputSchema.safeParse(call.input);
      if (!parsed.success) {
        return errResult(
          "invalid_input",
          formatInputIssues(parsed.error),
          "usage: {} or {staged: true} or {ref} or {base} (mutually exclusive), optionally {patch: true}",
          "invalid input",
        );
      }
      const input = parsed.data;

      // `--numstat -z` rather than `--stat`: real counts and full paths (see
      // parseDiffStatZ). `--no-ext-diff` / `--no-textconv` stop a REPOSITORY's
      // own config turning this read-only tool into a program launcher, and
      // the trailing `--` ends the revision list so nothing after it can be
      // read as an option.
      const base = [
        "diff",
        "--numstat",
        "-z",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        ...(scope.workspaceOnly ? ["--no-renames"] : []),
      ];
      let mode: GitDiffData["mode"];
      let argv: string[];
      let mergeBase: string | undefined;
      if (input.staged === true) {
        mode = "staged";
        argv = [...base, "--cached", "--"];
      } else if (input.base !== undefined) {
        // Merge-base semantics (ADR 0049 §3): "what did THIS branch change"
        // is a diff against the fork point, not against the base branch's
        // tip — a two-dot compare answers the inverted question on any
        // branch whose base has moved. The remote-tracking ref is preferred
        // over the local branch, which may be stale and inflate the answer.
        mode = "base";
        const remoteRef = `refs/remotes/origin/${input.base}`;
        const remote = await spawnGit(
          ctx.workspaceRoot,
          hardenedGitArgs(["rev-parse", "--verify", "--quiet", remoteRef]),
          ctx.signal,
          { allowExitCodes: [1] },
        );
        const remoteExists =
          remote.ok && remote.exitCode === 0 && remote.stdout.trim().length > 0;
        // Exit 1 = no common ancestor, which for the remote candidate falls
        // back to the local name; for the final candidate it is an honest
        // "these histories never met".
        let mb = remoteExists
          ? await spawnGit(
              ctx.workspaceRoot,
              hardenedGitArgs(["merge-base", "HEAD", remoteRef]),
              ctx.signal,
              { allowExitCodes: [1] },
            )
          : null;
        if (mb === null || !mb.ok || mb.exitCode !== 0) {
          mb = await spawnGit(
            ctx.workspaceRoot,
            hardenedGitArgs(["merge-base", "HEAD", input.base]),
            ctx.signal,
            { allowExitCodes: [1] },
          );
        }
        if (!mb.ok) {
          if (mb.code === "not_a_repo") {
            return errResult(
              "not_a_repo",
              mb.message,
              "this workspace is not a git repository — git tools are unavailable",
              "not a git repo",
            );
          }
          return errResult("git_failed", mb.message, undefined, "git failed");
        }
        if (mb.exitCode !== 0 || mb.stdout.trim().length === 0) {
          return errResult(
            "git_failed",
            `no merge base between HEAD and ${input.base}`,
            "the two histories share no common ancestor — if you really mean a plain compare against that commit, use { ref } instead",
            "no merge base",
          );
        }
        mergeBase = mb.stdout.trim();
        argv = [...base, mergeBase, "--"];
      } else if (input.ref !== undefined) {
        mode = "ref";
        argv = [...base, input.ref, "--"];
      } else {
        mode = "working-tree";
        // Before the first commit `HEAD` does not resolve, and diffing against
        // it fails with "bad revision" — so a freshly initialised project, the
        // state a coding agent most often starts a repository in, answered
        // "git failed" while `git_status` and the staged diff both worked.
        // git's empty-tree object is what `HEAD` would mean if it existed.
        const born = await spawnGit(
          ctx.workspaceRoot,
          hardenedGitArgs(["rev-parse", "--verify", "--quiet", "HEAD"]),
          ctx.signal,
          { allowExitCodes: [1] },
        );
        const unborn = born.ok && born.stdout.trim().length === 0;
        argv = [...base, unborn ? EMPTY_TREE : "HEAD", "--"];
      }

      const r = await spawnGit(
        ctx.workspaceRoot,
        hardenedGitArgs(scope.workspaceOnly ? [...argv, "."] : argv),
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
          // Say which failure it was. Overriding this with a blanket "git is
          // not on PATH" told a user whose workspace drive had vanished to
          // install software they already had.
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

      const stat = parseDiffStatZ(r.stdout);
      let files = stat.files;
      if (scope.workspaceOnly) {
        const prefix = await workspaceGitPrefix(ctx.workspaceRoot, ctx.signal);
        if (prefix === null)
          return errResult(
            "git_failed",
            "Cannot determine selected workspace Git prefix",
            undefined,
            "git scope unknown",
          );
        files = files.flatMap((file) => {
          const path = scopedRepoPath(file.path, prefix);
          return path === null ? [] : [{ ...file, path }];
        });
      }

      // Hunks on demand (ADR 0049 §3): a second spawn with --patch in place
      // of --numstat, same hardening, same target. Separate on purpose —
      // the counts stay O(files) even when the patch is enormous, and the
      // patch is only paid for when asked.
      let patch: string | undefined;
      let patchTruncated = false;
      if (input.patch === true && stat.files.length > 0) {
        const patchArgv = argv.map((a) => (a === "--numstat" ? "--patch" : a));
        const p = await spawnGit(
          ctx.workspaceRoot,
          hardenedGitArgs(
            scope.workspaceOnly ? [...patchArgv, "."] : patchArgv,
          ),
          ctx.signal,
        );
        if (p.ok) {
          patch = p.stdout;
          patchTruncated = p.truncated;
          if (patch.length > MAX_PATCH_CHARS) {
            patch = patch.slice(0, MAX_PATCH_CHARS);
            patchTruncated = true;
          }
        }
        // A failed patch spawn degrades to the counts-only answer rather
        // than failing the call the counts already answered.
      }

      const data: GitDiffData = {
        mode,
        ...(mode === "ref" && input.ref !== undefined
          ? { ref: input.ref }
          : {}),
        ...(mode === "base" && input.base !== undefined
          ? { base: input.base }
          : {}),
        ...(mergeBase !== undefined ? { mergeBase } : {}),
        files,
        totalAdditions: files.reduce((sum, file) => sum + file.additions, 0),
        totalDeletions: files.reduce((sum, file) => sum + file.deletions, 0),
        empty: files.length === 0,
        ...(patch !== undefined ? { patch } : {}),
        ...(patch !== undefined && patchTruncated ? { patchTruncated } : {}),
      };
      const summary = data.empty
        ? "no diff"
        : `${data.files.length} files, +${data.totalAdditions}/-${data.totalDeletions}${
            mergeBase !== undefined
              ? ` (since merge-base ${mergeBase.slice(0, 7)})`
              : ""
          }${patchTruncated ? " (patch truncated)" : ""}`;
      return { ok: true, data, summary };
    },
  };
}
