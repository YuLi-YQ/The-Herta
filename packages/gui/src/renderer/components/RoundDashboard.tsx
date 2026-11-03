import type { RoundMetrics, RoundSummary } from "@herta/app-server";
import "./round-dashboard.css";
import { Icon } from "./Icon.js";
interface Props {
  rounds: RoundSummary[];
  metrics: RoundMetrics | null;
}
const known = (value: number | null | undefined): value is number =>
  value != null && Number.isFinite(value);
const count = (value: number) =>
  new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(value);
/** Only what is known is shown: a figure the service did not report is left
 *  out rather than printed as "--", so a provider without usage data leaves a
 *  quiet line instead of four placeholders (R72). */
export function RoundDashboard({ rounds, metrics }: Props) {
  const latest = rounds.at(-1);
  // Older history without round records: the count is a lower bound.
  const knownRounds = rounds[0]?.recordStart === 0;
  const speed = latest?.metrics.outputTokensPerSecond;
  const total = metrics?.totalTokens;
  const cache = metrics?.cacheHitRate;
  const context =
    known(metrics?.contextUsed) &&
    known(metrics?.contextWindow) &&
    metrics.contextWindow > 0
      ? Math.min(100, (100 * metrics.contextUsed) / metrics.contextWindow)
      : null;
  return (
    <div className="herta-round-dashboard" aria-label="任务用量统计">
      {latest && (
        <span title="已记录的用户逻辑轮次；补充回答不重复计轮。">
          <Icon name="clock" />
          <span className="herta-icon-label">
            {rounds.length}
            {knownRounds ? "" : "+"} 轮 · {latest.activities.length} 步
          </span>
        </span>
      )}
      {known(speed) && (
        <span title="最近一轮输出 tokens / 实际生成秒数；无法确定生成时长时不估算。">
          {speed.toFixed(1)} tok/s
        </span>
      )}
      {known(total) && (
        <span
          title={
            metrics?.partial
              ? "任务累计用量不完整，不能将已知小计当总量。"
              : "当前任务所有角色和执行器请求的输入加输出；缓存 token 不重复计数。"
          }
        >
          用量 {count(total)} tok{metrics?.partial ? "+" : ""}
        </span>
      )}
      {known(cache) && (
        <span title="任务累计缓存命中输入 / 全部输入。">
          缓存 {(cache * 100).toFixed(0)}%
        </span>
      )}
      {context !== null && (
        <span
          className="herta-context-meter"
          title="当前角色最新请求的输入 / 可信模型上下文窗口；不是累计 token。"
        >
          <span
            className="herta-context-ring"
            aria-hidden="true"
            style={{
              background: `conic-gradient(var(--herta-accent, #c6afde) ${context}%, transparent 0)`,
            }}
          />
          上下文 {context.toFixed(0)}%
        </span>
      )}
    </div>
  );
}
