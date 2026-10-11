import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { NeutralMessage } from "@herta/providers";

export interface PendingUserInput {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly state: "waiting_for_input" | "answered" | "cancelled";
  readonly questions: readonly {
    readonly id: string;
    readonly prompt: string;
    readonly kind: "single" | "multiple" | "text";
    readonly required: boolean;
    readonly allowText: boolean;
    readonly options: readonly {
      readonly id: string;
      readonly label: string;
      readonly description?: string;
    }[];
  }[];
}
export interface UserInputAnswer {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly action: "answer" | "cancel" | "skip" | "defer";
  readonly answers: readonly {
    readonly questionId: string;
    readonly optionIds: readonly string[];
    readonly text?: string;
  }[];
}
export interface InputCheckpoint {
  request: PendingUserInput;
  messages: NeutralMessage[];
  callId: string;
  dispatched: boolean;
  answer?: UserInputAnswer;
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !keys.includes(k))
  )
    throw new Error("Invalid user input fields");
  return value as Record<string, unknown>;
}
function string(
  value: unknown,
  max: number,
  allowEmpty = false,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (!allowEmpty && !value.trim())
  )
    throw new Error("Invalid user input text");
}
function bounded(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value) ?? "", "utf8") > 65536)
    throw new Error("User input exceeds 64 KiB");
}
export function validateQuestions(
  value: unknown,
): PendingUserInput["questions"] {
  bounded(value);
  if (!Array.isArray(value) || !value.length || value.length > 8)
    throw new Error("Expected 1–8 questions");
  const ids = new Set<string>();
  for (const item of value) {
    const q = object(item, [
      "id",
      "prompt",
      "kind",
      "required",
      "allowText",
      "options",
    ]);
    string(q.id, 128);
    string(q.prompt, 2000);
    if (ids.has(q.id)) throw new Error("Duplicate question ID");
    ids.add(q.id);
    if (
      !["single", "multiple", "text"].includes(q.kind as string) ||
      typeof q.required !== "boolean" ||
      typeof q.allowText !== "boolean" ||
      !Array.isArray(q.options)
    )
      throw new Error("Invalid question shape");
    if (
      q.kind === "text"
        ? q.options.length !== 0
        : q.options.length < 1 || q.options.length > 12
    )
      throw new Error("Invalid option count");
    const options = new Set<string>();
    for (const item of q.options) {
      const o = object(item, ["id", "label", "description"]);
      string(o.id, 128);
      string(o.label, 300);
      if (o.description !== undefined) string(o.description, 1000, true);
      if (options.has(o.id)) throw new Error("Duplicate option ID");
      options.add(o.id);
    }
  }
  return structuredClone(value) as PendingUserInput["questions"];
}
export function validateAnswer(
  value: unknown,
  request: PendingUserInput,
): UserInputAnswer {
  bounded(value);
  const a = object(value, [
    "schemaVersion",
    "requestId",
    "sessionId",
    "turnId",
    "action",
    "answers",
  ]);
  if (
    request.state !== "waiting_for_input" ||
    a.schemaVersion !== 1 ||
    a.requestId !== request.requestId ||
    a.sessionId !== request.sessionId ||
    a.turnId !== request.turnId
  )
    throw new Error("Stale or foreign user input answer");
  if (
    !["answer", "cancel", "skip", "defer"].includes(a.action as string) ||
    !Array.isArray(a.answers)
  )
    throw new Error("Invalid answer action");
  if ((a.action === "cancel" || a.action === "defer") && a.answers.length)
    throw new Error("Cancel/defer cannot contain answers");
  const seen = new Set<string>();
  for (const item of a.answers) {
    const answer = object(item, ["questionId", "optionIds", "text"]);
    string(answer.questionId, 128);
    const q = request.questions.find((q) => q.id === answer.questionId);
    if (!q || seen.has(answer.questionId) || !Array.isArray(answer.optionIds))
      throw new Error("Unknown or duplicate answer");
    seen.add(answer.questionId);
    const options = answer.optionIds;
    if (
      new Set(options).size !== options.length ||
      options.some((id) => !q.options.some((o) => o.id === id)) ||
      (q.kind === "single" && options.length > 1) ||
      (q.kind === "text" && options.length)
    )
      throw new Error("Invalid selected options");
    if (answer.text !== undefined) {
      string(answer.text, 8000, true);
      if (q.kind !== "text" && !q.allowText)
        throw new Error("Free text is not allowed");
    }
    if (
      q.required &&
      !options.length &&
      !(typeof answer.text === "string" && answer.text.trim())
    )
      throw new Error("Required answer is empty");
  }
  if (a.action === "answer" || a.action === "skip") {
    if (request.questions.some((q) => q.required && !seen.has(q.id)))
      throw new Error("Required question unanswered");
  }
  return structuredClone(value) as UserInputAnswer;
}
/** Only neutral messages and answers; never stores provider credentials. Atomic replacement
 * means a failed write never releases execution. Consumed answers cannot replay tools. */
export class UserInputJournal {
  constructor(private readonly path: string) {}
  read(): InputCheckpoint | null {
    if (!existsSync(this.path)) return null;
    return JSON.parse(readFileSync(this.path, "utf8")) as InputCheckpoint;
  }
  write(checkpoint: InputCheckpoint): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(checkpoint), { mode: 0o600 });
    renameSync(temp, this.path);
  }
}
export const userInputTool = {
  name: "request_user_input",
  description:
    "Ask for missing human decisions before proceeding. 1–8 questions. A request suspends execution until the user explicitly answers. Never guess a required choice.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["questions"],
    properties: {
      questions: {
        type: "array",
        minItems: 1,
        maxItems: 8,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "id",
            "prompt",
            "kind",
            "required",
            "allowText",
            "options",
          ],
          properties: {
            id: { type: "string" },
            prompt: { type: "string" },
            kind: { type: "string", enum: ["single", "multiple", "text"] },
            required: { type: "boolean" },
            allowText: { type: "boolean" },
            options: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["id", "label"],
                properties: {
                  id: { type: "string" },
                  label: { type: "string" },
                  description: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
  },
};
