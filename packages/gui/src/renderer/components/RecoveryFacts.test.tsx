// @vitest-environment jsdom

import type { RecoverySummary } from "@herta/core";
import { render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { RecoveryFacts } from "./RecoveryFacts.js";

it("shows a damaged archive fact record without crashing or claiming success", () => {
  render(
    <RecoveryFacts
      facts={{ version: 1, steps: null } as unknown as RecoverySummary}
    />,
  );
  expect(screen.getByRole("alert").textContent).toContain(
    "恢复事实记录格式无效",
  );
});

it("separates journal phases and does not reinterpret prose or unknown outcomes", () => {
  render(
    <RecoveryFacts
      facts={{
        version: 1,
        runId: "run",
        state: "interrupted",
        steps: [
          {
            callId: "a",
            tool: "write_new_file",
            target: "已完成.txt",
            phase: "previously-completed",
            outcome: "succeeded",
            summary: "工具记录：此前写入",
          },
          {
            callId: "b",
            tool: "write_new_file",
            target: "待执行.txt",
            phase: "resumed",
            outcome: "denied",
            summary: "审批拒绝",
          },
          {
            callId: "c",
            tool: "run_command",
            phase: "uncertain",
            outcome: "unknown",
            summary: "模型声称成功，执行记录未确认 <script>",
          },
        ],
      }}
    />,
  );
  const facts = screen.getByRole("region", { name: "恢复执行事实" });
  expect(within(facts).getByText("此前已完成（未重复执行） · 1")).toBeTruthy();
  expect(within(facts).getByText("本次恢复执行 · 1")).toBeTruthy();
  expect(within(facts).getByText("结果不确定，需检查 · 1")).toBeTruthy();
  expect(within(facts).getByText("run_command · 未确认")).toBeTruthy();
  expect(facts.querySelector("script")).toBeNull();
});
