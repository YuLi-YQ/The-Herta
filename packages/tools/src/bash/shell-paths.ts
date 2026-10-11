import { execFile, spawnSync } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";

/**
 * How the shell spells paths vs how Node does (ADR 0040).
 *
 * On POSIX the two agree. Under Git for Windows' MSYS bash the shell shows
 * `/e/repo/src`, `/c/Users/…`, and maps `%TEMP%` to `/tmp` — and the model
 * copies exactly what `pwd`/`ls` printed into `str_replace_editor.path`,
 * so the editor must understand every spelling the shell produced. The
 * probe asks the shell itself (`cygpath`) once per bash binary and caches.
 */
export interface ShellPaths {
  /** Native (Node) absolute path for a shell-spelled or native path; null
   *  when the text is not an absolute path in either spelling. */
  toNative(p: string): string | null;
  /** How the shell would spell a native absolute path. */
  toShell(nativeAbs: string): string;
  /** True when a shell-side `/tmp` exists as a distinct native directory. */
  readonly tmpNative: string | null;
}

const IDENTITY: ShellPaths = {
  toNative: (p) => (isAbsolute(p) ? resolve(p) : null),
  toShell: (p) => p,
  tmpNative: null,
};

const cache = new Map<string, ShellPaths>();
const priming = new Map<string, Promise<void>>();

const PROBE_ARGS = ["--noprofile", "--norc", "-c", "cygpath -w /tmp"];
const PROBE_TIMEOUT_MS = 10_000;

function tmpFromProbe(ok: boolean, stdout: string): string | null {
  const out = stdout.trim().split(/\r?\n/)[0] ?? "";
  return ok && /^[A-Za-z]:\\/.test(out) ? resolve(out) : null;
}

/** Probe once per bash binary; identity mapping on POSIX or when the probe
 *  fails (then only native absolute paths are understood — still correct,
 *  just less forgiving).
 *
 *  Synchronous, because its callers are (tool construction, the permission
 *  rules, a record header). An async caller that can afford to should
 *  `primeShellPaths` first: this probe then finds its answer cached and
 *  spawns nothing. */
export function shellPathsFor(bashPath: string | null): ShellPaths {
  if (process.platform !== "win32" || bashPath === null) return IDENTITY;
  const cached = cache.get(bashPath);
  if (cached !== undefined) return cached;
  let tmpNative: string | null = null;
  try {
    const r = spawnSync(bashPath, PROBE_ARGS, {
      encoding: "utf8",
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    tmpNative = tmpFromProbe(r.status === 0, r.stdout ?? "");
  } catch {
    tmpNative = null;
  }
  const paths = makeMsysPaths(tmpNative);
  cache.set(bashPath, paths);
  return paths;
}

/**
 * The same probe without blocking the thread: fills the cache
 * `shellPathsFor` reads. The synchronous probe ran inside the (synchronous)
 * backend bootstrap — on the desktop app's main thread, a whole bash start
 * at the first session create or open (perf audit 2026-09-20). Never
 * rejects; concurrent calls share one probe; a no-op on POSIX, without a
 * bash, or once the answer is known.
 */
export function primeShellPaths(bashPath: string | null): Promise<void> {
  if (process.platform !== "win32" || bashPath === null)
    return Promise.resolve();
  if (cache.has(bashPath)) return Promise.resolve();
  const inFlight = priming.get(bashPath);
  if (inFlight !== undefined) return inFlight;
  const p = new Promise<void>((settled) => {
    const done = (tmpNative: string | null): void => {
      // A synchronous probe may have answered meanwhile — first one wins,
      // so nobody ever holds a mapping that later changes under them.
      if (!cache.has(bashPath)) cache.set(bashPath, makeMsysPaths(tmpNative));
      priming.delete(bashPath);
      settled();
    };
    try {
      execFile(
        bashPath,
        PROBE_ARGS,
        { encoding: "utf8", timeout: PROBE_TIMEOUT_MS, windowsHide: true },
        (err, stdout) => done(tmpFromProbe(err === null, stdout)),
      );
    } catch {
      done(null);
    }
  });
  priming.set(bashPath, p);
  return p;
}

/** Exposed for tests: an MSYS mapping with a known /tmp. */
export function makeMsysPaths(tmpNative: string | null): ShellPaths {
  return {
    tmpNative,
    toNative(p: string): string | null {
      const s = String(p).trim();
      let m = /^\/([A-Za-z])(\/.*)?$/.exec(s);
      if (m) {
        return resolve(
          `${(m[1] as string).toUpperCase()}:${(m[2] ?? "/").replace(/\//g, "\\")}`,
        );
      }
      m = /^\/cygdrive\/([A-Za-z])(\/.*)?$/.exec(s);
      if (m) {
        return resolve(
          `${(m[1] as string).toUpperCase()}:${(m[2] ?? "/").replace(/\//g, "\\")}`,
        );
      }
      m = /^\/tmp(\/.*)?$/.exec(s);
      if (m && tmpNative !== null) {
        return resolve(
          join(tmpNative, ...(m[1] ?? "").split("/").filter(Boolean)),
        );
      }
      if (/^[A-Za-z]:[\\/]/.test(s)) return resolve(s);
      // A bare `/x` root form is ambiguous on Windows (`/usr/bin`, `/etc`
      // are MSYS-internal); not a workspace path either way.
      return null;
    },
    toShell(nativeAbs: string): string {
      const win = resolve(nativeAbs).replace(/\\/g, "/");
      if (tmpNative !== null) {
        const tmp = resolve(tmpNative).replace(/\\/g, "/");
        if (
          win.toLowerCase() === tmp.toLowerCase() ||
          win.toLowerCase().startsWith(`${tmp.toLowerCase()}/`)
        ) {
          return `/tmp${win.slice(tmp.length)}`;
        }
      }
      return win.replace(
        /^([A-Za-z]):/,
        (_, d: string) => `/${d.toLowerCase()}`,
      );
    },
  };
}
