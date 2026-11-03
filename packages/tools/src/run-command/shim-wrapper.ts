import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * Windows .cmd shim wrapper (ADR 0025 slice 4). npm/pnpm/npx/yarn/
 * corepack are .cmd batch shims on Windows; `spawn(..., {shell:false})`
 * can't run them (Node refuses .cmd without a shell since
 * CVE-2024-27980), so every lab so far saw `binary not found: npm`.
 *
 * This wrapper is deliberately narrow, and it does NOT reopen the
 * 2026-07-10 audit finding 3 (the "wrap it in cmd /c" steering):
 *
 *   - The PERMISSION TIER always comes from the model's original argv
 *     ("npm install …" classifies as ask) — classification and the
 *     reader-guard run before this wrapper, which is deterministic
 *     harness code applied AFTER approval. The model never writes
 *     "cmd /c" itself; that path still re-classifies as a shell body.
 *   - Only a fixed set of well-known shim BASENAMES qualifies, resolved
 *     from PATH only (never cwd-relative, so a repo-planted npm.cmd
 *     can't hijack the name; the env guard already blocks PATH
 *     overrides).
 *   - cmd.exe re-parses its command line, so every argument must be
 *     free of cmd metacharacters — anything else is rejected with a
 *     clear error instead of risking injection through cmd's parser.
 */
const SHIM_BASENAMES = new Set(["npm", "npx", "pnpm", "yarn", "corepack"]);

/** Conservative: rejects cmd.exe metacharacters and quote/expansion
 *  syntax. Spaces are fine (node quotes them). */
const CMD_UNSAFE_ARG = /[&|<>^%!"\r\n]/;

export type ShimResolution =
  | { kind: "unwrapped"; argv: readonly string[] }
  | { kind: "wrapped"; argv: readonly string[]; windowsVerbatimArguments?: true; shimPath?: string }
  | { kind: "unsafe_args"; offending: string };

function resolveShimPath(name: string, pathVar: string): string | null {
  for (const dir of pathVar.split(delimiter)) {
    if (dir.length === 0) continue;
    for (const ext of [".cmd", ".bat"]) {
      const candidate = join(dir, `${name}${ext}`);
      try {
        if (existsSync(candidate)) return candidate;
      } catch {
        // unreadable PATH entry — skip
      }
    }
  }
  return null;
}

/** Host-only overrides keep constrained callers on the same vetted PATH used
 * for execution. Existing workbench callers retain their original behavior. */
export function resolveWindowsShim(argv: readonly string[], options?: {
  path: string;
  commandInterpreter: string;
}): ShimResolution {
  if (process.platform !== "win32") return { kind: "unwrapped", argv };
  const head = argv[0] ?? "";
  if (!SHIM_BASENAMES.has(head)) return { kind: "unwrapped", argv };

  const shimPath = resolveShimPath(head, options?.path ?? process.env.PATH ?? process.env.Path ?? "");
  if (shimPath === null) return { kind: "unwrapped", argv }; // let ENOENT report

  for (const arg of argv.slice(1)) {
    if (CMD_UNSAFE_ARG.test(arg)) {
      return { kind: "unsafe_args", offending: arg };
    }
  }
  if (CMD_UNSAFE_ARG.test(shimPath)) {
    return { kind: "unwrapped", argv }; // pathological PATH entry — refuse to wrap
  }
  if (options) {
    // cmd /s removes one surrounding quote pair. The retained inner pairs
    // quote every argument, including paths and arguments with spaces; Node
    // must not reinterpret this already-vetted command line as C argv quoting.
    const line = `"${[shimPath, ...argv.slice(1)].map(arg => `"${arg}"`).join(" ")}"`;
    return { kind: "wrapped", argv: [options.commandInterpreter, "/d", "/s", "/c", line],
      windowsVerbatimArguments: true, shimPath };
  }
  return { kind: "wrapped", argv: ["cmd", "/c", shimPath, ...argv.slice(1)] };
}
