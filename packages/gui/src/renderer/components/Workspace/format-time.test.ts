import { describe, expect, it } from "vitest";
import { formatBubbleTime, formatTime, type TimeTFn } from "./format-time.js";

/** Minimal fake t that returns en catalog values for the two time keys. */
function makeT(locale: "en" | "zh" = "en"): TimeTFn {
  const catalog = {
    en: {
      "time.justNow": "just now",
      "time.minAgo": "{n} min ago",
    },
    zh: {
      "time.justNow": "刚刚",
      "time.minAgo": "{n} 分钟前",
    },
  } as const;
  return (key, params) => {
    const entry = catalog[locale][key as keyof (typeof catalog)[typeof locale]];
    if (entry === undefined) return key;
    return entry.replace(/\{(\w+)\}/g, (_, name) =>
      params !== undefined && name in params
        ? String(params[name])
        : `{${name}}`,
    );
  };
}

describe("formatTime", () => {
  it("formats an ISO timestamp as '10:24 AM'-style 12-hour time", () => {
    expect(formatTime("2026-05-28T10:24:00Z", "en", "UTC")).toBe("10:24 AM");
    expect(formatTime("2026-05-28T22:25:00Z", "en", "UTC")).toBe("10:25 PM");
  });

  it("formats midnight as '12:00 AM' and noon as '12:00 PM'", () => {
    expect(formatTime("2026-05-28T00:00:00Z", "en", "UTC")).toBe("12:00 AM");
    expect(formatTime("2026-05-28T12:00:00Z", "en", "UTC")).toBe("12:00 PM");
  });
});

describe("formatBubbleTime", () => {
  const NOW = "2026-06-06T12:20:00Z";
  const at = (iso: string = NOW): number => new Date(iso).getTime();
  const t = makeT("en");

  it("shows 'just now' under a minute (and for future / clock-skewed stamps)", () => {
    expect(formatBubbleTime("2026-06-06T12:20:00Z", at(), "en", t, "UTC")).toBe(
      "just now",
    );
    expect(formatBubbleTime("2026-06-06T12:19:30Z", at(), "en", t, "UTC")).toBe(
      "just now",
    );
    expect(formatBubbleTime("2026-06-06T12:19:01Z", at(), "en", t, "UTC")).toBe(
      "just now",
    );
    // A stamp slightly in the future (clock skew) still reads "just now".
    expect(formatBubbleTime("2026-06-06T12:25:00Z", at(), "en", t, "UTC")).toBe(
      "just now",
    );
  });

  it("shows 'N min ago' from 1 to 59 minutes", () => {
    expect(formatBubbleTime("2026-06-06T12:19:00Z", at(), "en", t, "UTC")).toBe(
      "1 min ago",
    );
    // Floors: 90s in still reads "1 min ago".
    expect(formatBubbleTime("2026-06-06T12:18:30Z", at(), "en", t, "UTC")).toBe(
      "1 min ago",
    );
    expect(formatBubbleTime("2026-06-06T12:18:00Z", at(), "en", t, "UTC")).toBe(
      "2 min ago",
    );
    expect(formatBubbleTime("2026-06-06T11:21:00Z", at(), "en", t, "UTC")).toBe(
      "59 min ago",
    );
  });

  it("shows time-only once it's an hour+ old but still the same day", () => {
    expect(formatBubbleTime("2026-06-06T11:20:00Z", at(), "en", t, "UTC")).toBe(
      "11:20 AM",
    );
    expect(formatBubbleTime("2026-06-06T03:19:00Z", at(), "en", t, "UTC")).toBe(
      "3:19 AM",
    );
  });

  it("shows 'Mon D, time' for an earlier day in the same year", () => {
    const now = at("2026-06-07T10:00:00Z");
    expect(formatBubbleTime("2026-06-06T00:19:00Z", now, "en", t, "UTC")).toBe(
      "Jun 6, 12:19 AM",
    );
    expect(formatBubbleTime("2026-06-05T16:30:00Z", now, "en", t, "UTC")).toBe(
      "Jun 5, 4:30 PM",
    );
  });

  it("uses the calendar day, not elapsed time, once past the relative window", () => {
    // 90 min ago but across midnight → it's 'yesterday', so date+time wins.
    const now = at("2026-06-06T00:30:00Z");
    expect(formatBubbleTime("2026-06-05T23:00:00Z", now, "en", t, "UTC")).toBe(
      "Jun 5, 11:00 PM",
    );
  });

  it("includes the year for a stamp from a previous year", () => {
    const now = at("2026-06-07T10:00:00Z");
    expect(formatBubbleTime("2025-06-06T00:19:00Z", now, "en", t, "UTC")).toBe(
      "Jun 6, 2025, 12:19 AM",
    );
  });

  it("returns zh relative-time strings when locale is zh", () => {
    const tZh = makeT("zh");
    expect(
      formatBubbleTime("2026-06-06T12:20:00Z", at(), "zh", tZh, "UTC"),
    ).toBe("刚刚");
    expect(
      formatBubbleTime("2026-06-06T12:18:00Z", at(), "zh", tZh, "UTC"),
    ).toBe("2 分钟前");
  });

  it("uses zh-CN date formatting for older-bubble dates when locale is zh", () => {
    const tZh = makeT("zh");
    const now = new Date("2026-06-07T10:00:00Z").getTime();
    const result = formatBubbleTime(
      "2026-06-06T00:19:00Z",
      now,
      "zh",
      tZh,
      "UTC",
    );
    // zh-CN renders the month differently from en-US (e.g. "6月6日" not "Jun 6")
    expect(result).not.toMatch(/^Jun/);
    // Should still contain the time portion from zh-CN formatTime
    expect(result).toContain("12:19");
  });
});
