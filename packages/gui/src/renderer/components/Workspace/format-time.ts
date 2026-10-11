import type { MessageKey } from "../../i18n/keys.js";
import type { Locale } from "../../ipc/bridge-types.js";

export type TimeTFn = (
  key: MessageKey,
  params?: Record<string, string | number>,
) => string;

/**
 * Cached Intl.DateTimeFormat instances (user profile 2026-07-12): the
 * toLocale*String convenience methods construct a fresh formatter PER CALL
 * — one of the most expensive one-liners in the platform — and a render of
 * a 240-row session calls into this module up to ~5× per row. The cache
 * turns those into `format()` calls on shared instances. Keyed by every
 * option that varies (locale tag + timeZone + shape).
 */
const fmtCache = new Map<string, Intl.DateTimeFormat>();

function cachedFormat(
  localeTag: string,
  opts: Intl.DateTimeFormatOptions,
  key: string,
): Intl.DateTimeFormat {
  let fmt = fmtCache.get(key);
  if (fmt === undefined) {
    fmt = new Intl.DateTimeFormat(localeTag, opts);
    fmtCache.set(key, fmt);
  }
  return fmt;
}

/**
 * Format an ISO timestamp as a 12-hour bubble timestamp like
 * "10:24 AM". `timeZone` defaults to the user's locale; tests
 * pass "UTC" for determinism. `locale` controls the time formatting
 * (en-US vs zh-CN).
 */
export function formatTime(
  iso: string,
  locale: Locale,
  timeZone?: string,
): string {
  const tag = locale === "zh" ? "zh-CN" : "en-US";
  return cachedFormat(
    tag,
    { hour: "numeric", minute: "2-digit", hour12: true, timeZone },
    `time|${tag}|${timeZone ?? ""}`,
  ).format(new Date(iso));
}

const MINUTE_MS = 60_000;

/** A YYYY-MM-DD key in `timeZone` for same-calendar-day comparison. en-CA
 *  renders as ISO-ordered date parts, so string compare == day compare. */
function dayKey(ms: number, timeZone?: string): string {
  return cachedFormat(
    "en-CA",
    { timeZone, year: "numeric", month: "2-digit", day: "2-digit" },
    `day|${timeZone ?? ""}`,
  ).format(ms);
}

/**
 * Adaptive bubble timestamp, Codex/Claude-style — the label sharpens as the
 * message ages relative to `nowMs`:
 *   - under 1 min           → t("time.justNow")
 *   - 1–59 min              → t("time.minAgo", { n })
 *   - same calendar day     → "12:19 AM"            (time only)
 *   - earlier, same year    → "Jun 6, 12:19 AM"
 *   - earlier year          → "Jun 6, 2025, 12:19 AM"
 * Past the 1-hour relative window the form is calendar-based, not elapsed-time
 * based: a 90-minutes-ago message that crossed midnight reads as the prior day.
 * `nowMs` is injected (not read from the clock) so the result is deterministic
 * and testable; `timeZone` defaults to the user's locale.
 */
export function formatBubbleTime(
  iso: string,
  nowMs: number,
  locale: Locale,
  t: TimeTFn,
  timeZone?: string,
): string {
  const ts = new Date(iso).getTime();
  const deltaMin = Math.floor((nowMs - ts) / MINUTE_MS);
  if (deltaMin < 1) return t("time.justNow");
  if (deltaMin < 60) return t("time.minAgo", { n: deltaMin });

  const time = formatTime(iso, locale, timeZone);
  if (dayKey(ts, timeZone) === dayKey(nowMs, timeZone)) return time;

  const sameYear =
    dayKey(ts, timeZone).slice(0, 4) === dayKey(nowMs, timeZone).slice(0, 4);
  const tag = locale === "zh" ? "zh-CN" : "en-US";
  const date = cachedFormat(
    tag,
    {
      timeZone,
      month: "short",
      day: "numeric",
      ...(sameYear ? {} : { year: "numeric" }),
    },
    `date|${tag}|${timeZone ?? ""}|${sameYear ? "y" : "Y"}`,
  ).format(ts);
  return `${date}, ${time}`;
}
