import { readFile } from "node:fs/promises";
import { homedir as osHomedir } from "node:os";
import { join } from "node:path";
import { ProviderError } from "../errors.js";

export interface ResolveOpts {
  cwd?: string;
  homedir?: string;
}

/** Resolve the key from env → legacy files, or null if none is found. Used by
 *  the GUI bootstrap, which checks its own secure store between env and the
 *  legacy files and tolerates a missing key (no throw). */
export async function resolveDeepSeekKeyOrNull(
  opts: ResolveOpts = {},
): Promise<string | null> {
  const fromEnv = process.env.DEEPSEEK_API_KEY?.trim();
  if (fromEnv && fromEnv.length > 0) return fromEnv;

  const cwd = opts.cwd ?? process.cwd();
  const home = opts.homedir ?? osHomedir();

  const fromRepo = await readTrim(join(cwd, "deepseek-api-key.txt"));
  if (fromRepo !== undefined) return fromRepo;

  const fromHome = await readTrim(join(home, ".herta", "keys", "deepseek"));
  if (fromHome !== undefined) return fromHome;

  return null;
}

export async function resolveDeepSeekKey(
  opts: ResolveOpts = {},
): Promise<string> {
  const key = await resolveDeepSeekKeyOrNull(opts);
  if (key !== null) return key;
  throw new ProviderError({
    code: "missing-key",
    retryable: false,
    message:
      "DeepSeek API key not found. Set DEEPSEEK_API_KEY, or place the key in ./deepseek-api-key.txt or ~/.herta/keys/deepseek.",
  });
}

async function readTrim(path: string): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
