import { useSyncExternalStore } from "react";
import { useLocale, useT } from "../../i18n/LocaleProvider.js";
import { getNowMs, subscribeNow } from "../../lib/now-tick.js";
import { formatBubbleTime } from "./format-time.js";

/**
 * The hover action row's timestamp label — the ONLY part of a message row
 * that depends on the current time. It subscribes to the shared coarse
 * clock itself (perf 2026-08-25) so a tick invalidates exactly the leafs
 * whose label string actually changed: the store snapshot IS the formatted
 * label, and `useSyncExternalStore` bails out on an equal string. Before
 * this, the 30s tick sat in Conversation's row memo and rebuilt every
 * mounted row element — O(window) element creation and reconcile per tick —
 * to refresh at most a few labels.
 */
export function BubbleTime(props: { readonly at: string }): JSX.Element {
  const { locale } = useLocale();
  const t = useT();
  const label = useSyncExternalStore(subscribeNow, () =>
    formatBubbleTime(props.at, getNowMs(), locale, t),
  );
  return <span className="message-actions__time">{label}</span>;
}
