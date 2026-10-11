/**
 * The environment 板砖's own children run with (platform review 2026-09-23):
 * `process.env`, minus what the AppImage launcher put there for the APP.
 *
 * The Linux AppImage's AppRun prepends `$APPDIR` entries to `PATH`,
 * `LD_LIBRARY_PATH`, `XDG_DATA_DIRS` and `GSETTINGS_SCHEMA_DIR` before
 * starting Herta, and every shell, test run and git call 板砖 makes inherited
 * them — so a user's own `npm start` of an Electron or GTK app loaded HERTA's
 * bundled libraries (`$APPDIR/usr/lib`), and `$APPDIR` shadowed the user's
 * own binaries. The main process keeps its environment untouched (Chromium's
 * later helper processes may need those libraries); only the processes 板砖
 * starts get the cleaned copy. `APPIMAGE` / `APPDIR` / `OWD` / `ARGV0` go too:
 * they describe Herta's launch, and an electron-updater app started by 板砖
 * would otherwise take itself for Herta's AppImage.
 *
 * Outside an AppImage — Windows, macOS, a distro package — this is
 * `process.env` itself, byte for byte.
 */

const APPIMAGE_LISTS = [
  "PATH",
  "LD_LIBRARY_PATH",
  "XDG_DATA_DIRS",
  "GSETTINGS_SCHEMA_DIR",
] as const;
const APPIMAGE_BOOKKEEPING = ["APPIMAGE", "APPDIR", "OWD", "ARGV0"] as const;

export function childProcessEnv(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const appdir = base.APPDIR;
  if (base.APPIMAGE === undefined || appdir === undefined || appdir === "") {
    return base;
  }
  const root = appdir.replace(/\/+$/, "");
  const ours = (entry: string): boolean =>
    entry === root || entry === `${root}/` || entry.startsWith(`${root}/`);
  const out: NodeJS.ProcessEnv = { ...base };
  for (const key of APPIMAGE_LISTS) {
    const value = out[key];
    if (value === undefined) continue;
    const kept = value
      .split(":")
      .filter((e) => e.length > 0 && !ours(e))
      .join(":");
    if (kept.length > 0) out[key] = kept;
    else delete out[key];
  }
  for (const key of APPIMAGE_BOOKKEEPING) delete out[key];
  return out;
}
