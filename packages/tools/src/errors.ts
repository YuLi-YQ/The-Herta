import type { ToolResult } from "@herta/core";

/**
 * The one failed-`ToolResult` constructor. Five tools (edit_file,
 * write_new_file, run_command, git_status, git_diff) each carried a private
 * `errResult` with a slightly different positional shape until 2026-08-19
 * (ADR 0041 follow-up); this is the union of them: `suggestion` and
 * `summary` optional (summary defaults to `failed: <code>`), `retryable`
 * last and false by default. `suggestion` is included only when given so
 * the result shape is identical to the tools' hand-built objects.
 */
export function errResult<T = unknown>(
  code: string,
  message: string,
  suggestion?: string,
  summary: string = `failed: ${code}`,
  retryable = false,
): ToolResult<T> {
  return {
    ok: false,
    error: { code, message, retryable },
    ...(suggestion !== undefined ? { suggestion } : {}),
    summary,
  };
}

export type ToolErrorCode =
  | "path_denied"
  | "path_outside_workspace"
  | "not_found"
  | "file_too_large"
  | "binary_file"
  | "invalid_input"
  | "invalid_pattern"
  | "read_failed"
  | "empty_pattern"
  | "read_required"
  | "stale_read"
  | "parse_failed"
  | "hunk_not_found"
  | "hunk_ambiguous"
  | "hunk_overlap"
  | "write_failed"
  | "command_blocked"
  | "timeout"
  | "spawn_failed"
  | "file_exists"
  | "parent_invalid"
  | "plan_invalid"
  | "unknown_plan_item"
  | "git_failed"
  | "git_timeout"
  | "non_utf8_file"
  | "not_a_repo";

export const TOOL_ERROR_CODES: readonly ToolErrorCode[] = [
  "path_denied",
  "path_outside_workspace",
  "not_found",
  "file_too_large",
  "binary_file",
  "invalid_input",
  "invalid_pattern",
  "read_failed",
  "empty_pattern",
  "read_required",
  "stale_read",
  "parse_failed",
  "hunk_not_found",
  "hunk_ambiguous",
  "hunk_overlap",
  "write_failed",
  "command_blocked",
  "timeout",
  "spawn_failed",
  "file_exists",
  "parent_invalid",
  "plan_invalid",
  "unknown_plan_item",
  "git_failed",
  "git_timeout",
  "non_utf8_file",
  "not_a_repo",
] as const;
