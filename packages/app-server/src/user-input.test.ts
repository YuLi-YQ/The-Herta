import { describe, expect, it } from "vitest";
import {
  type PendingUserInput,
  validateAnswer,
  validateQuestions,
} from "./user-input.js";

const questions = [
  {
    id: "q",
    prompt: "选择方案",
    kind: "single",
    required: true,
    allowText: true,
    options: [
      { id: "a", label: "方案 A" },
      { id: "b", label: "方案 B" },
    ],
  },
] as const;
const request: PendingUserInput = {
  schemaVersion: 1,
  requestId: "r",
  sessionId: "s",
  turnId: "t",
  state: "waiting_for_input",
  questions,
};
const answer = {
  schemaVersion: 1,
  requestId: "r",
  sessionId: "s",
  turnId: "t",
  action: "answer",
  answers: [{ questionId: "q", optionIds: ["a"], text: "中文补充" }],
};
describe("structured human input validation", () => {
  it("accepts multiple selections and required text; rejects whitespace-only required text", () => {
    const mixed: PendingUserInput = {
      ...request,
      questions: [
        { ...questions[0], kind: "multiple", allowText: false },
        {
          id: "text",
          prompt: "说明",
          kind: "text",
          required: true,
          allowText: true,
          options: [],
        },
      ],
    };
    const submitted = {
      ...answer,
      answers: [
        { questionId: "q", optionIds: ["a", "b"] },
        { questionId: "text", optionIds: [], text: "详细中文说明" },
      ],
    };
    expect(validateQuestions(mixed.questions)).toEqual(mixed.questions);
    expect(validateAnswer(submitted, mixed)).toEqual(submitted);
    expect(() =>
      validateAnswer(
        {
          ...submitted,
          answers: [
            { questionId: "q", optionIds: ["a", "b"] },
            { questionId: "text", optionIds: [], text: "   " },
          ],
        },
        mixed,
      ),
    ).toThrow();
  });
  it("accepts mixed choice/text and rejects foreign, stale, duplicate and unknown answers", () => {
    expect(validateQuestions(questions)).toEqual(questions);
    expect(validateAnswer(answer, request)).toEqual(answer);
    for (const value of [
      { ...answer, sessionId: "foreign" },
      { ...answer, turnId: "old" },
      { ...answer, surprise: true },
      { ...answer, answers: [...answer.answers, ...answer.answers] },
      { ...answer, answers: [{ questionId: "q", optionIds: ["unknown"] }] },
      { ...answer, answers: [{ questionId: "q", optionIds: ["a", "b"] }] },
      { ...answer, answers: [] },
    ])
      expect(() => validateAnswer(value, request)).toThrow();
    expect(() =>
      validateAnswer(answer, { ...request, state: "answered" }),
    ).toThrow();
  });
  it("defer/cancel never synthesize an answer; skip cannot omit required questions", () => {
    for (const action of ["defer", "cancel"])
      expect(
        validateAnswer({ ...answer, action, answers: [] }, request).action,
      ).toBe(action);
    expect(() =>
      validateAnswer({ ...answer, action: "skip", answers: [] }, request),
    ).toThrow();
    expect(() =>
      validateAnswer({ ...answer, action: "defer" }, request),
    ).toThrow();
    expect(
      validateAnswer(
        { ...answer, action: "skip", answers: [] },
        { ...request, questions: [{ ...questions[0], required: false }] },
      ).action,
    ).toBe("skip");
  });
  it("bounds questions, text, duplicate IDs and no-text choices", () => {
    for (const value of [
      [],
      Array(9).fill(questions[0]),
      [questions[0], questions[0]],
      [{ ...questions[0], prompt: "a".repeat(2001) }],
      [{ ...questions[0], kind: "text" }],
    ])
      expect(() => validateQuestions(value)).toThrow();
    expect(() =>
      validateAnswer(answer, {
        ...request,
        questions: [{ ...questions[0], allowText: false }],
      }),
    ).toThrow();
    expect(() =>
      validateAnswer(
        {
          ...answer,
          answers: [{ questionId: "q", optionIds: [], text: "a".repeat(8001) }],
        },
        request,
      ),
    ).toThrow();
  });
});
