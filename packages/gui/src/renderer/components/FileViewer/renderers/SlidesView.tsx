import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useT } from "../../../i18n/LocaleProvider.js";
import { imageMimeFor } from "./blob-url.js";
import {
  type Deck,
  type Fill,
  type Paragraph,
  parseDeck,
  type Shape,
  type Slide,
} from "./pptx.js";

/**
 * A deck in the panel (ADR 0054 §4): a thumbnail strip and the current
 * slide, both the same DOM at different scales — the slide is laid out at
 * its natural pixel size and CSS-scaled to fit, so text wraps where the
 * deck wraps it. Media draws from blob: URLs this view mints and revokes.
 */
const THUMB_W = 132;
const MAIN_PAD = 24;

function fillStyle(fill: Fill | null): CSSProperties {
  if (fill === null) return {};
  if (fill.kind === "solid") return { backgroundColor: fill.color };
  if (fill.kind === "gradient") return { backgroundImage: fill.css };
  return {
    backgroundImage: `url("${fill.src}")`,
    backgroundSize: "cover",
    backgroundPosition: "center",
  };
}

function ParagraphBlock({ p }: { readonly p: Paragraph }): JSX.Element {
  const lineHeight = 1.2 * p.lineSpacing;
  const hasText = p.runs.some((r) => r.text.length > 0);
  if (!hasText) {
    return (
      <div
        className="file-viewer__pp"
        style={{ height: p.emptySize * lineHeight, marginTop: p.spaceBefore }}
      />
    );
  }
  const hanging = Math.max(0, -p.indent);
  const left = Math.max(0, p.marL + Math.min(0, p.indent));
  const first = p.runs.find((r) => r.text.length > 0);
  return (
    <div
      className="file-viewer__pp"
      style={{
        textAlign: p.align,
        marginTop: p.spaceBefore,
        marginBottom: p.spaceAfter,
        lineHeight,
        paddingLeft: left,
        display: p.bullet === null ? "block" : "flex",
        textIndent: p.bullet === null ? Math.max(0, p.indent) : 0,
      }}
    >
      {p.bullet !== null && (
        <span
          className="file-viewer__bullet"
          style={{
            width: Math.max(hanging, (first?.size ?? 16) * 0.9),
            fontSize: first?.size ?? 16,
            color: p.bulletColor ?? undefined,
          }}
        >
          {p.bullet}
        </span>
      )}
      <span className="file-viewer__runs">
        {p.runs.map((r, i) =>
          r.break === true ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: runs are static per parse
            <br key={i} />
          ) : (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: runs are static per parse
              key={i}
              style={{
                fontSize: r.size,
                fontWeight: r.bold ? 700 : 400,
                fontStyle: r.italic ? "italic" : "normal",
                textDecoration:
                  r.underline && r.strike
                    ? "underline line-through"
                    : r.underline
                      ? "underline"
                      : r.strike
                        ? "line-through"
                        : "none",
                color: r.color ?? undefined,
              }}
            >
              {r.text}
            </span>
          ),
        )}
      </span>
    </div>
  );
}

function boxStyle(s: Shape): CSSProperties {
  const { box } = s;
  const transforms: string[] = [];
  if (box.rot !== 0) transforms.push(`rotate(${box.rot}deg)`);
  if (box.flipH) transforms.push("scaleX(-1)");
  if (box.flipV) transforms.push("scaleY(-1)");
  return {
    left: box.x,
    top: box.y,
    width: Math.max(0, box.w),
    height: Math.max(0, box.h),
    transform: transforms.length > 0 ? transforms.join(" ") : undefined,
  };
}

