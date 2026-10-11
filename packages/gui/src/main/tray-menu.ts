import type { SessionMetadata } from "@herta/app-server";
import { aliasBanzhuanPlain } from "@herta/core/banzhuan-alias";
import type { MenuItemConstructorOptions } from "electron";
import type { Locale } from "./app-global-settings.js";

/**
 * Pure tray logic — labels, menu template, and the procedurally drawn icon.
 * Electron appears only as TYPE imports (erased at runtime), so this module
 * is unit-testable under plain Node with no electron mock; the Tray/Menu
 * wiring lives in tray.ts.
 */

export interface TrayLabels {
  readonly recent: string;
  readonly more: string;
  readonly newChat: string;
  readonly open: string;
  readonly exit: string;
  readonly untitled: string;
  readonly tooltip: string;
}

/** Main-process copies of the handful of tray strings. The renderer's i18n
 *  catalog lives in renderer code the main bundle must not import; keep
 *  `untitled` in sync with `session.untitled` (zh: 未命名). */
export function trayLabels(locale: Locale): TrayLabels {
  if (locale === "zh") {
    return {
      recent: "最近会话",
      more: "更多",
      newChat: "新对话",
      open: "打开黑塔",
      exit: "退出",
      untitled: "未命名",
      tooltip: "黑塔",
    };
  }
  return {
    recent: "Recent",
    more: "More",
    newChat: "New Chat",
    open: "Open Herta",
    exit: "Exit",
    untitled: "Untitled",
    tooltip: "Herta",
  };
}

/** Sessions shown flat in the menu; older ones fold into the More submenu
 *  (mirrors the Codex tray layout the user asked for). */
const RECENT_INLINE = 3;
const RECENT_MORE_MAX = 12;
/** How many sessions the menu can ever show — what a caller needs to list. */
export const TRAY_SESSION_ROWS = RECENT_INLINE + RECENT_MORE_MAX;
const LABEL_MAX_CODEPOINTS = 30;

/** One menu line per session: the generated title, else the last user
 *  message, else the untitled placeholder — truncated by CODE POINTS so a
 *  CJK title never splits a surrogate pair. The 板砖→Brick alias (ADR 0015;
 *  shared @herta/core helper — the main bundle must not import renderer code,
 *  same stance as trayLabels' catalog copies above) is keyed on the SESSION's
 *  own lang, never the UI locale, and applies BEFORE truncation so the
 *  ellipsis counts the displayed text; display-only — the stored title/record
 *  keeps the wire token 板砖. */
export function sessionMenuLabel(s: SessionMetadata, untitled: string): string {
  const raw = aliasBanzhuanPlain(
    (s.title ?? "").trim() || (s.lastUserText ?? "").trim() || untitled,
    s.lang ?? "zh",
  );
  const cps = [...raw];
  if (cps.length <= LABEL_MAX_CODEPOINTS) return raw;
  return `${cps.slice(0, LABEL_MAX_CODEPOINTS - 1).join("")}…`;
}

export interface TrayMenuHandlers {
  onOpenSession(sessionId: string): void;
  onNewChat(): void;
  onShow(): void;
  onExit(): void;
}

/**
 * Build the tray context-menu template:
 *
 *   Recent            (header, disabled — only when sessions exist)
 *   <newest 3 sessions>
 *   More ▸            (next 12, only when more than 3)
 *   ─────
 *   New Chat
 *   ─────
 *   Open Herta
 *   ─────
 *   Exit
 *
 * Sessions are re-sorted by lastActivityAt defensively (listSessions() is
 * already newest-first, but the menu must stay correct if an upstream
 * caller re-orders — same stance as session-service's pickLatest).
 */
