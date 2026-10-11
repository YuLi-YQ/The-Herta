import { readFile } from "node:fs/promises";
import { isMissingFsError } from "../fs-utils.js";
import { DEEPSEEK_KEY_ENV, defaultDeepSeekKeyFile } from "../paths.js";

export interface ResolveKeyOptions {
  workspaceRoot: string;
  keyFile?: string;
}

export type ResolvedKey = { key: string } | { missing: true };

export async function resolveDeepSeekApiKey(
  opts: ResolveKeyOptions,
): Promise<ResolvedKey> {
  if (opts.keyFile !== undefined) {
    const fromFile = await readKeyFile(opts.keyFile);
    if (fromFile !== undefined) return { key: fromFile };
    return { missing: true };
  }

  const fromEnv = process.env[DEEPSEEK_KEY_ENV]?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) return { key: fromEnv };

  const fromDefault = await readKeyFile(
    defaultDeepSeekKeyFile(opts.workspaceRoot),
  );
  if (fromDefault !== undefined) return { key: fromDefault };

  return { missing: true };
}

async function readKeyFile(path: string): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (isMissingFsError(err)) return undefined;
    throw err;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed;
}
