import { act, fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HertaBridgeProvider } from "../../context/HertaBridgeContext.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import {
  LightboxProvider,
  useLightbox,
  wheelZoomFactor,
} from "./ImageLightbox.js";
import { UserBubble } from "./UserBubble.js";

const IMG = {
  path: ".herta/attachments/s/shot-abc-def.png",
  name: "shot.png",
  caption: "一张测试图。",
  width: 640,
  height: 480,
};

/** A trigger the tests can click to open the lightbox directly. */
function OpenTrigger(): JSX.Element {
  const open = useLightbox();
  return (
    <button type="button" onClick={() => open(IMG)}>
      trigger
    </button>
  );
}

function renderLightbox(mock = createMockHertaBridge()) {
  return renderWithLocale(
    <HertaBridgeProvider bridge={mock.bridge}>
      <LightboxProvider>
        <OpenTrigger />
      </LightboxProvider>
    </HertaBridgeProvider>,
  );
}

describe("ImageLightbox", () => {
  it("opens as a dialog showing the full picture through the attachment scheme", () => {
    renderLightbox();
    expect(screen.queryByTestId("lightbox")).toBeNull();
    fireEvent.click(screen.getByText("trigger"));
    const dialog = screen.getByTestId("lightbox");
    expect(dialog.getAttribute("role")).toBe("dialog");
    // The caption is the dialog's name — same rule as the thumb's alt.
    expect(dialog.getAttribute("aria-label")).toBe("一张测试图。");
    const img = dialog.querySelector(".lightbox-img") as HTMLImageElement;
    expect(img.src).toContain("herta-attachment://");
    expect(img.src).toContain("shot-abc-def.png");
  });

  it("the ✕ closes it", () => {
    renderLightbox();
    fireEvent.click(screen.getByText("trigger"));
    fireEvent.click(screen.getByLabelText("Close"));
    expect(screen.queryByTestId("lightbox")).toBeNull();
  });

  it("Escape closes it (topmost-overlay rule)", () => {
    renderLightbox();
    fireEvent.click(screen.getByText("trigger"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("lightbox")).toBeNull();
  });

  it("clicking the dark ground closes; clicking the picture does not", () => {
    renderLightbox();
    fireEvent.click(screen.getByText("trigger"));
    const viewport = document.querySelector(".lightbox-viewport") as Element;
    const img = viewport.querySelector(".lightbox-img") as Element;
    // A press that starts ON the picture is a pan, never a close.
    fireEvent.mouseDown(img, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.mouseUp(window, { clientX: 10, clientY: 10 });
    expect(screen.queryByTestId("lightbox")).not.toBeNull();
    fireEvent.mouseDown(viewport, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.mouseUp(window, { clientX: 10, clientY: 10 });
    expect(screen.queryByTestId("lightbox")).toBeNull();
  });

  it("the zoom pill steps the scale and says so", () => {
    // jsdom has no layout (clientWidth 0), so the fit never computes — the
    // first step starts from 100%, which is also the real behaviour when a
    // user zooms before the fit lands.
    renderLightbox();
    fireEvent.click(screen.getByText("trigger"));
    fireEvent.click(screen.getByLabelText("Zoom in"));
    expect(document.querySelector(".lightbox-zoom__label")?.textContent).toBe(
      "125%",
    );
    fireEvent.click(screen.getByLabelText("Zoom out"));
    expect(document.querySelector(".lightbox-zoom__label")?.textContent).toBe(
      "100%",
    );
    const img = document.querySelector(".lightbox-img") as HTMLElement;
    // Explicit width = natural × zoom once zoomed.
    expect(img.style.width).toBe("640px");
  });

  it("CTRL + wheel zooms, and its listener is non-passive so the pane does not scroll instead (owner 2026-08-28)", () => {
    renderLightbox();
    fireEvent.click(screen.getByText("trigger"));
    const viewport = document.querySelector(".lightbox-viewport") as Element;
    const label = () =>
      document.querySelector(".lightbox-zoom__label")?.textContent;

    // The event must be cancelable and actually defaultPrevented — a passive
    // listener (React's onWheel) cannot do that, and the pane would scroll
    // rather than zoom.
    const up = new WheelEvent("wheel", {
      deltaY: -100,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    fireEvent(viewport, up);
    expect(up.defaultPrevented).toBe(true);
    expect(label()).toBe("125%");

    const down = new WheelEvent("wheel", {
      deltaY: 100,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    fireEvent(viewport, down);
    expect(label()).toBe("100%");
  });

  it("a trackpad PINCH (small ctrlKey wheel events) zooms in proportion, not a full step per event (2026-09-23)", () => {
    // A mouse notch keeps its full ×1.25; a pinch's few-pixel events used
    // to take that same full step each and the picture leapt.
    expect(wheelZoomFactor(-100)).toBeCloseTo(1.25);
    expect(wheelZoomFactor(100)).toBeCloseTo(0.8);
    expect(wheelZoomFactor(-240)).toBeCloseTo(1.25); // never past one step
    expect(wheelZoomFactor(-10)).toBeCloseTo(1.25 ** 0.1);

    renderLightbox();
    fireEvent.click(screen.getByText("trigger"));
    const viewport = document.querySelector(".lightbox-viewport") as Element;
    for (let i = 0; i < 3; i += 1) {
      fireEvent(
        viewport,
        new WheelEvent("wheel", {
          deltaY: -4,
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    }
    // Three pinch events: about 103%, where they used to reach 195%.
    expect(document.querySelector(".lightbox-zoom__label")?.textContent).toBe(
      "103%",
    );
  });

  it("the zoom hint names ⌘ and the pinch on a Mac, Ctrl elsewhere (2026-09-23)", () => {
    renderLightbox(createMockHertaBridge({ platform: "darwin" }));
    fireEvent.click(screen.getByText("trigger"));
    expect(
      document.querySelector(".lightbox-zoom")?.getAttribute("title"),
    ).toBe("Pinch or ⌘ + wheel to zoom, drag to pan");
  });

  it("a BARE wheel is left to the browser — it scrolls the pane, it does not zoom", () => {
    // The first cut zoomed on every wheel, which left a zoomed picture with
    // no way to move (owner report): the wheel was spent and the scrollbar
    // was broken by the close handler.
    renderLightbox();
    fireEvent.click(screen.getByText("trigger"));
    const viewport = document.querySelector(".lightbox-viewport") as Element;
    const bare = new WheelEvent("wheel", {
      deltaY: -100,
      bubbles: true,
      cancelable: true,
    });
    fireEvent(viewport, bare);
    // Untouched: not consumed, and no zoom was applied (the label shows a
    // percentage only once a zoom exists).
    expect(bare.defaultPrevented).toBe(false);
    expect(
      document.querySelector(".lightbox-zoom__label")?.textContent,
    ).not.toContain("%");
  });

  it("grabbing the SCROLLBAR neither pans nor closes — it belongs to the browser (owner 2026-08-28)", () => {
    // The close handler used to fire for any press whose target was the
    // viewport, and a scrollbar press is exactly that: reaching for the bar
    // closed the picture instead of scrolling it.
    renderLightbox();
    fireEvent.click(screen.getByText("trigger"));
    const vp = document.querySelector(".lightbox-viewport") as HTMLElement;
    // jsdom gives zero geometry, so pin what the check reads: a border box
    // WIDER than the content box is what proves a scrollbar exists, and
    // anything past the content box is on it.
    vp.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 100, bottom: 100 }) as DOMRect;
    for (const [prop, value] of [
      ["clientWidth", 90],
      ["clientHeight", 90],
      ["offsetWidth", 100],
      ["offsetHeight", 100],
    ] as const) {
      Object.defineProperty(vp, prop, { value, configurable: true });
    }

    fireEvent.mouseDown(vp, { button: 0, clientX: 95, clientY: 50 });
    fireEvent.mouseUp(window, { clientX: 95, clientY: 50 });
    expect(screen.queryByTestId("lightbox")).not.toBeNull();

    // …and the same press INSIDE the content box does close, which is what
    // makes the assertion above about the scrollbar rather than about
    // nothing happening at all.
    fireEvent.mouseDown(vp, { button: 0, clientX: 50, clientY: 50 });
    fireEvent.mouseUp(window, { clientX: 50, clientY: 50 });
    expect(screen.queryByTestId("lightbox")).toBeNull();
  });

  it("a DRAG pans and does not close, while a click on the ground still closes", () => {
    renderLightbox();
    fireEvent.click(screen.getByText("trigger"));
    const vp = document.querySelector(".lightbox-viewport") as HTMLElement;
    vp.scrollTop = 100;
    vp.scrollLeft = 60;

    // Drag up-left by 30/10px: the content follows the hand, so the scroll
    // offsets grow. The move and release land on the WINDOW — a drag that
    // outruns the viewport must keep working.
    fireEvent.mouseDown(vp, { button: 0, clientX: 50, clientY: 50 });
    fireEvent.mouseMove(window, { clientX: 40, clientY: 20 });
    fireEvent.mouseUp(window, { clientX: 40, clientY: 20 });
    expect(vp.scrollTop).toBe(130);
    expect(vp.scrollLeft).toBe(70);
    // A drag is not a click: the viewer stays open even though it began on
    // the background.
    expect(screen.queryByTestId("lightbox")).not.toBeNull();

    // A press that never moves still closes.
    fireEvent.mouseDown(vp, { button: 0, clientX: 50, clientY: 50 });
    fireEvent.mouseUp(window, { clientX: 50, clientY: 50 });
    expect(screen.queryByTestId("lightbox")).toBeNull();
  });

  it("the zoom label never claims a scale the image is not at — it stops at the cap", () => {
    // The owner's second bug: the picture stopped growing (a flex item
    // shrinks by default) while + kept counting to 500%. The width the
    // component writes IS the scale, so the two cannot drift; here the cap
    // holds the number as well as the picture.
    renderLightbox();
    fireEvent.click(screen.getByText("trigger"));
    const zoomIn = screen.getByLabelText("Zoom in");
    for (let i = 0; i < 12; i++) fireEvent.click(zoomIn);
    const label = document.querySelector(".lightbox-zoom__label")?.textContent;
    expect(label).toBe("500%"); // ZOOM_MAX, and it stops there
    const img = document.querySelector(".lightbox-img") as HTMLElement;
    // 640 natural × 5 — the written width matches the number shown.
    expect(img.style.width).toBe("3200px");
  });

  it("a session switch closes it — an enlarged picture belongs to its session", () => {
    const mock = createMockHertaBridge();
    renderLightbox(mock);
    fireEvent.click(screen.getByText("trigger"));
    expect(screen.queryByTestId("lightbox")).not.toBeNull();
    act(() => {
      mock.emitReset({
        sessionId: "another",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
    });
    expect(screen.queryByTestId("lightbox")).toBeNull();
  });

  it("a sent thumbnail opens it (the UserBubble wiring)", () => {
    const mock = createMockHertaBridge();
    renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <LightboxProvider>
          <UserBubble text="看看这个" images={[IMG]} />
        </LightboxProvider>
      </HertaBridgeProvider>,
    );
    fireEvent.click(screen.getByLabelText("View picture shot.png"));
    const dialog = screen.getByTestId("lightbox");
    expect(
      (dialog.querySelector(".lightbox-img") as HTMLImageElement).src,
    ).toContain("shot-abc-def.png");
  });
});
