import { existsSync, realpathSync, statSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

const FLAG = "--herta-verification";
const PROFILE = "--herta-test-profile=";

function canonical(path: string): string {
  let ancestor = resolve(path);
  const suffix: string[] = [];
  while (!existsSync(ancestor)) {
    suffix.unshift(basename(ancestor));
    const parent = dirname(ancestor);
    if (parent === ancestor)
      throw new Error("Verification profile has no existing ancestor");
    ancestor = parent;
  }
  if (!statSync(ancestor).isDirectory())
    throw new Error("Verification profile must be a directory");
  return join(realpathSync.native(ancestor), ...suffix);
}

function contains(parent: string, child: string): boolean {
  const remainder = relative(parent, child);
  return (
    remainder === "" || (!remainder.startsWith("..") && !isAbsolute(remainder))
  );
}

/** Explicit CLI-only verification identity. No environment fallback and no writes. */
export function verificationProfile(
  argv: readonly string[],
  personalUserData: string,
): string | null {
  const relevant = argv.filter(
    (arg) => arg.startsWith(FLAG) || arg.startsWith("--herta-test-profile"),
  );
  if (relevant.length === 0) return null;
  if (relevant.length !== 2 || !relevant.includes(FLAG))
    throw new Error(
      "Verification requires one explicit flag and one absolute test profile",
    );
  const option = relevant.find((arg) => arg.startsWith(PROFILE));
  const value = option?.slice(PROFILE.length);
  if (
    !value ||
    !isAbsolute(value) ||
    value.includes("\0") ||
    /^\\\\|^\/\//.test(value)
  )
    throw new Error("Verification profile must be an absolute local path");
  if (process.platform === "win32") {
    // Reject alternate streams, device names and Win32 trailing-dot/space
    // aliases before canonicalizing a not-yet-created destination.
    const segments = value.slice(3).split(/[\\/]/);
    if (
      !/^[A-Za-z]:[\\/]/.test(value) ||
      segments.some(
        (segment) =>
          /[:<>"|?*]/.test(segment) ||
          (/[. ]$/.test(segment) && segment !== "." && segment !== "..") ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment),
      )
    )
      throw new Error(
        "Verification profile contains an unsafe Windows path segment",
      );
  }
  const target = canonical(value);
  const personal = canonical(personalUserData);
  if (contains(personal, target) || contains(target, personal))
    throw new Error(
      "Verification profile must be separate from personal userData",
    );
  return target;
}
