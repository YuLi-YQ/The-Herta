import { join } from "node:path";

export const DEFAULT_DB_RELATIVE = ".herta/knowledge/herta-canon.sqlite";
export const DEFAULT_REVIEW_DIR_RELATIVE = ".herta/knowledge/review";
export const DEFAULT_DATA_DIR_RELATIVE = "data";
export const REVIEW_AMBIGUOUS_FILENAME = "ambiguous-herta-mentions.jsonl";
export const OVERRIDES_FILENAME = "overrides.jsonl";

export function defaultDbPath(workspaceRoot: string): string {
  return join(workspaceRoot, DEFAULT_DB_RELATIVE);
}
export function defaultReviewDir(workspaceRoot: string): string {
  return join(workspaceRoot, DEFAULT_REVIEW_DIR_RELATIVE);
}
export function defaultDataDir(workspaceRoot: string): string {
  return join(workspaceRoot, DEFAULT_DATA_DIR_RELATIVE);
}

export const DEEPSEEK_KEY_ENV = "HERTA_DEEPSEEK_API_KEY";
export const DEEPSEEK_KEY_FILENAME = "deepseek-api-key";
export const DEFAULT_SECRETS_DIR_RELATIVE = ".herta/secrets";

export function defaultDeepSeekKeyFile(workspaceRoot: string): string {
  return join(
    workspaceRoot,
    DEFAULT_SECRETS_DIR_RELATIVE,
    DEEPSEEK_KEY_FILENAME,
  );
}
