/* biome-ignore-all lint/suspicious/noArrayIndexKey: Markdown source order is append-only while streaming; positional keys retain code DOM and selection across token updates. */
import type { Token } from "marked";

import { memo, type ReactNode, useMemo, useState } from "react";
import { useHertaBridge } from "../context/HertaBridgeContext.js";
import { sanitizedFragment } from "./FileViewer/renderers/dom-html.js";
import { highlightToHtml } from "./FileViewer/renderers/highlight.js";
import {
  CODE_PAGE_SIZE,
  codePage,
  exactCode,
  messageTokens,
  safeMessageUrl,
} from "./message-content.js";
import "./message-content.css";
import { MemoryProposal } from "./ChatMemory.js";
import type { HertaChatAction } from "../../shared/herta-chat.js";

// Model HTML is always text. Tokens become React elements, never innerHTML.
interface ViewToken {
  type: string;
  raw?: string;
  text?: string;
  tokens?: Token[];
  depth?: number;
  href?: string;
  lang?: string;
  ordered?: boolean;
  start?: number;
  items?: ViewToken[];
  header?: { tokens: Token[] }[];
  rows?: { tokens: Token[] }[][];
}

function highlightedCode(text: string, language: string): ReactNode {
  const html = highlightToHtml(text, language);
  if (html === null) return text;
  // Only highlighter-generated, sanitized text/span nodes reach React.
  // No model markup, attributes, CSS, event handlers or URLs are adopted.
  const fragment = sanitizedFragment(html);
  function convert(node: Node, key: string): ReactNode {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    if (!(node instanceof HTMLElement) || node.tagName !== "SPAN") {
      return node.textContent;
    }
    const classes = [...node.classList].filter((value) =>
      /^hljs-[a-z][a-z0-9_-]*$/.test(value),
    );
    return (
      <span key={key} className={classes.join(" ") || undefined}>
        {[...node.childNodes].map((child, index) =>
          convert(child, `${key}.${index}`),
        )}
      </span>
    );
  }
  return [...fragment.childNodes].map((node, index) =>
    convert(node, `highlight-${index}`),
  );
}

