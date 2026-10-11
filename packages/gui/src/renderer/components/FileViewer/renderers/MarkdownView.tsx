import { Marked } from "marked";
import { useEffect, useRef } from "react";
import { useT } from "../../../i18n/LocaleProvider.js";
import { sanitizedFragment, setSanitizedHtml } from "./dom-html.js";

/**
 * Markdown as the page (ADR 0054 §4): `marked` (GFM) → DOMPurify → DOM,
 * then two passes over the fences — ```mermaid becomes a diagram (lazy
 * chunk, strict security level) and every other fence gets highlight.js
 * tokens when its language is known. Both passes are async and keyed to
 * the content they were started for, so a file switched mid-render never
 * paints into the wrong document.
 */
const marked = new Marked({ gfm: true, breaks: false, async: false });

/** Fences above this many are left plain — a generated dump with hundreds
 *  of code blocks is not a page anyone reads token by token. */
const MAX_HIGHLIGHTED_FENCES = 200;
const MAX_DIAGRAMS = 40;

function fenceLanguage(code: HTMLElement): string | null {
  const cls = [...code.classList].find((c) => c.startsWith("language-"));
  return cls === undefined ? null : cls.slice("language-".length);
}

export function MarkdownView({
  content,
  truncated,
}: {
  readonly content: string;
  readonly truncated: boolean;
}): JSX.Element {
  const t = useT();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const diagramFailedLabel = t("viewer.diagramFailed");

  useEffect(() => {
    const root = bodyRef.current;
    if (root === null) return;
    let alive = true;
    const html = marked.parse(content) as string;
    const frag = sanitizedFragment(html);
    root.replaceChildren(frag);

    // Fences: diagrams first (they replace the block), then tokens.
    const fences = [...root.querySelectorAll<HTMLElement>("pre > code")];
    const diagrams = fences
      .filter((c) => fenceLanguage(c) === "mermaid")
      .slice(0, MAX_DIAGRAMS);
    const others = fences
      .filter((c) => fenceLanguage(c) !== "mermaid")
      .slice(0, MAX_HIGHLIGHTED_FENCES);

    if (diagrams.length > 0) {
      void import("./mermaid-render.js").then(
        async ({ renderMermaid }) => {
          for (const code of diagrams) {
            if (!alive) return;
            const pre = code.parentElement;
            if (pre === null) continue;
            const source = code.textContent ?? "";
            try {
              const svg = await renderMermaid(source);
              if (!alive) return;
              const figure = document.createElement("figure");
              figure.className = "file-viewer__diagram";
              figure.append(svg);
              pre.replaceWith(figure);
            } catch {
              if (!alive) return;
              // The source stays visible, labeled honestly — never a blank
              // hole where a diagram was promised.
              const note = document.createElement("p");
              note.className = "file-viewer__diagram-failed";
              note.textContent = diagramFailedLabel;
              pre.before(note);
            }
          }
        },
        () => undefined,
      );
    }

    if (others.length > 0) {
      void import("./highlight.js").then(
        (h) => {
          if (!alive) return;
          for (const code of others) {
            const lang = fenceLanguage(code);
            if (lang === null) continue;
            const html = h.highlightToHtml(code.textContent ?? "", lang);
            if (html !== null) setSanitizedHtml(code, html);
          }
        },
        () => undefined,
      );
    }

    return () => {
      alive = false;
    };
  }, [content, diagramFailedLabel]);

  return (
    <div className="file-viewer__body">
      <div className="file-viewer__scroll">
        <div ref={bodyRef} className="file-viewer__doc" />
      </div>
      {truncated && (
        <p className="file-viewer__notice">{t("viewer.truncatedNote")}</p>
      )}
    </div>
  );
}
