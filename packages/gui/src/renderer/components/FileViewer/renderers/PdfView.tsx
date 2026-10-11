import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useEffect, useRef, useState } from "react";
import { useT } from "../../../i18n/LocaleProvider.js";

/**
 * A PDF in the panel (ADR 0054 §4): pdf.js with its worker (the one CSP
 * directive this ADR opened), pages rendered to canvas at the panel's
 * width, lazily as they scroll into view, re-rendered when the width
 * changes. pdf.js 5+ compiles nothing with `new Function` (its v4
 * `isEvalSupported` switch is gone), so the packaged CSP's missing
 * unsafe-eval costs it nothing. The loading task, not the document, owns
 * teardown — `task.destroy()` on unmount cancels a load in flight and
 * releases a loaded document.
 */
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** Pages rendered above this count are throttled to what is on screen;
 *  a placeholder of the right size stands in for the rest. */
const RENDER_MARGIN = "600px";

interface PageInfo {
  readonly index: number;
  readonly width: number;
  readonly height: number;
}

export function PdfView({
  bytes,
}: {
  readonly bytes: Uint8Array;
}): JSX.Element {
  const t = useT();
  const [doc, setDoc] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [pages, setPages] = useState<readonly PageInfo[]>([]);
  const [failed, setFailed] = useState(false);
  const [width, setWidth] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Open the document once per bytes; page sizes come from the first page
  // (mixed-size documents refine per page when they render).
  useEffect(() => {
    let alive = true;
    setDoc(null);
    setPages([]);
    setFailed(false);
    const task = pdfjs.getDocument({
      data: bytes.slice(),
      disableAutoFetch: true,
    });
    void task.promise.then(
      async (d) => {
        if (!alive) return;
        const infos: PageInfo[] = [];
        for (let i = 1; i <= d.numPages; i++) {
          // Sizes for every page: getPage is cheap (the content stream is
          // not parsed until render) and a mixed deck otherwise jumps.
          const p = await d.getPage(i);
          if (!alive) return;
          const vp = p.getViewport({ scale: 1 });
          infos.push({ index: i, width: vp.width, height: vp.height });
        }
        setDoc(d);
        setPages(infos);
      },
      () => {
        if (alive) setFailed(true);
      },
    );
    return () => {
      alive = false;
      void task.destroy();
    };
  }, [bytes]);

  // Fit-to-width: the scroller's inner width minus the page gutter.
  // clientWidth excludes the vertical scrollbar, which only appears once
  // the pages have their height — and a ResizeObserver does not fire for
  // it (the box itself did not change) — so re-measure when the pages land
  // too, or the first layout is 10px too wide and scrolls sideways.
  useEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    const measure = (): void => setWidth(el.clientWidth);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const el = scrollRef.current;
    if (el !== null && pages.length > 0) setWidth(el.clientWidth);
  }, [pages.length]);

  if (failed) {
    return (
      <div className="file-viewer__body">
        <p className="file-viewer__notice">{t("viewer.renderFailed")}</p>
      </div>
    );
  }
  const pageW = Math.max(120, width - 32);
  return (
    <div className="file-viewer__body">
      <div ref={scrollRef} className="file-viewer__scroll file-viewer__pdf">
        {doc === null ? (
          <p className="file-viewer__notice">{t("viewer.rendering")}</p>
        ) : (
          pages.map((p) => (
            <PdfPage key={p.index} doc={doc} info={p} width={pageW} />
          ))
        )}
      </div>
      {pages.length > 0 && (
        <p className="file-viewer__notice file-viewer__pdf-meta">
          {t("viewer.pdfPages", { n: pages.length })}
        </p>
      )}
    </div>
  );
}

function PdfPage({
  doc,
  info,
  width,
}: {
  readonly doc: pdfjs.PDFDocumentProxy;
  readonly info: PageInfo;
  readonly width: number;
}): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [visible, setVisible] = useState(false);
  const scale = width / info.width;
  const height = Math.round(info.height * scale);

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) setVisible(e.isIntersecting);
      },
      { rootMargin: RENDER_MARGIN },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    const canvas = canvasRef.current;
    if (canvas === null) return;
    let alive = true;
    let task: pdfjs.RenderTask | null = null;
    void doc.getPage(info.index).then(
      (page) => {
        if (!alive) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const viewport = page.getViewport({ scale: scale * dpr });
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        const ctx = canvas.getContext("2d");
        if (ctx === null) return;
        task = page.render({ canvas, canvasContext: ctx, viewport });
        task.promise.catch(() => undefined);
      },
      () => undefined,
    );
    return () => {
      alive = false;
      task?.cancel();
    };
  }, [visible, doc, info.index, scale, width, height]);

  return (
    <div
      ref={ref}
      className="file-viewer__pdf-page"
      style={{ width, height }}
      data-page={info.index}
    >
      {visible && <canvas ref={canvasRef} />}
    </div>
  );
}
