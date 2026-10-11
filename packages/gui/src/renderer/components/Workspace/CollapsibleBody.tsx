import { useState } from "react";
import type { TFn } from "../../i18n/LocaleProvider.js";
import { useUnpinConversation } from "./ConversationPin.js";
import { DIFF_COLLAPSE_THRESHOLD, summarizeDiff } from "./diff-summary.js";

export interface CollapsibleBodyProps {
  readonly body: string;
  /** Class for the <pre> (e.g. "system-body" / "backend-body"). */
  readonly preClassName: string;
  /** SESSION-scoped translator (from `makeT(lang)`), passed down like the
   *  rest of the activity line's strings: this renders inside the record
   *  projection, so its labels follow the session interaction language, not
   *  the UI locale (ADR 0019 / ADR 0018). */
  readonly t: TFn;
  readonly threshold?: number;
  /**
   * Replaces the body's FIRST line with an element (2026-08-25).
   *
   * A patch row's headline is the animated `+96 −5`, which cannot be a string
   * — the digits count up. Everything below the first line (the fenced diff
   * and its disclosure) is unchanged, so the expander still opens the same
   * body it always did.
   */
  readonly headline?: JSX.Element;
  /**
   * Replaces the WHOLE body with an element carrying the same text
   * (ADR 0050: the file name inside it is a click target). Honored only on
   * the plain no-diff path — a fenced-diff body keeps its summary/expander
   * verbatim, and `headline` (which restructures the first line) wins.
   */
  readonly bodyNode?: JSX.Element | string;
}

/**
 * Renders a block body. A long fenced diff (> threshold lines) collapses to a
 * header + a summary disclosure; clicking expands the full body inline. Short
 * diffs and non-diff bodies render in full with no toggle.
 */
export function CollapsibleBody(props: CollapsibleBodyProps): JSX.Element {
  const t = props.t;
  const unpin = useUnpinConversation();
  const threshold = props.threshold ?? DIFF_COLLAPSE_THRESHOLD;
  const summary = summarizeDiff(props.body);
  const [expanded, setExpanded] = useState(false);

  if (!summary.hasDiff || summary.diffLineCount <= threshold) {
    if (props.headline === undefined) {
      return (
        <pre className={props.preClassName}>
          {!summary.hasDiff && props.bodyNode !== undefined
            ? props.bodyNode
            : props.body}
        </pre>
      );
    }
    // Headline as an element, the rest of the body verbatim beneath it.
    const nl = props.body.indexOf("\n");
    const rest = nl >= 0 ? props.body.slice(nl + 1) : "";
    return (
      <div className="collapsible-body">
        <pre className={props.preClassName}>{props.headline}</pre>
        {rest.trim().length > 0 && (
          <pre className={props.preClassName}>{rest}</pre>
        )}
      </div>
    );
  }

  return (
    <div className="collapsible-body">
      {props.headline !== undefined ? (
        <pre className={props.preClassName}>{props.headline}</pre>
      ) : (
        summary.preText.length > 0 && (
          <pre className={props.preClassName}>{summary.preText}</pre>
        )
      )}
      <button
        type="button"
        className="diff-disclosure"
        aria-expanded={expanded}
        onClick={() => {
          // Expanding grows the record BELOW this toggle by up to thousands
          // of px with no scroll event — unpin so the follow machinery can't
          // later yank the viewport past the diff (see ConversationPin.tsx).
          if (!expanded) unpin();
          setExpanded((v) => !v);
        }}
      >
        {expanded
          ? `▾ ${t("workspace.diffCollapse")}`
          : `▸ ${t("workspace.diffExpand", {
              n: summary.diffLineCount,
              add: summary.addCount,
              del: summary.delCount,
            })}`}
      </button>
      {expanded && (
        <pre
          className={props.preClassName}
        >{`\`\`\`diff\n${summary.diffText}\n\`\`\``}</pre>
      )}
    </div>
  );
}
