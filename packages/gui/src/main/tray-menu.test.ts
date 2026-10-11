import type { SessionMetadata } from "@herta/app-server";
import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";
import {
  buildTrayMenuTemplate,
  renderTrayIconBitmap,
  sessionMenuLabel,
  TRAY_SESSION_ROWS,
  type TrayMenuHandlers,
  trayLabels,
} from "./tray-menu.js";

function meta(overrides: Partial<SessionMetadata> & { sessionId: string }) {
  return {
    workspaceRoot: "/repo",
    startedAt: "2026-07-01T00:00:00.000Z",
    lastActivityAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  } as SessionMetadata;
}

function noopHandlers(): TrayMenuHandlers {
  return {
    onOpenSession: vi.fn(),
    onNewChat: vi.fn(),
    onShow: vi.fn(),
    onExit: vi.fn(),
  };
}

function labels() {
  return trayLabels("en");
}

function labelsOf(items: MenuItemConstructorOptions[]): (string | undefined)[] {
  return items.map((i) => (i.type === "separator" ? "---" : i.label));
}

describe("sessionMenuLabel", () => {
  it("prefers the title, then the last user text, then the placeholder", () => {
    expect(
      sessionMenuLabel(meta({ sessionId: "a", title: "编程求助" }), "未命名"),
    ).toBe("编程求助");
    expect(
      sessionMenuLabel(
        meta({ sessionId: "a", lastUserText: "帮我写个脚本" }),
        "未命名",
      ),
    ).toBe("帮我写个脚本");
    expect(sessionMenuLabel(meta({ sessionId: "a" }), "未命名")).toBe("未命名");
  });

  it("aliases 板砖→Brick for an EN-born session; zh and legacy stay literal", () => {
    expect(
      sessionMenuLabel(
        meta({ sessionId: "a", title: "让 @板砖 修 parser", lang: "en" }),
        "Untitled",
      ),
    ).toBe("让 @Brick 修 parser");
    expect(
      sessionMenuLabel(
        meta({ sessionId: "a", lastUserText: "板砖 干活", lang: "en" }),
        "Untitled",
      ),
    ).toBe("Brick 干活");
    // zh session and a legacy header (no lang) keep the literal token.
    expect(
      sessionMenuLabel(
        meta({ sessionId: "a", title: "让 @板砖 修 parser", lang: "zh" }),
        "未命名",
      ),
    ).toBe("让 @板砖 修 parser");
    expect(
      sessionMenuLabel(
        meta({ sessionId: "a", title: "让 @板砖 修 parser" }),
        "未命名",
      ),
    ).toBe("让 @板砖 修 parser");
  });

  it("applies the alias BEFORE code-point truncation (the ellipsis counts displayed text)", () => {
    // The RAW string is exactly at the 30-cp cap (no truncation), but the
    // aliased form (板砖→Brick) overruns it — the displayed label must be
    // alias-then-truncate, so the ellipsis counts the displayed text.
    const title = `${"字".repeat(28)}板砖`;
    const out = sessionMenuLabel(
      meta({ sessionId: "a", title, lang: "en" }),
      "Untitled",
    );
    expect([...out].length).toBe(30);
    expect(out).toBe(`${"字".repeat(28)}B…`);
  });

  it("truncates long labels by code points with an ellipsis", () => {
    const long = "字".repeat(60);
    const out = sessionMenuLabel(
      meta({ sessionId: "a", title: long }),
      "Untitled",
    );
    expect([...out].length).toBe(30);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("buildTrayMenuTemplate", () => {
  it("with no sessions: no Recent section — just New Chat / Open / Exit", () => {
    const items = buildTrayMenuTemplate([], labels(), noopHandlers());
    expect(labelsOf(items)).toEqual([
      "New Chat",
      "---",
      "Open Herta",
      "---",
      "Exit",
    ]);
  });

  it("shows up to 3 recent sessions newest-first with a disabled header", () => {
    const sessions = [
      meta({
        sessionId: "old",
        title: "old",
        lastActivityAt: "2026-07-01T00:00:00.000Z",
      }),
      meta({
        sessionId: "new",
        title: "new",
        lastActivityAt: "2026-07-03T00:00:00.000Z",
      }),
      meta({
        sessionId: "mid",
        title: "mid",
        lastActivityAt: "2026-07-02T00:00:00.000Z",
      }),
    ];
    const items = buildTrayMenuTemplate(sessions, labels(), noopHandlers());
    expect(labelsOf(items)).toEqual([
      "Recent",
      "new",
      "mid",
      "old",
      "---",
      "New Chat",
      "---",
      "Open Herta",
      "---",
      "Exit",
    ]);
    expect(items[0]?.enabled).toBe(false);
  });

  it("folds sessions beyond the first 3 into a More submenu (capped at 12)", () => {
    const sessions = Array.from({ length: 20 }, (_, i) =>
      meta({
        sessionId: `s${i}`,
        title: `s${i}`,
        // s19 newest … s0 oldest
        lastActivityAt: `2026-07-01T00:00:${String(i).padStart(2, "0")}.000Z`,
      }),
    );
    const items = buildTrayMenuTemplate(sessions, labels(), noopHandlers());
    const more = items.find((i) => i.label === "More");
    expect(more).toBeDefined();
    const sub = more?.submenu as MenuItemConstructorOptions[];
    expect(sub).toHaveLength(12);
    expect(sub[0]?.label).toBe("s16"); // 4th-newest heads the submenu
  });

  it("TRAY_SESSION_ROWS is every session the menu can show — what a lister needs to fetch (perf audit 2026-09-20)", () => {
    // The tray listed EVERY session on each right-click to show these few;
    // session-service bounds its listing by this number now, so the number
    // has to stay true to the menu.
    const sessions = Array.from({ length: 60 }, (_, i) =>
      meta({
        sessionId: `s${i}`,
        title: `s${i}`,
        lastActivityAt: new Date(Date.UTC(2026, 6, 1, 0, 0, i)).toISOString(),
      }),
    );
    const items = buildTrayMenuTemplate(sessions, labels(), noopHandlers());
    const inline = items.filter((i) => /^s\d+$/.test(i.label ?? "")).length;
    const more = (items.find((i) => i.label === "More")?.submenu ??
      []) as MenuItemConstructorOptions[];
    expect(inline + more.length).toBe(TRAY_SESSION_ROWS);
    expect(TRAY_SESSION_ROWS).toBe(15);
  });

  it("clicking a recent item opens THAT session; the static items route to their handlers", () => {
    const handlers = noopHandlers();
    const items = buildTrayMenuTemplate(
      [meta({ sessionId: "s1", title: "t1" })],
      labels(),
      handlers,
    );
    const clickOf = (label: string) =>
      items.find((i) => i.label === label)?.click as (() => void) | undefined;
    clickOf("t1")?.();
    expect(handlers.onOpenSession).toHaveBeenCalledWith("s1");
    clickOf("New Chat")?.();
    expect(handlers.onNewChat).toHaveBeenCalledTimes(1);
    clickOf("Open Herta")?.();
    expect(handlers.onShow).toHaveBeenCalledTimes(1);
    clickOf("Exit")?.();
    expect(handlers.onExit).toHaveBeenCalledTimes(1);
  });

  it("zh labels are used when locale is zh", () => {
    const zh = trayLabels("zh");
    const items = buildTrayMenuTemplate(
      [meta({ sessionId: "s1" })],
      zh,
      noopHandlers(),
    );
    const names = labelsOf(items);
    expect(names).toContain("最近会话");
    expect(names).toContain("新对话");
    expect(names).toContain("退出");
    // Untitled session falls back to the zh placeholder (session.untitled parity).
    expect(names).toContain("未命名");
  });
});

describe("trayLabels tooltip", () => {
  it("follows the locale (the hover tooltip must re-render on language switch)", () => {
    expect(trayLabels("zh").tooltip).toBe("黑塔");
    expect(trayLabels("en").tooltip).toBe("Herta");
  });
});

describe("renderTrayIconBitmap", () => {
  const bgra = (buf: Buffer, size: number, x: number, y: number) => {
    const i = (y * size + x) * 4;
    return { b: buf[i], g: buf[i + 1], r: buf[i + 2], a: buf[i + 3] };
  };

  it("is a size×size×4 BGRA buffer", () => {
    expect(renderTrayIconBitmap(32)).toHaveLength(32 * 32 * 4);
    expect(renderTrayIconBitmap(16)).toHaveLength(16 * 16 * 4);
  });

  it("corners are transparent, badge is dark, glyph is white", () => {
    const size = 32;
    const buf = renderTrayIconBitmap(size);
    // Outside the rounded badge.
    expect(bgra(buf, size, 0, 0).a).toBe(0);
    // Inside the badge, above the H strokes → dark pixel, opaque.
    const badge = bgra(buf, size, 16, 5);
    expect(badge.a).toBe(255);
    expect(badge.r).toBeLessThan(60);
    // Center falls on the H crossbar → white.
    const cross = bgra(buf, size, 16, 16);
    expect(cross).toEqual({ b: 255, g: 255, r: 255, a: 255 });
    // The "." of "H."
    const dot = bgra(buf, size, 25, 21);
    expect(dot).toEqual({ b: 255, g: 255, r: 255, a: 255 });
  });

  // macOS menu bar variant (2026-08-04). A template image is black+alpha
  // only — the OS re-colors the opaque pixels for the light/dark menu bar —
  // so the glyph must be a TRANSPARENT knockout rather than white paint, or
  // it would vanish into the tinted badge. Testable here; the on-screen
  // result is checked from the macOS CI screenshot.
  it("template mode: badge is pure black, glyph is knocked out", () => {
    const size = 32;
    const buf = renderTrayIconBitmap(size, { template: true });
    expect(buf).toHaveLength(size * size * 4);
    // Outside the badge — still transparent.
    expect(bgra(buf, size, 0, 0).a).toBe(0);
    // Badge body: opaque BLACK (no color left for the OS to fight).
    const badge = bgra(buf, size, 16, 5);
    expect(badge).toEqual({ b: 0, g: 0, r: 0, a: 255 });
    // The H crossbar and the dot are knockouts, not white pixels.
    expect(bgra(buf, size, 16, 16).a).toBe(0);
    expect(bgra(buf, size, 25, 21).a).toBe(0);
  });

  it("template mode leaves the default (Windows) bitmap untouched", () => {
    // Guards against the template branch leaking into the colored path.
    const plain = renderTrayIconBitmap(32);
    const alsoPlain = renderTrayIconBitmap(32, {});
    expect(alsoPlain.equals(plain)).toBe(true);
    expect(renderTrayIconBitmap(32, { template: true }).equals(plain)).toBe(
      false,
    );
  });
});
