import { renderAsync } from "docx-preview";
import { useEffect, useRef, useState } from "react";
import { useT } from "../../../i18n/LocaleProvider.js";

/**
 * A Word document in the panel (ADR 0054 §4): docx-preview renders the
 * package into the container as flowing pages — styles, numbering,
 * tables, embedded pictures (base64 URLs, so nothing leaves the sandbox),
 * headers and footers. `ignoreWidth` because a fixed Letter/A4 page is
 * wider than the panel; the page keeps its margins and flows at the
 * panel's width instead. Links are inert (the scroller swallows clicks on
 * anchors); `will-navigate` remains the backstop.
 */
export function DocxView({
  bytes,
}: {
  readonly bytes: Uint8Array;
}): JSX.Element {
  const t = useT();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const styleRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<"rendering" | "done" | "failed">(
    "rendering",
  );

  useEffect(() => {
    const body = bodyRef.current;
    const styles = styleRef.current;
    if (body === null || styles === null) return;
    let alive = true;
    setState("rendering");
    body.replaceChildren();
    styles.replaceChildren();
    renderAsync(bytes, body, styles, {
      className: "docx",
      inWrapper: true,
      ignoreWidth: true,
      ignoreHeight: true,
      ignoreFonts: false,
      breakPages: true,
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: true,
      renderEndnotes: true,
      useBase64URL: true,
      renderChanges: false,
      trimXmlDeclaration: true,
    }).then(
      () => {
        if (alive) setState("done");
      },
      () => {
        if (alive) setState("failed");
      },
    );
    return () => {
      alive = false;
    };
  }, [bytes]);

  return (
    <div className="file-viewer__body">
      <div
        className="file-viewer__scroll file-viewer__docx"
        onClickCapture={(e) => {
          if ((e.target as Element).closest("a") !== null) e.preventDefault();
        }}
      >
        {state === "rendering" && (
          <p className="file-viewer__notice">{t("viewer.rendering")}</p>
        )}
        {state === "failed" && (
          <p className="file-viewer__notice">{t("viewer.renderFailed")}</p>
        )}
        <div ref={styleRef} hidden={state === "failed"} />
        <div ref={bodyRef} hidden={state === "failed"} />
      </div>
    </div>
  );
}
