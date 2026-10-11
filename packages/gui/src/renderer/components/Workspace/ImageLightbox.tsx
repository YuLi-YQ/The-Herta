import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { attachmentImageUrl } from "../../../shared/attachment-image.js";
import { useHertaBridge } from "../../context/HertaBridgeContext.js";
import { useSessionScoped } from "../../hooks/useSessionScoped.js";
import { useT } from "../../i18n/LocaleProvider.js";
import { OVERLAY_Z, useModalOverlay } from "../../lib/overlay-stack.js";

/**
 * Click-to-enlarge for attached pictures (ADR 0048 §4a, owner's Codex
 * reference 2026-08-27): a thumbnail — sent row or composer strip — opens
 * the full image in an in-app overlay with a −/percent/+ zoom pill.
 *
 * The pixels come through the same `herta-attachment://` scheme the thumbs
 * use; nothing new crosses the sandbox. Presentation only — the record is
 * untouched (D7).
 */
export interface LightboxImage {
  readonly path: string;
  readonly name: string;
  readonly caption?: string;
  /** Sniffed pixel dimensions when the digest knows them — the fit scale
   *  computes immediately instead of waiting for the bytes. */
  readonly width?: number;
  readonly height?: number;
}

const noop = (): void => {};
const LightboxContext = createContext<(img: LightboxImage) => void>(noop);

/** Stable opener — safe to read inside memoized rows (the value never
 *  changes identity, so it cannot invalidate them). */
export function useLightbox(): (img: LightboxImage) => void {
  return useContext(LightboxContext);
}

