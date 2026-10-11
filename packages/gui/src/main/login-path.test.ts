import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyLoginPath,
  launchLocaleEnv,
  mergePath,
  type ProbeMode,
  parseProbeOutput,
  probeShell,
  resolveLoginPath,
  runShellProbe,
} from "./login-path.js";

/** launchd's environment for a Finder-launched .app — the S7 starting point. */
const LAUNCHD_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
/** What a real login shell answers on a dev Mac. */
const SHELL_PATH =
  "/opt/homebrew/bin:/Users/x/.cargo/bin:/usr/bin:/bin:/usr/sbin:/sbin";
/** …and what an INTERACTIVE one adds: `.zshrc` is where nvm puts node. */
const INTERACTIVE_PATH = `/Users/x/.nvm/versions/node/v22.9.0/bin:${SHELL_PATH}`;

/** A shell's raw stdout: the markers around the PATH, rc-file noise around
 *  them, exactly as `runShellProbe` returns it. */
function shellOut(path: string, noise = ""): string {
  return `${noise}__HERTA_PATH_BEGIN__\n${path}\n__HERTA_PATH_END__\n`;
}

/** A probe answering per mode. */
function probeOf(
  answers: Partial<Record<ProbeMode, string | null>>,
): (shell: string, mode: ProbeMode) => Promise<string | null> {
  return async (_shell, mode) => answers[mode] ?? null;
}

describe("mergePath", () => {
  it("keeps base order, appends new entries, drops duplicates and blanks", () => {
    expect(mergePath("/a:/b", ["/b", "/c", "", "  "])).toBe("/a:/b:/c");
  });

  it("handles an absent base", () => {
    expect(mergePath(undefined, ["/opt/homebrew/bin"])).toBe(
      "/opt/homebrew/bin",
    );
  });
});

describe("parseProbeOutput", () => {
  it("reads the PATH between the markers, whatever an rc file printed around them", () => {
    expect(
      parseProbeOutput(
        shellOut(SHELL_PATH, "Last login: Tue\n[oh-my-zsh] update? [Y/n]\n"),
      ),
    ).toBe(SHELL_PATH);
  });

  it("is null when the markers are missing or broken — never a guessed PATH", () => {
    expect(parseProbeOutput(SHELL_PATH)).toBeNull();
    expect(parseProbeOutput("__HERTA_PATH_BEGIN__\n/a\n")).toBeNull();
    expect(
      parseProbeOutput("__HERTA_PATH_BEGIN__\n\n__HERTA_PATH_END__\n"),
    ).toBeNull();
  });
});

describe("probeShell", () => {
  it("asks the user's own shell when it speaks the probe's syntax", () => {
    expect(probeShell({ SHELL: "/opt/homebrew/bin/fish" })).toBe(
      "/opt/homebrew/bin/fish",
    );
    expect(probeShell({ SHELL: "/bin/bash" })).toBe("/bin/bash");
  });

  it("asks the platform's default shell for a shell with another syntax, or none", () => {
    expect(probeShell({ SHELL: "/opt/homebrew/bin/nu" })).toBe("/bin/zsh");
    expect(probeShell({ SHELL: "/bin/tcsh" })).toBe("/bin/zsh");
    expect(probeShell({})).toBe("/bin/zsh");
    expect(probeShell({ SHELL: "/usr/bin/nu" }, "linux")).toBe("/bin/bash");
    expect(probeShell({}, "linux")).toBe("/bin/bash");
  });
});

