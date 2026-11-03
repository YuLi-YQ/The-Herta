import type { RoundSummary } from "@herta/app-server";
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SessionSnapshot } from "../ipc/bridge-types.js";

// Records which rounds the workbench renders, frame by frame.
const renders = vi.hoisted(() => [] as string[]);
vi.mock(import("./RoundResults.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  RoundResults: ({ round }: { round: RoundSummary }) => {
    renders.push(round.id);
    return <div>结果 {round.id}</div>;
  },
}));
import { App } from "../App.js";
import { createMockHertaBridge } from "../ipc/mock-bridge.js";

const snapshot = (
  id: string,
  record: SessionSnapshot["record"],
): SessionSnapshot => ({
  sessionId: id,
  workspaceRoot: "C:\黑塔 实验室",
  backendWorkspace: "C:\黑塔 实验室",
  backendWorkspaceIsDefault: false,
  overlay: null,
  record,
});
const round = (id: string, sessionId: string): RoundSummary => ({
  schemaVersion: 1,
  id,
  sessionId,
  attemptIds: ["a"],
  recordStart: 0,
  startedAt: "2026-10-22T00:00:00Z",
  endedAt: "2026-10-22T00:01:00Z",
  durationMs: 60000,
  status: "completed",
  files: [],
  activities: [],
  metrics: {
    totalTokens: null,
    cacheHitRate: null,
    outputTokensPerSecond: null,
    contextUsed: null,
    contextWindow: null,
    partial: true,
  },
  limitations: [],
});

describe("workbench task switches (R71)", () => {
  it("never renders the previous task's round results for the new task, not even for one frame", async () => {
    const mock = createMockHertaBridge();
    mock.bridge.getRoundSummaries = vi.fn((id: string) =>
      id === "task-a"
        ? Promise.resolve([round("round-a", "task-a")])
        : new Promise<RoundSummary[]>(() => undefined),
    );
    render(<App bridge={mock.bridge} />);
    act(() => mock.emitReset(snapshot("task-a", [{ kind: "user", text: "甲任务" }])));
    await screen.findByText("结果 round-a");
    renders.length = 0;
    act(() => mock.emitReset(snapshot("task-b", [{ kind: "user", text: "乙任务" }])));
    await screen.findByText("乙任务");
    expect(renders).not.toContain("round-a");
    expect(screen.queryByText("结果 round-a")).toBeNull();
  });

  it("keeps the record rows mounted when the task's round results arrive", async () => {
    const mock = createMockHertaBridge();
    let resolve!: (rounds: RoundSummary[]) => void;
    mock.bridge.getRoundSummaries = vi.fn(
      () =>
        new Promise<RoundSummary[]>((done) => {
          resolve = done;
        }),
    );
    render(<App bridge={mock.bridge} />);
    act(() => mock.emitReset(snapshot("task-a", [{ kind: "user", text: "甲任务" }])));
    const row = (await screen.findByText("甲任务")).closest("article");
    expect(row).not.toBeNull();
    await act(async () => resolve([round("round-a", "task-a")]));
    await screen.findByText("结果 round-a");
    expect(row?.isConnected).toBe(true);
    expect(screen.getByText("甲任务").closest("article")).toBe(row);
  });
});