export function LightboxProvider({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  // Session-scoped, deliberately: an enlarged picture belongs to the session
  // it was opened in (the transient-state audit class) — its path would not
  // even resolve against another session's store. A switch closes it.
  const [image, setImage] = useSessionScoped<LightboxImage | null>(null);
  const open = useCallback((img: LightboxImage) => setImage(img), [setImage]);
  return (
    <LightboxContext.Provider value={open}>
      {children}
      {image !== null && (
        // Keyed by path: opening another picture while one is up remounts
        // the viewer, resetting zoom/fit for the new image.
        <ImageLightbox
          key={image.path}
          image={image}
          onClose={() => setImage(null)}
        />
      )}
    </LightboxContext.Provider>
  );
}

const ZOOM_MIN = 0.1;
const ZOOM_MAX = 5;
const ZOOM_STEP = 1.25;
/** One mouse-wheel notch, in the pixels Chromium reports for it. A wheel
 *  event this large (or larger) is one full ZOOM_STEP. */
const NOTCH_PX = 100;

/**
 * The zoom factor one Ctrl/⌘ + wheel event asks for. A mouse notch is a full
 * step, as before. A trackpad PINCH arrives as a stream of ctrlKey wheel
 * events a few pixels each, and taking a full ×1.25 step per event made the
 * picture leap on the lightest pinch (platform review 2026-09-23); each
 * event now moves in proportion to its distance, so a pinch zooms smoothly.
 */
export function wheelZoomFactor(deltaY: number): number {
  const steps = Math.min(1, Math.abs(deltaY) / NOTCH_PX);
  const factor = ZOOM_STEP ** steps;
  return deltaY < 0 ? factor : 1 / factor;
}
/** The viewport's CSS padding (keep in sync with .lightbox-viewport). The
 *  fit must subtract it: padding sits INSIDE clientWidth/Height, so a fit
 *  computed against the raw client box overflows by exactly the padding
 *  and shows scrollbars on a "fitted" image (seen live 2026-08-27). */
const VIEWPORT_PAD = 44;

/** Pointer travel (px, Manhattan) below which a press is still a CLICK.
 *  Without it a hand that moves two pixels between press and release would
 *  turn the close-on-background click into a no-op pan. */
const DRAG_SLOP = 4;

function clampZoom(z: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

function ImageLightbox({
  image,
  onClose,
}: {
  readonly image: LightboxImage;
  readonly onClose: () => void;
}): JSX.Element {
  const t = useT();
  const isMac = useHertaBridge().bridge.platform === "darwin";
  // Topmost-overlay coordination (the H1/H2 lesson): Escape here must not
  // reach — or be eaten by — the approval panel / settings underneath.
  const isTop = useModalOverlay("lightbox", true, OVERLAY_Z.lightbox);
  const viewportRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [natural, setNatural] = useState<{
    readonly w: number;
    readonly h: number;
  } | null>(
    image.width !== undefined && image.height !== undefined
      ? { w: image.width, h: image.height }
      : null,
  );
  // Scale vs natural pixels; null = fit not yet computed (the img renders
  // max-constrained until then, so there is no flash of a wrong size).
  const [zoom, setZoom] = useState<number | null>(null);

  // Fit once the natural size and the viewport are both known: the whole
  // picture visible, never upscaled past 100%.
  useEffect(() => {
    if (zoom !== null || natural === null) return;
    const vp = viewportRef.current;
    if (vp === null || vp.clientWidth === 0 || vp.clientHeight === 0) return;
    const w = Math.max(1, vp.clientWidth - VIEWPORT_PAD * 2);
    const h = Math.max(1, vp.clientHeight - VIEWPORT_PAD * 2);
    setZoom(clampZoom(Math.min(1, w / natural.w, h / natural.h)));
  }, [natural, zoom]);

  // Escape closes — only while this is the topmost overlay.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && isTop) {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  // Keyboard users land inside the dialog (the close button), like the
  // key prompt focuses its input.
  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
  }, []);

  // CTRL (or ⌘) + wheel zooms; a bare wheel SCROLLS (owner 2026-08-28).
  //
  // The first cut made every wheel a zoom, which left a zoomed picture with
  // no way to move: the wheel was spent, and the scrollbar — the only other
  // route — was broken by the close handler below. Ctrl+wheel is also the
  // platform's own convention for "zoom the thing under the pointer", and a
  // trackpad pinch arrives as exactly this event, so pinch-to-zoom works
  // without another code path. Bare wheel is left to the browser: vertical
  // by default, horizontal with Shift, at the OS's own scroll speed.
  //
  // A NATIVE listener with `passive: false`, not React's onWheel: a passive
  // listener cannot preventDefault, and the zoom would scroll the pane
  // instead. Registered once and reading live state through refs, so
  // wheeling never re-subscribes.
  const zoomRef = useRef<number | null>(zoom);
  zoomRef.current = zoom;
  const naturalRef = useRef(natural);
  naturalRef.current = natural;
  /** The point the next zoom must hold still: where the cursor sat inside
   *  the image (0..1) and where that was on screen. Consumed by the layout
   *  effect below, which runs after React has committed the new width —
   *  a rAF callback measured the OLD size and corrected by zero. */
  const anchor = useRef<{
    readonly fx: number;
    readonly fy: number;
    readonly clientX: number;
    readonly clientY: number;
  } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `zoom` is the TRIGGER, not an input — the body reads refs, but the correction must run on the commit that changed the width
  useLayoutEffect(() => {
    const a = anchor.current;
    anchor.current = null;
    const vp = viewportRef.current;
    const img = imgRef.current;
    if (a === null || vp === null || img === null) return;
    const r = img.getBoundingClientRect();
    vp.scrollLeft += r.left + a.fx * r.width - a.clientX;
    vp.scrollTop += r.top + a.fy * r.height - a.clientY;
  }, [zoom]);

  // The grab cursor is a claim that dragging does something, so it is made
  // only while the picture actually overflows its pane. Recomputed on every
  // zoom commit (and on the fit, which arrives as one).
  // biome-ignore lint/correctness/useExhaustiveDependencies: `zoom` is the TRIGGER — the overflow it changes is read off the DOM
  useLayoutEffect(() => {
    const vp = viewportRef.current;
    if (vp === null) return;
    vp.classList.toggle(
      "is-pannable",
      vp.scrollWidth > vp.clientWidth || vp.scrollHeight > vp.clientHeight,
    );
  }, [zoom]);
  useEffect(() => {
    const vp = viewportRef.current;
    if (vp === null) return;
    const onWheel = (e: WheelEvent): void => {
      // A bare wheel is the browser's to handle — do not preventDefault, or
      // the pane stops scrolling and the picture is stuck again.
      if (!e.ctrlKey && !e.metaKey) return;
      if (e.deltaY === 0) {
        // A sideways swipe with the modifier held: nothing to zoom, but the
        // pane must not scroll under a held Ctrl either.
        e.preventDefault();
        return;
      }
      const nat = naturalRef.current;
      const img = imgRef.current;
      if (nat === null || img === null) return;
      e.preventDefault();
      const rect = img.getBoundingClientRect();
      // Start from what is ON SCREEN, which is the fit scale until the
      // first explicit zoom — otherwise the first notch would jump to 100%.
      // A ZERO-width rect means it has not been laid out yet (a wheel in the
      // first frame; every rect in jsdom): deriving a scale from it would
      // divide to 0 and clamp the picture to ZOOM_MIN.
      const current =
        zoomRef.current ?? (rect.width > 0 ? rect.width / nat.w : 1);
      const next = clampZoom(current * wheelZoomFactor(e.deltaY));
      if (next === current) return;
      // Keep the point under the cursor under the cursor: remember where it
      // sits in the image (0..1), then correct the scroll once the new size
      // has been laid out.
      anchor.current = {
        fx: rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0.5,
        fy: rect.height > 0 ? (e.clientY - rect.top) / rect.height : 0.5,
        clientX: e.clientX,
        clientY: e.clientY,
      };
      setZoom(next);
    };
    vp.addEventListener("wheel", onWheel, { passive: false });
    return () => vp.removeEventListener("wheel", onWheel);
  }, []);

  // Drag to pan (owner 2026-08-28). The scrollbars still work, but a zoomed
  // picture wants to be pushed around directly — and it means the pan does
  // not depend on hitting a 10px gutter.
  //
  // This also owns the CLOSE, because the two gestures share a press: the
  // dark ground closes on a click that did NOT become a drag. The first cut
  // closed on mousedown anywhere the target was the viewport — and a
  // scrollbar press has the viewport as its target, so grabbing the
  // scrollbar closed the picture instead of scrolling it (owner report).
  //
  // MOUSE events, not pointer events: the drag continues while the cursor
  // is outside the viewport (over the zoom pill, past the window edge),
  // which pointer events buy with capture and these buy by listening on the
  // WINDOW. The listeners are always attached while the viewer is open and
  // no-op unless a drag is live — cheaper than add/remove churn per press,
  // and they cannot outlive the component.
  const drag = useRef<{
    readonly startX: number;
    readonly startY: number;
    readonly scrollLeft: number;
    readonly scrollTop: number;
    readonly onBackground: boolean;
    moved: boolean;
  } | null>(null);
  const closeRef2 = useRef(onClose);
  closeRef2.current = onClose;
  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      const d = drag.current;
      const vp = viewportRef.current;
      if (d === null || vp === null) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      // A few pixels of travel during a click is a click, not a drag —
      // otherwise a twitchy hand would eat the close.
      if (!d.moved && Math.abs(dx) + Math.abs(dy) < DRAG_SLOP) return;
      d.moved = true;
      vp.scrollLeft = d.scrollLeft - dx;
      vp.scrollTop = d.scrollTop - dy;
    };
    const onUp = (): void => {
      const d = drag.current;
      drag.current = null;
      // The dark ground closes on a press that never became a drag; one
      // that started on the picture is a pan however far it travelled.
      if (d !== null && !d.moved && d.onBackground) closeRef2.current();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  /** Did this press land on a scrollbar rather than inside the content box?
   *  Such a press belongs to the browser: neither pan nor close may consume
   *  it. Measured against the rect, not offsetX/Y, so a scrolled container
   *  cannot skew it — and gated on a scrollbar actually EXISTING (border box
   *  wider than content box), because an element with no layout yet reports
   *  zeros, and "past zero" would otherwise swallow every press. */
  const onScrollbar = (
    el: HTMLElement,
    e: { clientX: number; clientY: number },
  ): boolean => {
    const r = el.getBoundingClientRect();
    const vBar = el.offsetWidth > el.clientWidth;
    const hBar = el.offsetHeight > el.clientHeight;
    return (
      (vBar && e.clientX > r.left + el.clientWidth) ||
      (hBar && e.clientY > r.top + el.clientHeight)
    );
  };

  // Both pill buttons step from what is ON SCREEN, not from 100%: before the
  // first explicit zoom the picture sits at its fit scale, and starting from
  // 1 made the first click jump (fit 59% → 125%) instead of stepping.
  const step = (dir: 1 | -1): void =>
    setZoom((z) => {
      const rect = imgRef.current?.getBoundingClientRect();
      const current =
        z ??
        (natural !== null && rect !== undefined && rect.width > 0
          ? rect.width / natural.w
          : 1);
      return clampZoom(dir === 1 ? current * ZOOM_STEP : current / ZOOM_STEP);
    });

  return createPortal(
    <div
      className="lightbox-backdrop"
      role="dialog"
      aria-modal="true"
      // The caption is what the picture IS — same rule as the thumb's alt.
      aria-label={image.caption ?? image.name}
      data-testid="lightbox"
    >
      {/* Drag anywhere to pan; a press on the dark ground that never became
          a drag closes. Clicking the picture or the controls never closes,
          and a press on a scrollbar belongs to the browser. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: pointer convenience only — Escape and the labelled ✕ are the accessible close paths */}
      <div
        ref={viewportRef}
        className="lightbox-viewport"
        onMouseDown={(e) => {
          const vp = e.currentTarget;
          // Primary button only (`> 0` covers middle/right), and never a
          // press that landed on a scrollbar.
          if (e.button > 0 || onScrollbar(vp, e)) return;
          drag.current = {
            startX: e.clientX,
            startY: e.clientY,
            scrollLeft: vp.scrollLeft,
            scrollTop: vp.scrollTop,
            onBackground: e.target === vp,
            moved: false,
          };
        }}
      >
        <img
          ref={imgRef}
          className="lightbox-img"
          src={attachmentImageUrl(image.path)}
          alt={image.caption ?? image.name}
          title={image.name}
          draggable={false}
          style={
            zoom !== null && natural !== null
              ? { width: `${Math.round(natural.w * zoom)}px` }
              : undefined
          }
          onLoad={(e) => {
            if (natural !== null) return;
            const el = e.currentTarget;
            if (el.naturalWidth > 0 && el.naturalHeight > 0) {
              setNatural({ w: el.naturalWidth, h: el.naturalHeight });
            }
          }}
          // Double-click toggles 100% ↔ fit (fit recomputes via the effect).
          onDoubleClick={() => {
            setZoom((z) => (z !== null && Math.abs(z - 1) < 0.01 ? null : 1));
          }}
        />
      </div>
      <button
        ref={closeRef}
        type="button"
        className="lightbox-close"
        aria-label={t("lightbox.close")}
        onClick={onClose}
      >
        <svg
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
        </svg>
      </button>
      {/* The pill is where zoom is discoverable — a bare wheel scrolls now,
          so the Ctrl gesture needs saying somewhere (⌘ and pinch on a Mac). */}
      <div
        className="lightbox-zoom"
        title={t(isMac ? "lightbox.zoomHintMac" : "lightbox.zoomHint")}
      >
        <button
          type="button"
          className="lightbox-zoom__btn"
          aria-label={t("lightbox.zoomOut")}
          onClick={() => step(-1)}
        >
          −
        </button>
        <span className="lightbox-zoom__label" aria-live="polite">
          {zoom !== null ? `${Math.round(zoom * 100)}%` : " "}
        </span>
        <button
          type="button"
          className="lightbox-zoom__btn"
          aria-label={t("lightbox.zoomIn")}
          onClick={() => step(1)}
        >
          +
        </button>
      </div>
    </div>,
    document.body,
  );
}
