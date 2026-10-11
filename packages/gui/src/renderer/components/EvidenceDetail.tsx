import { useState } from "react";

const PAGE_SIZE = 8000;

/** Bound native text layout while keeping every character available. */
export function EvidenceDetail({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(text.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  let start = current * PAGE_SIZE;
  let end = Math.min(text.length, (current + 1) * PAGE_SIZE);
  // Keep a surrogate pair together; adjacent pages share the same boundary.
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start] ?? "")) start--;
  if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end] ?? "")) end--;
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>执行结果与证据</summary>
      {open && (
        <>
          {pages > 1 && (
            <fieldset>
              <legend>证据分页</legend>
              <p>
                第 {current + 1} / {pages} 页 · 全部内容按页保留
              </p>
              <button
                type="button"
                disabled={current === 0}
                onClick={() => setPage(current - 1)}
              >
                上一页
              </button>
              <button
                type="button"
                disabled={current === pages - 1}
                onClick={() => setPage(current + 1)}
              >
                下一页
              </button>
            </fieldset>
          )}
          <pre>{text.slice(start, end)}</pre>
        </>
      )}
    </details>
  );
}