export function buildTrayMenuTemplate(
  sessions: readonly SessionMetadata[],
  labels: TrayLabels,
  handlers: TrayMenuHandlers,
): MenuItemConstructorOptions[] {
  const sorted = [...sessions].sort(
    (a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt),
  );
  const items: MenuItemConstructorOptions[] = [];
  if (sorted.length > 0) {
    items.push({ label: labels.recent, enabled: false });
    for (const s of sorted.slice(0, RECENT_INLINE)) {
      items.push({
        label: sessionMenuLabel(s, labels.untitled),
        click: () => handlers.onOpenSession(s.sessionId),
      });
    }
    const rest = sorted.slice(RECENT_INLINE, RECENT_INLINE + RECENT_MORE_MAX);
    if (rest.length > 0) {
      items.push({
        label: labels.more,
        submenu: rest.map((s) => ({
          label: sessionMenuLabel(s, labels.untitled),
          click: () => handlers.onOpenSession(s.sessionId),
        })),
      });
    }
    items.push({ type: "separator" });
  }
  items.push({ label: labels.newChat, click: () => handlers.onNewChat() });
  items.push({ type: "separator" });
  items.push({ label: labels.open, click: () => handlers.onShow() });
  items.push({ type: "separator" });
  items.push({ label: labels.exit, click: () => handlers.onExit() });
  return items;
}

/**
 * Draw the tray icon procedurally: a dark rounded-square badge (the app's
 * send-button dark, rgb(20,23,27)) carrying a white "H." — the mark the
 * HRI device card already uses. Rendered as a raw BGRA bitmap for
 * `nativeImage.createFromBitmap`, so no binary asset enters the repo and
 * the icon stays crisp at any integer size. The badge edge is feathered
 * ~1px via a rounded-rect distance function; the glyph strokes are
 * axis-aligned rects (crisp at small sizes by construction).
 *
 * Design coordinates are on a 32-unit grid and scale with `size`:
 *   badge   2..30, corner radius 8
 *   H       left bar 10..13, right bar 19..22, y 9..23; crossbar 13..19 × 14.5..17.5
 *   dot     24..27 × 20..23
 */
export function renderTrayIconBitmap(
  size: number,
  opts: { readonly template?: boolean } = {},
): Buffer {
  // macOS template mode: opaque pixels are re-colored by the OS for the
  // light/dark menu bar, so the badge is drawn BLACK and the glyph is knocked
  // out to transparent instead of painted white — the "H." reads as a cutout.
  const template = opts.template === true;
  const buf = Buffer.alloc(size * size * 4);
  const u = size / 32; // design-unit → pixel scale
  const half = size / 2;
  const halfExtent = 14 * u; // badge half-width (30-2)/2 design units
  const radius = 8 * u;
  const glyphRects: ReadonlyArray<readonly [number, number, number, number]> = [
    [10, 9, 13, 23], // H left bar   [x0, y0, x1, y1] in design units
    [19, 9, 22, 23], // H right bar
    [13, 14.5, 19, 17.5], // H crossbar
    [24, 20, 27, 23], // the "." of "H."
  ];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      // Rounded-rect signed distance → 1px-feathered coverage.
      const dx = Math.max(Math.abs(px - half) - (halfExtent - radius), 0);
      const dy = Math.max(Math.abs(py - half) - (halfExtent - radius), 0);
      const dist = Math.hypot(dx, dy) - radius;
      const coverage = Math.min(Math.max(0.5 - dist, 0), 1);
      const i = (y * size + x) * 4;
      if (coverage <= 0) continue; // transparent (Buffer.alloc zero-fills)
      const inGlyph = glyphRects.some(
        ([x0, y0, x1, y1]) =>
          px >= x0 * u && px < x1 * u && py >= y0 * u && py < y1 * u,
      );
      if (template) {
        if (inGlyph) continue; // knocked out — stays fully transparent
        buf[i] = 0; // BGRA: black badge, alpha carries the shape
        buf[i + 1] = 0;
        buf[i + 2] = 0;
        buf[i + 3] = Math.round(coverage * 255);
        continue;
      }
      const [r, g, b] = inGlyph ? [255, 255, 255] : [20, 23, 27];
      buf[i] = b; // BGRA byte order per createFromBitmap
      buf[i + 1] = g;
      buf[i + 2] = r;
      buf[i + 3] = Math.round(coverage * 255);
    }
  }
  return buf;
}