describe("resolveLoginPath", () => {
  it("recovers the login shell's PATH for a Finder-launched .app", async () => {
    const got = await resolveLoginPath({
      platform: "darwin",
      env: { PATH: LAUNCHD_PATH, SHELL: "/bin/zsh" },
      probe: probeOf({ login: shellOut(SHELL_PATH) }),
    });
    expect(got).not.toBeNull();
    // The tools that were unreachable are now on it…
    expect(got).toContain("/opt/homebrew/bin");
    expect(got).toContain("/Users/x/.cargo/bin");
    // …and the system entries are still there, exactly once.
    expect(got?.split(":").filter((p) => p === "/usr/bin")).toHaveLength(1);
  });

  it("puts the shell's order first, so Homebrew's python3 wins over Apple's (2026-09-23)", async () => {
    const got = await resolveLoginPath({
      platform: "darwin",
      env: { PATH: LAUNCHD_PATH, SHELL: "/bin/zsh" },
      probe: probeOf({ login: shellOut(SHELL_PATH) }),
    });
    const entries = got?.split(":") ?? [];
    expect(entries.indexOf("/opt/homebrew/bin")).toBeLessThan(
      entries.indexOf("/usr/bin"),
    );
    // Exactly the shell's PATH, then the Homebrew prefix it lacked.
    expect(got).toBe(`${SHELL_PATH}:/usr/local/bin`);
  });

  it("prefers the interactive answer — `.zshrc` is where nvm, fnm and conda put their tools (2026-09-23)", async () => {
    const got = await resolveLoginPath({
      platform: "darwin",
      env: { PATH: LAUNCHD_PATH, SHELL: "/bin/zsh" },
      probe: probeOf({
        interactive: shellOut(INTERACTIVE_PATH, "p10k instant prompt\n"),
        login: shellOut(SHELL_PATH),
      }),
    });
    expect(got?.split(":")[0]).toBe("/Users/x/.nvm/versions/node/v22.9.0/bin");
  });

  it("falls back to the login answer when the interactive shell hangs or exits early", async () => {
    const got = await resolveLoginPath({
      platform: "darwin",
      env: { PATH: LAUNCHD_PATH, SHELL: "/bin/zsh" },
      probe: probeOf({ interactive: null, login: shellOut(SHELL_PATH) }),
    });
    expect(got).toBe(`${SHELL_PATH}:/usr/local/bin`);
    // An interactive shell that `exec`s into another one prints no markers.
    const execd = await resolveLoginPath({
      platform: "darwin",
      env: { PATH: LAUNCHD_PATH, SHELL: "/bin/zsh" },
      probe: probeOf({
        interactive: "Welcome to fish!\n",
        login: shellOut(SHELL_PATH),
      }),
    });
    expect(execd).toBe(`${SHELL_PATH}:/usr/local/bin`);
  });

  it("does nothing on Windows (ADR 0044 has its own repair)", async () => {
    expect(
      await resolveLoginPath({
        platform: "win32",
        env: { PATH: "C:\\Windows" },
        probe: async () => "should-not-be-called",
      }),
    ).toBeNull();
  });

  it("Linux: a desktop launch gets `.bashrc`'s tools, the shell's order first and the AppImage's own entries last (2026-09-23)", async () => {
    // What AppRun + a GNOME session hand the app: the AppImage's dirs first,
    // then the session PATH `.profile` built — no nvm, no cargo.
    const session =
      "/tmp/.mount_Herta/:/tmp/.mount_Herta/usr/sbin:/usr/local/bin:/usr/bin:/bin";
    const shellPath =
      "/home/u/.nvm/versions/node/v22/bin:/home/u/.cargo/bin:/usr/local/bin:/usr/bin:/bin";
    let asked = "";
    const got = await resolveLoginPath({
      platform: "linux",
      env: { PATH: session, SHELL: "/bin/bash" },
      probe: async (shell, mode) => {
        asked = shell;
        return mode === "interactive" ? shellOut(shellPath) : null;
      },
    });
    expect(asked).toBe("/bin/bash");
    expect(got).toBe(
      `${shellPath}:/tmp/.mount_Herta/:/tmp/.mount_Herta/usr/sbin`,
    );
  });

  it("Linux: leaves the session PATH alone when no shell answers — there is no well-known prefix to guess", async () => {
    expect(
      await resolveLoginPath({
        platform: "linux",
        env: { PATH: "/usr/bin:/bin", SHELL: "/bin/bash" },
        probe: async () => null,
      }),
    ).toBeNull();
  });

  it("does nothing when started from a terminal (stdin is a TTY), on either platform", async () => {
    for (const platform of ["linux", "darwin"] as const) {
      expect(
        await resolveLoginPath({
          platform,
          env: { PATH: LAUNCHD_PATH, SHELL: "/bin/bash" },
          launchedFromTerminal: true,
          probe: async () => {
            throw new Error("probe must not run from a terminal");
          },
        }),
      ).toBeNull();
    }
  });

  it("does nothing when launched from a terminal (PATH already real)", async () => {
    // The common case for a developer running the dev build — must not churn
    // the environment underneath a working setup.
    expect(
      await resolveLoginPath({
        platform: "darwin",
        env: { PATH: SHELL_PATH, SHELL: "/bin/zsh" },
        probe: async () => {
          throw new Error("probe must not run when PATH is already populated");
        },
      }),
    ).toBeNull();
  });

  it("still adds the Homebrew fallbacks — ahead of /usr/bin — when no shell answers", async () => {
    // A broken/hanging rc file must not leave the app with launchd's PATH.
    const got = await resolveLoginPath({
      platform: "darwin",
      env: { PATH: LAUNCHD_PATH, SHELL: "/bin/zsh" },
      probe: async () => null,
    });
    const entries = got?.split(":") ?? [];
    expect(entries).toContain("/opt/homebrew/bin");
    expect(entries).toContain("/usr/local/bin");
    expect(entries).toContain("/usr/bin");
    expect(entries.indexOf("/opt/homebrew/bin")).toBeLessThan(
      entries.indexOf("/usr/bin"),
    );
  });

  it("survives a probe that throws", async () => {
    const got = await resolveLoginPath({
      platform: "darwin",
      env: { PATH: LAUNCHD_PATH, SHELL: "/bin/zsh" },
      probe: async () => {
        throw new Error("spawn failed");
      },
    });
    expect(got).not.toBeNull();
    expect(got).toContain("/opt/homebrew/bin");
  });

  it("defaults to zsh when SHELL is unset (launchd often omits it), and asks both modes", async () => {
    const asked: string[] = [];
    await resolveLoginPath({
      platform: "darwin",
      env: { PATH: LAUNCHD_PATH },
      probe: async (shell, mode) => {
        asked.push(`${shell} ${mode}`);
        return shellOut(SHELL_PATH);
      },
    });
    expect(asked.sort()).toEqual(["/bin/zsh interactive", "/bin/zsh login"]);
  });
});