function ShapeBox({ s }: { readonly s: Shape }): JSX.Element | null {
  const t = useT();
  switch (s.kind) {
    case "text": {
      const radius =
        s.geometry === "ellipse"
          ? "50%"
          : s.geometry === "roundRect"
            ? Math.min(s.box.w, s.box.h) * 0.16
            : 0;
      return (
        <div
          className="file-viewer__shape"
          style={{
            ...boxStyle(s),
            ...fillStyle(s.fill),
            border:
              s.line === null
                ? undefined
                : `${s.line.width}px solid ${s.line.color}`,
            borderRadius: radius,
          }}
        >
          {s.paragraphs.length > 0 && (
            <div
              className={`file-viewer__textbody is-${s.anchor}${s.vertical ? " is-vertical" : ""}`}
              style={{
                padding: `${s.insets.t}px ${s.insets.r}px ${s.insets.b}px ${s.insets.l}px`,
                whiteSpace: s.wrap ? "pre-wrap" : "pre",
              }}
            >
              {s.paragraphs.map((p, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: paragraphs are static per parse
                <ParagraphBlock key={i} p={p} />
              ))}
            </div>
          )}
        </div>
      );
    }
    case "picture": {
      const { l, t: top, r, b } = s.crop;
      const wScale = 1 / Math.max(0.01, 1 - l - r);
      const hScale = 1 / Math.max(0.01, 1 - top - b);
      return (
        <div className="file-viewer__shape is-picture" style={boxStyle(s)}>
          <img
            src={s.src}
            alt=""
            style={{
              position: "absolute",
              left: `${-l * wScale * 100}%`,
              top: `${-top * hScale * 100}%`,
              width: `${wScale * 100}%`,
              height: `${hScale * 100}%`,
            }}
          />
        </div>
      );
    }
    case "line": {
      const w = Math.max(1, s.box.w);
      const h = Math.max(1, s.box.h);
      const x1 = s.box.flipH ? w : 0;
      const x2 = s.box.flipH ? 0 : w;
      const y1 = s.box.flipV ? h : 0;
      const y2 = s.box.flipV ? 0 : h;
      return (
        <svg
          className="file-viewer__shape is-line"
          style={{
            ...boxStyle(s),
            transform: s.box.rot !== 0 ? `rotate(${s.box.rot}deg)` : undefined,
            overflow: "visible",
          }}
          viewBox={`0 0 ${w} ${h}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <line
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            stroke={s.line.color}
            strokeWidth={s.line.width}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      );
    }
    case "table": {
      const total = s.colWidths.reduce((a, b) => a + b, 0);
      return (
        <div className="file-viewer__shape" style={boxStyle(s)}>
          <table
            className="file-viewer__slide-table"
            style={{ width: total > 0 ? total : "100%" }}
          >
            <colgroup>
              {s.colWidths.map((w, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional
                <col key={i} style={{ width: w }} />
              ))}
            </colgroup>
            <tbody>
              {s.rows.map((row, ri) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
                <tr key={ri} style={{ height: row.height }}>
                  {row.cells.map((cell, ci) =>
                    cell.merged ? null : (
                      <td
                        // biome-ignore lint/suspicious/noArrayIndexKey: cells are positional
                        key={ci}
                        colSpan={cell.colSpan}
                        rowSpan={cell.rowSpan}
                        style={fillStyle(cell.fill)}
                      >
                        {cell.paragraphs.map((p, pi) => (
                          // biome-ignore lint/suspicious/noArrayIndexKey: paragraphs are static per parse
                          <ParagraphBlock key={pi} p={p} />
                        ))}
                      </td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case "placeholder":
      return (
        <div className="file-viewer__shape is-placeholder" style={boxStyle(s)}>
          <span>
            {s.what === "chart" ? t("viewer.chart") : t("viewer.object")}
          </span>
        </div>
      );
    default:
      return null;
  }
}

function SlideBox({
  deck,
  slide,
  scale,
}: {
  readonly deck: Deck;
  readonly slide: Slide;
  readonly scale: number;
}): JSX.Element {
  return (
    <div
      className="file-viewer__slide"
      style={{
        width: deck.width * scale,
        height: deck.height * scale,
      }}
    >
      <div
        className="file-viewer__slide-inner"
        style={{
          width: deck.width,
          height: deck.height,
          transform: `scale(${scale})`,
          ...fillStyle(slide.background ?? { kind: "solid", color: "#ffffff" }),
        }}
      >
        {slide.shapes.map((s, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: shapes are static per parse
          <ShapeBox key={i} s={s} />
        ))}
      </div>
    </div>
  );
}

function Thumb({
  deck,
  slide,
  active,
  onPick,
}: {
  readonly deck: Deck;
  readonly slide: Slide;
  readonly active: boolean;
  readonly onPick: () => void;
}): JSX.Element {
  const t = useT();
  const ref = useRef<HTMLButtonElement | null>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setVisible(true);
      },
      { rootMargin: "400px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const scale = THUMB_W / deck.width;
  return (
    <button
      ref={ref}
      type="button"
      role="tab"
      className={`file-viewer__thumb${active ? " is-active" : ""}`}
      aria-label={t("viewer.slideAria", { n: slide.index })}
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      onClick={onPick}
    >
      <span className="file-viewer__thumb-n">{slide.index}</span>
      <span
        className="file-viewer__thumb-box"
        style={{ width: THUMB_W, height: deck.height * scale }}
      >
        {visible && <SlideBox deck={deck} slide={slide} scale={scale} />}
      </span>
    </button>
  );
}

export function SlidesView({
  bytes,
}: {
  readonly bytes: Uint8Array;
}): JSX.Element {
  const t = useT();
  const urlsRef = useRef<string[]>([]);
  const deck = useMemo(() => {
    for (const u of urlsRef.current) URL.revokeObjectURL(u);
    urlsRef.current = [];
    return parseDeck(bytes, (path, data) => {
      const url = URL.createObjectURL(
        new Blob([data as BlobPart], { type: imageMimeFor(path) }),
      );
      urlsRef.current.push(url);
      return url;
    });
  }, [bytes]);
  useEffect(
    () => () => {
      for (const u of urlsRef.current) URL.revokeObjectURL(u);
      urlsRef.current = [];
    },
    [],
  );
  const [active, setActive] = useState(0);
  const mainRef = useRef<HTMLDivElement | null>(null);
  const [mainW, setMainW] = useState(0);
  useEffect(() => {
    const el = mainRef.current;
    if (el === null) return;
    const ro = new ResizeObserver(() => setMainW(el.clientWidth));
    ro.observe(el);
    setMainW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const count = deck.slides.length;
  const go = useCallback(
    (delta: number) =>
      setActive((a) =>
        Math.min(Math.max(a + delta, 0), Math.max(0, count - 1)),
      ),
    [count],
  );
  const slide = deck.slides[active] ?? deck.slides[0];
  const scale =
    mainW > 0 ? Math.max(0.05, (mainW - MAIN_PAD * 2) / deck.width) : 0.5;

  if (slide === undefined) {
    return (
      <div className="file-viewer__body">
        <p className="file-viewer__notice">{t("viewer.renderFailed")}</p>
      </div>
    );
  }
  return (
    // A group so the arrow keys, bubbling up from a focused thumbnail or
    // The thumbnails are a vertical tablist (WAI-ARIA tabs): the arrow keys
    // page the deck from a focused thumbnail; the main pane just shows.
    <div className="file-viewer__body file-viewer__slides">
      <div className="file-viewer__slides-row">
        <div
          className="file-viewer__thumbs"
          role="tablist"
          aria-orientation="vertical"
          onKeyDown={(e) => {
            if (
              e.key === "ArrowDown" ||
              e.key === "ArrowRight" ||
              e.key === "PageDown"
            ) {
              e.preventDefault();
              go(1);
            } else if (
              e.key === "ArrowUp" ||
              e.key === "ArrowLeft" ||
              e.key === "PageUp"
            ) {
              e.preventDefault();
              go(-1);
            }
          }}
        >
          {deck.slides.map((s, i) => (
            <Thumb
              key={s.index}
              deck={deck}
              slide={s}
              active={i === active}
              onPick={() => setActive(i)}
            />
          ))}
        </div>
        <div
          ref={mainRef}
          className="file-viewer__scroll file-viewer__slide-main"
        >
          <SlideBox deck={deck} slide={slide} scale={scale} />
        </div>
      </div>
      <div className="file-viewer__slides-bar">
        <button
          type="button"
          className="file-viewer__action"
          aria-label={t("viewer.prevSlide")}
          disabled={active === 0}
          onClick={() => go(-1)}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M7.5 2.5 4 6l3.5 3.5" />
          </svg>
        </button>
        <span className="file-viewer__slides-count">
          {active + 1} / {count}
        </span>
        <button
          type="button"
          className="file-viewer__action"
          aria-label={t("viewer.nextSlide")}
          disabled={active >= count - 1}
          onClick={() => go(1)}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="m4.5 2.5 3.5 3.5-3.5 3.5" />
          </svg>
        </button>
        {deck.slidesCapped && (
          <span className="file-viewer__notice">
            {t("viewer.slidesCapped", { n: count })}
          </span>
        )}
      </div>
    </div>
  );
}
