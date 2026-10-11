import type { MenuItemConstructorOptions } from "electron";

/** Roles a packaged app must never carry: each one is a keyboard shortcut
 *  that reloads the window or opens the developer tools. */
export const DEV_ONLY_ROLES: ReadonlySet<string> = new Set([
  "reload",
  "forceReload",
  "toggleDevTools",
]);

/**
 * The application menu, or null to keep Electron's default.
 *
 * The window is frameless (`titleBarStyle: "hidden"`), so no menu is ever
 * SEEN on Windows or Linux — but Electron's default menu stays installed and
 * its accelerators stay live. In a packaged build Ctrl+R reloaded the window
 * mid-turn and Ctrl+Shift+I opened the developer tools on a window that
 * holds the app's whole IPC bridge (UX review 2026-09-22, item 7).
 *
 * Packaged: the default menu's shape minus those three roles. Editing,
 * zoom, full screen and the window roles stay: on macOS the Edit menu is
 * what makes Cmd+C / Cmd+V work in a text field at all, and a user's zoom
 * or Ctrl+W close is not the bug. A development build keeps the default
 * (reload and the tools are how the app is worked on).
 *
 * macOS (platform review 2026-09-23): the app menu carries Settings… on
 * Cmd+, — the shortcut every Mac app answers — and the File menu is there,
 * because on a Mac Close Window (Cmd+W) lives in File, not in Window. The
 * `appMenu` role alone left Cmd+W doing nothing. The labels stay English
 * like the role menus around them, which Electron does not translate.
 */
export function appMenuTemplate(opts: {
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  /** The Settings… item's action (macOS). */
  readonly onOpenSettings?: () => void;
}): MenuItemConstructorOptions[] | null {
  if (!opts.isPackaged) return null;
  const mac = opts.platform === "darwin";
  const head: MenuItemConstructorOptions[] = mac
    ? [
        {
          label: "Herta",
          submenu: [
            { role: "about" },
            { type: "separator" },
            {
              label: "Settings…",
              accelerator: "Cmd+,",
              click: () => opts.onOpenSettings?.(),
            },
            { type: "separator" },
            { role: "services" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" },
          ],
        },
        { role: "fileMenu" },
      ]
    : [{ role: "fileMenu" }];
  return [
    ...head,
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
}
