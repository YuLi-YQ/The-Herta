import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingUserInput } from "../../shared/workbench-ipc.js";
import { UserInputCard } from "./UserInputCard.js";

const request: PendingUserInput = {
  schemaVersion: 1,
  requestId: "r1",
  sessionId: "s1",
  turnId: "t1",
  state: "waiting_for_input",
  questions: [
    {
      id: "q1",
      prompt: "选择范围",
      kind: "single",
      required: true,
      allowText: true,
      options: [
        { id: "a", label: "当前项目" },
        { id: "b", label: "全部项目" },
      ],
    },
  ],
};
describe("UserInputCard", () => {
  beforeEach(() => localStorage.clear());
  it("restores choices and text after remount without submitting, then clears accepted drafts", async () => {
    const answer = vi.fn().mockResolvedValue({ accepted: true });
    const first = render(<UserInputCard request={request} onAnswer={answer} />);
    fireEvent.click(screen.getByRole("radio", { name: "当前项目" }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "保留这段草稿" },
    });
    first.unmount();
    render(<UserInputCard request={request} onAnswer={answer} />);
    expect(screen.getByRole("radio", { name: "当前项目" })).toBeChecked();
    expect(screen.getByRole("textbox")).toHaveValue("保留这段草稿");
    expect(answer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "提交并继续" }));
    await waitFor(() =>
      expect(
        localStorage.getItem("the-herta.question-draft.v1.s1.t1.r1"),
      ).toBeNull(),
    );
  });
  it("isolates drafts by request and tolerates malformed storage", () => {
    localStorage.setItem(
      "the-herta.question-draft.v1.s1.t1.other",
      JSON.stringify({ q1: { optionIds: ["a"], text: "旧答案" } }),
    );
    localStorage.setItem(
      "the-herta.question-draft.v1.s1.t1.r1",
      "invalid json",
    );
    const answer = vi.fn();
    render(<UserInputCard request={request} onAnswer={answer} />);
    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(screen.getByRole("radio", { name: "当前项目" })).not.toBeChecked();
    expect(answer).not.toHaveBeenCalled();
  });
  it("requires explicit submit and binds the answer to the original request", async () => {
    const answer = vi.fn().mockResolvedValue({ accepted: true });
    render(<UserInputCard request={request} onAnswer={answer} />);
    expect(screen.getByRole("button", { name: "提交并继续" })).toBeDisabled();
    fireEvent.click(screen.getByRole("radio", { name: "当前项目" }));
    expect(answer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "提交并继续" }));
    await waitFor(() =>
      expect(answer).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: "r1",
          sessionId: "s1",
          turnId: "t1",
          action: "answer",
          answers: [{ questionId: "q1", optionIds: ["a"] }],
        }),
      ),
    );
  });
  it("keeps free text when submission fails", async () => {
    const answer = vi.fn().mockRejectedValue(new Error("offline"));
    render(<UserInputCard request={request} onAnswer={answer} />);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "仅修布局" },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交并继续" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("textbox")).toHaveValue("仅修布局");
  });
  it("defers without an answer and lets the user return", async () => {
    const answer = vi
      .fn()
      .mockResolvedValue({ accepted: true, deferred: true });
    render(<UserInputCard request={request} onAnswer={answer} />);
    fireEvent.click(screen.getByRole("button", { name: "稍后回答" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "返回问题 · 继续回答" }),
    );
    expect(screen.getByRole("radio", { name: "当前项目" })).not.toBeChecked();
    expect(answer).toHaveBeenCalledWith(
      expect.objectContaining({ action: "defer", answers: [] }),
    );
  });
  it("supports multiple selections plus required text in one submission", async () => {
    const answer = vi.fn().mockResolvedValue({ accepted: true });
    render(
      <UserInputCard
        request={{
          ...request,
          questions: [
            { ...request.questions[0]!, kind: "multiple", allowText: false },
            {
              id: "q2",
              prompt: "说明",
              kind: "text",
              required: true,
              allowText: true,
              options: [],
            },
          ],
        }}
        onAnswer={answer}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "当前项目" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "全部项目" }));
    expect(screen.getByRole("button", { name: "提交并继续" })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "一起处理" },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交并继续" }));
    await waitFor(() =>
      expect(answer).toHaveBeenCalledWith(
        expect.objectContaining({
          answers: [
            { questionId: "q1", optionIds: ["a", "b"] },
            { questionId: "q2", optionIds: [], text: "一起处理" },
          ],
        }),
      ),
    );
  });
});