describe("runShellProbe — the real command through a real shell", () => {
  // The quoting is the part a fake probe cannot check. POSIX only; the
  // ubuntu CI job runs these with its own bash and sh.
  for (const shell of ["/bin/bash", "/bin/sh"]) {
    it.skipIf(process.platform === "win32" || !existsSync(shell))(
      `${shell}: both modes print a PATH the parser reads`,
      async () => {
        for (const mode of ["login", "interactive"] as const) {
          const out = await runShellProbe(shell, mode);
          const path = out === null ? null : parseProbeOutput(out);
          expect(path, `${shell} ${mode}: ${out}`).not.toBeNull();
          expect(path).toContain("/");
        }
      },
      15_000,
    );
  }
});

describe("launchLocaleEnv", () => {
  it("gives a Finder-launched app the UTF-8 encoding and nothing else", () => {
    expect(launchLocaleEnv("darwin", { PATH: LAUNCHD_PATH })).toEqual({
      LC_CTYPE: "UTF-8",
    });
  });

  it("leaves any locale the environment already has", () => {
    expect(launchLocaleEnv("darwin", { LANG: "zh_CN.UTF-8" })).toEqual({});
    expect(launchLocaleEnv("darwin", { LC_ALL: "en_US.UTF-8" })).toEqual({});
    expect(launchLocaleEnv("darwin", { LC_CTYPE: "UTF-8" })).toEqual({});
  });

  it("is darwin-only — glibc has no locale named UTF-8", () => {
    expect(launchLocaleEnv("linux", {})).toEqual({});
    expect(launchLocaleEnv("win32", {})).toEqual({});
  });
});

describe("applyLoginPath", () => {
  it("writes the recovered PATH so later children inherit it", async () => {
    let written: string | null = null;
    const got = await applyLoginPath(
      {
        platform: "darwin",
        env: { PATH: LAUNCHD_PATH, SHELL: "/bin/zsh" },
        probe: probeOf({ login: shellOut(SHELL_PATH) }),
      },
      (v) => {
        written = v;
      },
    );
    expect(written).toBe(got);
    expect(written).toContain("/opt/homebrew/bin");
  });

  it("leaves the environment untouched when there is nothing to do", async () => {
    let written: string | null = null;
    await applyLoginPath(
      {
        platform: "win32",
        env: { PATH: "C:\\Windows" },
      },
      (v) => {
        written = v;
      },
    );
    expect(written).toBeNull();
  });
});
