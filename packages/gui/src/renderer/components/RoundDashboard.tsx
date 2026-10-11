import type { RoundMetrics, RoundSummary } from "@herta/app-server";
import "./round-dashboard.css";
interface Props {
  rounds: RoundSummary[];
  metrics: RoundMetrics | null;
}
const count = (value: number | null | undefined) =>
  value == null || !Number.isFinite(value)
    ? "--"
    : new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(
        value,
      );
export function RoundDashboard({ rounds, metrics }: Props) {
  const latest = rounds.at(-1);
  const knownRounds = rounds[0]?.recordStart === 0;
  const context =
    metrics?.contextUsed != null &&
    metrics.contextWindow != null &&
    metrics.contextWindow > 0
      ? Math.min(100, (100 * metrics.contextUsed) / metrics.contextWindow)
      : null;
  return (
    <div className="herta-round-dashboard" aria-label="任务用量统计">
      <span title="已记录的用户逻辑轮次；补充回答不重复计轮。历史记录不完整时显示占位。">
        ◷ {knownRounds ? rounds.length : "--"} 轮 ·{" "}
        {latest ? latest.activities.length : "--"} 步
      </span>
      <span title="最近一轮输出 tokens / 实际生成秒数；无法确定生成时长时不估算。">
        {latest?.metrics.outputTokensPerSecond != null
          ? latest.metrics.outputTokensPerSecond.toFixed(1)
          : "--"}{" "}
        tok/s
      </span>
      <span
        title={
          metrics?.partial
            ? "任务累计用量不完整，不能将已知小计当总量。"
            : "当前任务所有角色和执行器请求的输入加输出；缓存 token 不重复计数。"
        }
      >
        用量 {count(metrics?.totalTokens)} tok
      </span>
      <span title="任务累计缓存命中输入 / 全部输入；任一请求缺失所需字段则显示占位。">
        缓存{" "}
        {metrics?.cacheHitRate != null
          ? `${(metrics.cacheHitRate * 100).toFixed(0)}%`
          : "--"}
      </span>
      <span
        className="herta-context-meter"
        title="当前角色最新请求的输入 / 可信模型上下文窗口；不是累计 token。窗口未确认时显示占位。"
      >
        <span
          className="herta-context-ring"
          aria-hidden="true"
          style={
            context == null
              ? undefined
              : {
                  background: `conic-gradient(var(--herta-accent, #c6afde) ${context}%, transparent 0)`,
                }
          }
        />
        上下文 {context == null ? "--" : `${context.toFixed(0)}%`}
      </span>
    </div>
  );
}
