/** Only show persisted times; legacy messages without timestamps stay undated. */
export function MessageTime({ at }: { at?: string }) {
  if (!at || !Number.isFinite(Date.parse(at))) return null;
  const date = new Date(at);
  const label = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(date);
  return (
    <time
      className="herta-message-time"
      dateTime={date.toISOString()}
      title={`${label}（本地时间）`}
    >
      {label}
    </time>
  );
}
