import type { RoundSummary } from "@herta/app-server";
import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { RoundDashboard } from "./RoundDashboard.js";
const round = (recordStart: number, steps: number): RoundSummary => ({
  schemaVersion: 1,
  id: `r${recordStart}`,
  sessionId: "s",
  attemptIds: ["a"],
  recordStart,
  startedAt: "2026-10-22T00:00:00Z",
  endedAt: "2026-10-22T00:01:00Z",
  durationMs: 60000,
  status: "completed",
  files: [],
  activities: Array.from({ length: steps }, (_, i) => ({ id: `t${i}`, attemptId: "a", kind: "command", title: "命令", status: "succeeded" as const, durationMs: 1, summary: "", files: [] })),
  metrics: { totalTokens: null, cacheHitRate: null, outputTokensPerSecond: null, contextUsed: null, contextWindow: null, partial: true },
  limitations: [],
});
it("does not invent missing usage or context percentage, and shows no placeholders for them (R72)",()=>{
 const view = render(<RoundDashboard rounds={[]} metrics={null}/>);
 expect(view.container.textContent).toBe("");
 expect(screen.queryByText(/用量|上下文|缓存|tok\/s|--/)).toBeNull();
});
it("shows actual zero usage but requires a known context window",()=>{
 render(<RoundDashboard rounds={[]} metrics={{totalTokens:0,cacheHitRate:0,outputTokensPerSecond:null,contextUsed:123,contextWindow:null,partial:false}}/>);
 expect(screen.getByText("用量 0 tok")).toBeInTheDocument();
 expect(screen.getByText("缓存 0%")).toBeInTheDocument();
 expect(screen.queryByText(/上下文/)).toBeNull();
});
it("counts rounds and steps, marking a count that older history makes a lower bound (R72)",()=>{
 const view = render(<RoundDashboard rounds={[round(0, 1), round(4, 2)]} metrics={null}/>);
 expect(screen.getByText("2 轮 · 2 步")).toBeInTheDocument();
 view.rerender(<RoundDashboard rounds={[round(6, 3)]} metrics={{totalTokens:1200,cacheHitRate:null,outputTokensPerSecond:null,contextUsed:500,contextWindow:1000,partial:true}}/>);
 expect(screen.getByText("1+ 轮 · 3 步")).toBeInTheDocument();
 expect(screen.getByText("用量 1,200 tok+")).toBeInTheDocument();
 expect(screen.getByText("上下文 50%")).toBeInTheDocument();
});
