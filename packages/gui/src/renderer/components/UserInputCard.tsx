import { useEffect, useRef, useState } from "react";
import type {
  PendingUserInput,
  UserInputAnswer,
} from "../../shared/workbench-ipc.js";
import "./user-input-card.css";

type DraftValues = Record<string, { optionIds: string[]; text: string }>;
function readAnswers(key: string, request: PendingUserInput): DraftValues {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? "null");
    if (!saved || typeof saved !== "object") return {};
    const result: DraftValues = {};
    for (const q of request.questions) {
      const item = saved[q.id];
      if (!item || typeof item !== "object") continue;
      const selected = q.options
        .filter(
          (o) => Array.isArray(item.optionIds) && item.optionIds.includes(o.id),
        )
        .map((o) => o.id);
      result[q.id] = {
        optionIds:
          q.kind === "text"
            ? []
            : q.kind === "single"
              ? selected.slice(0, 1)
              : selected,
        text:
          (q.kind === "text" || q.allowText) && typeof item.text === "string"
            ? item.text.slice(0, 8000)
            : "",
      };
    }
    return result;
  } catch {
    return {};
  }
}

/** A submitted answer is explicit; highlighting an option never answers for the user. */
export function UserInputCard({
  request,
  onAnswer,
}: {
  request: PendingUserInput;
  onAnswer: (
    answer: UserInputAnswer,
  ) => Promise<{ accepted: boolean; deferred?: boolean }>;
}) {
  const draftKey = `the-herta.question-draft.v1.${request.sessionId}.${request.turnId}.${request.requestId}`;
  const [values, setValues] = useState<DraftValues>(() =>
    readAnswers(draftKey, request),
  );
  const consumed = useRef(false);
  const [localSaveFailed, setLocalSaveFailed] = useState(false);
  useEffect(() => {
    if (consumed.current) return;
    try {
      localStorage.setItem(draftKey, JSON.stringify(values));
      setLocalSaveFailed(false);
    } catch {
      setLocalSaveFailed(true);
    }
  }, [draftKey, values]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [deferred, setDeferred] = useState(false);
  const value = (id: string) => values[id] ?? { optionIds: [], text: "" };
  const complete = request.questions.every(
    (q) =>
      !q.required ||
      value(q.id).optionIds.length > 0 ||
      value(q.id).text.trim().length > 0,
  );
  async function submit(action: UserInputAnswer["action"]) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await onAnswer({
        schemaVersion: 1,
        requestId: request.requestId,
        sessionId: request.sessionId,
        turnId: request.turnId,
        action,
        answers:
          action === "answer"
            ? request.questions.map((q) => ({
                questionId: q.id,
                optionIds: value(q.id).optionIds,
                ...(value(q.id).text.trim()
                  ? { text: value(q.id).text.trim() }
                  : {}),
              }))
            : [],
      });
      if (!result.accepted)
        setError("该问题已失效或答案未被接受，请刷新任务后重试。");
      else if (action === "defer") setDeferred(true);
      else {
        consumed.current = true;
        try {
          localStorage.removeItem(draftKey);
        } catch {
          /* The consumed request cannot be resubmitted. */
        }
      }
    } catch {
      setError("答案未能保存，输入仍保留。请重试。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="herta-question-card" aria-label="需要你补充信息">
      <header>
        <strong>需要你补充信息</strong>
        <span>回答后继续</span>
      </header>
      {localSaveFailed && (
        <p role="status">
          草稿暂时只能保留在当前窗口，请勿切换任务或关闭窗口。
        </p>
      )}
      {deferred ? (
        <button type="button" onClick={() => setDeferred(false)}>
          返回问题 · 继续回答
        </button>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (complete) void submit("answer");
          }}
        >
          {request.questions.map((q) => (
            <fieldset key={q.id} disabled={busy}>
              <legend>
                {q.prompt}
                {q.required ? "" : "（可选）"}
              </legend>
              {q.kind !== "text" &&
                q.options.map((option) => (
                  <label className="herta-question-option" key={option.id}>
                    <input
                      type={q.kind === "single" ? "radio" : "checkbox"}
                      name={`${request.requestId}-${q.id}`}
                      checked={value(q.id).optionIds.includes(option.id)}
                      onChange={(e) => {
                        const old = value(q.id);
                        setValues({
                          ...values,
                          [q.id]: {
                            ...old,
                            optionIds:
                              q.kind === "single"
                                ? [option.id]
                                : e.target.checked
                                  ? [...old.optionIds, option.id]
                                  : old.optionIds.filter(
                                      (id) => id !== option.id,
                                    ),
                          },
                        });
                      }}
                    />
                    <span>
                      {option.label}
                      {option.description && (
                        <small>{option.description}</small>
                      )}
                    </span>
                  </label>
                ))}
              {(q.kind === "text" || q.allowText) && (
                <label className="herta-question-text">
                  {q.kind === "text" ? "你的回答" : "补充说明或其他答案"}
                  <textarea
                    maxLength={8000}
                    value={value(q.id).text}
                    onChange={(e) =>
                      setValues({
                        ...values,
                        [q.id]: { ...value(q.id), text: e.target.value },
                      })
                    }
                  />
                </label>
              )}
            </fieldset>
          ))}
          {error && <p role="alert">{error}</p>}
          <footer>
            <button type="submit" disabled={busy || !complete}>
              {busy ? "正在保存…" : "提交并继续"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void submit("defer")}
            >
              稍后回答
            </button>
            {request.questions.every((q) => !q.required) && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void submit("skip")}
              >
                跳过
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => void submit("cancel")}
            >
              取消此请求
            </button>
          </footer>
        </form>
      )}
    </section>
  );
}
