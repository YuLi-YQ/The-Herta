import type { SessionMetadata } from "@herta/app-server";

export type SessionGroupLabel =
  | "Today"
  | "Yesterday"
  | "Previous 7 Days"
  | "Older";

const ALL_LABELS: readonly SessionGroupLabel[] = [
  "Today",
  "Yesterday",
  "Previous 7 Days",
  "Older",
];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Group sessions by recency relative to `now`. Returns a Map
 * keyed by label; only non-empty groups are present. Input order
 * is preserved within each group.
 */
export function groupSessions(
  sessions: readonly SessionMetadata[],
  now: Date,
): Map<SessionGroupLabel, SessionMetadata[]> {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfYesterday = new Date(startOfToday.getTime() - DAY_MS);
  const startOfPrev7 = new Date(startOfToday.getTime() - 7 * DAY_MS);

  const buckets = new Map<SessionGroupLabel, SessionMetadata[]>();
  for (const label of ALL_LABELS) buckets.set(label, []);

  for (const s of sessions) {
    const t = new Date(s.lastActivityAt);
    let label: SessionGroupLabel;
    if (t >= startOfToday) label = "Today";
    else if (t >= startOfYesterday) label = "Yesterday";
    else if (t >= startOfPrev7) label = "Previous 7 Days";
    else label = "Older";
    buckets.get(label)?.push(s);
  }

  // Drop empty buckets.
  for (const label of ALL_LABELS) {
    if (buckets.get(label)?.length === 0) buckets.delete(label);
  }
  return buckets;
}
