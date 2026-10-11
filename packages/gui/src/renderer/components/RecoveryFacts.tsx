import type { RecoverySummary } from "@herta/core";

const phases = {
  "previously-completed": "此前已完成（未重复执行）",
  resumed: "本次恢复执行",
  new: "本次新增执行",
  "not-executed": "未执行",
  uncertain: "结果不确定，需检查",
} as const;
const outcomes = {
  succeeded: "成功",
  failed: "失败",
  denied: "已拒绝",
  cancelled: "已取消",
  pending: "等待执行",
  unknown: "未确认",
} as const;

/** Only a server-authored structured record is accepted, never parsed model prose. */
export function RecoveryFacts({
  facts,
}: {
  facts: RecoverySummary;
}): JSX.Element {
  const valid =
    facts?.version === 1 &&
    typeof facts.runId === "string" &&
    Array.isArray(facts.steps) &&
    facts.steps.every(
      (step) =>
        step &&
        typeof step.callId === "string" &&
        typeof step.tool === "string" &&
        typeof step.summary === "string" &&
        (step.target === undefined || typeof step.target === "string") &&
        Object.hasOwn(phases, step.phase) &&
        Object.hasOwn(outcomes, step.outcome),
    );
  if (!valid)
    return (
      <section className="herta-recovery-facts" role="alert">
        恢复事实记录格式无效，请检查原始执行记录。不会据此认定执行成功。
      </section>
    );
  return (
    <section className="herta-recovery-facts" aria-label="恢复执行事实">
      <h3>恢复执行事实</h3>
      <p>依据执行记录；角色回复仅作说明。未知结果不视为成功。</p>
      {Object.entries(phases).map(([phase, label]) => {
        const steps = facts.steps.filter((step) => step.phase === phase);
        return (
          <div key={phase}>
            <strong>
              {label} · {steps.length}
            </strong>
            {steps.length === 0 ? (
              <p>无</p>
            ) : (
              <ul>
                {steps.map((step) => (
                  <li key={`${phase}:${step.callId}`}>
                    <strong>
                      {step.tool} · {outcomes[step.outcome]}
                    </strong>
                    {step.target && <p className="herta-path">{step.target}</p>}
                    <p>{step.summary}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </section>
  );
}