function CodeBlock({
  text,
  language,
  streaming,
  downloadable = false,
}: {
  text: string;
  language: string;
  streaming: boolean;
  downloadable?: boolean;
}) {
  const { bridge } = useHertaBridge();
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(0);
  const [notice, setNotice] = useState("");
  const pages = Math.max(1, Math.ceil(text.length / CODE_PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const long = text.length > 2000 || text.split("\n", 26).length > 24;
  const shown = long && !open ? text.slice(0, 1000) : codePage(text, current);
  // Streaming stays a stable text node: syntax retokenization cannot replace
  // the selection on every incoming token. Highlight once the reply settles.
  const code = useMemo(
    () => (streaming ? shown : highlightedCode(shown, language)),
    [shown, language, streaming],
  );
  return (
    <section className="message-code" aria-label="代码块">
      <div className="message-code__toolbar">
        <span>{language || "代码"}</span>
        {downloadable && !streaming && bridge.saveChatFile && (
          <button
            type="button"
            onClick={async () => {
              const ext: Record<string, string> = {
                markdown: "md",
                python: "py",
                javascript: "js",
                typescript: "ts",
                text: "txt",
                plaintext: "txt",
                powershell: "ps1",
                bash: "sh",
              };
              const suffix =
                ext[language] ??
                (/^[a-z0-9]{1,10}$/.test(language) ? language : "txt");
              try {
                const r = await bridge.saveChatFile!(
                  "Herta-document." + suffix,
                  text,
                );
                setNotice(
                  r.saved ? "文件已保存" : r.failed ? "保存失败" : "已取消",
                );
              } catch {
                setNotice("保存失败");
              }
            }}
          >
            保存文件
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(text).then(
              () => setNotice("已复制代码"),
              () => setNotice("复制失败"),
            );
          }}
        >
          复制代码
        </button>
        {long && (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {open ? "折叠代码" : "展开代码"}
          </button>
        )}
        <span role="status">{notice}</span>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
      {long && !open && (
        <p className="message-code__note">代码已折叠 · 复制包含全部原文</p>
      )}
      {open && pages > 1 && (
        <fieldset className="message-code__pages">
          <legend>代码分页</legend>
          <button
            type="button"
            disabled={current === 0}
            onClick={() => setPage(current - 1)}
          >
            上一页
          </button>
          <span>
            第 {current + 1} / {pages} 页
          </span>
          <button
            type="button"
            disabled={current === pages - 1}
            onClick={() => setPage(current + 1)}
          >
            下一页
          </button>
        </fieldset>
      )}
    </section>
  );
}

export const MessageContent = memo(function MessageContent({
  text,
  streaming = false,
  onMemory,
  memoryItems,
  downloadable = false,
}: {
  text: string;
  streaming?: boolean;
  onMemory?: (
    action: Extract<HertaChatAction, { type: "memory" }>,
  ) => Promise<boolean>;
  memoryItems?: { id: string; text: string }[];
  downloadable?: boolean;
}) {
  const { bridge } = useHertaBridge();
  const tokens = useMemo(() => messageTokens(text), [text]);
  const [notice, setNotice] = useState("");
  function nodes(list: readonly Token[] | undefined): ReactNode {
    return list?.map((source, index) => {
      const token = source as unknown as ViewToken;
      const inner = token.tokens ? nodes(token.tokens) : token.text;
      switch (token.type) {
        case "space":
          return null;
        case "paragraph":
          return <p key={index}>{inner}</p>;
        case "heading":
          return (
            <p
              className={`message-content__heading message-content__heading-${token.depth}`}
              key={index}
            >
              {inner}
            </p>
          );
        case "strong":
          return <strong key={index}>{inner}</strong>;
        case "em":
          return <em key={index}>{inner}</em>;
        case "del":
          return <del key={index}>{inner}</del>;
        case "codespan":
          return <code key={index}>{token.text}</code>;
        case "br":
          return <br key={index} />;
        case "hr":
          return <hr key={index} />;
        case "blockquote":
          return <blockquote key={index}>{inner}</blockquote>;
        case "code":
          if (token.lang === "herta-memory" && onMemory)
            return streaming ? (
              <p key={index}>正在准备记忆建议…</p>
            ) : (
              <MemoryProposal
                key={index}
                text={token.text ?? ""}
                items={memoryItems}
                onManage={onMemory}
              />
            );
          return (
            <CodeBlock
              key={index}
              text={exactCode(token.raw ?? "", token.text ?? "")}
              language={token.lang?.split(/\s/)[0] ?? ""}
              streaming={streaming}
              downloadable={downloadable}
            />
          );
        case "list":
          return token.ordered ? (
            <ol key={index} start={token.start}>
              {token.items?.map((item, i) => (
                <li key={i}>{nodes(item.tokens)}</li>
              ))}
            </ol>
          ) : (
            <ul key={index}>
              {token.items?.map((item, i) => (
                <li key={i}>{nodes(item.tokens)}</li>
              ))}
            </ul>
          );
        case "table":
          return (
            <div className="message-content__table" key={index}>
              <table>
                <thead>
                  <tr>
                    {token.header?.map((cell, i) => (
                      <th key={i}>{nodes(cell.tokens)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {token.rows?.map((row, i) => (
                    <tr key={i}>
                      {row.map((cell, j) => (
                        <td key={j}>{nodes(cell.tokens)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        case "link": {
          const href = safeMessageUrl(token.href ?? "");
          return href ? (
            <a
              key={index}
              href={href}
              onClick={(event) => {
                event.preventDefault();
                void bridge
                  .openExternal?.(href)
                  .catch(() => setNotice("链接未能打开"));
              }}
            >
              {inner}
            </a>
          ) : (
            <span key={index}>{inner}</span>
          );
        }
        case "image":
          return <span key={index}>[图片：{token.text || "未加载"}]</span>;
        case "html":
          return <span key={index}>{token.raw ?? token.text}</span>;
        default:
          return <span key={index}>{inner ?? token.raw}</span>;
      }
    });
  }
  return (
    <div className="message-content" data-streaming={streaming || undefined}>
      <div className="message-content__body">{nodes(tokens)}</div>
      <div className="message-content__actions">
        <button
          type="button"
          className="message-copy-icon"
          aria-label="复制原文"
          title={notice || "复制原文"}
          onClick={() => {
            void navigator.clipboard.writeText(text).then(
              () => setNotice("已复制原文"),
              () => setNotice("复制失败"),
            );
          }}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            aria-hidden="true"
          >
            <rect x="4" y="8" width="12" height="13" rx="2" />
            <path d="M8 8V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-2" />
          </svg>
        </button>
        <span role="status">{notice}</span>
      </div>
    </div>
  );
});
