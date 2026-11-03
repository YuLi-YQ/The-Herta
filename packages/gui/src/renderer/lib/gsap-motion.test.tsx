import { act, render } from "@testing-library/react";
import { gsap } from "gsap";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type EntranceKind,
  motionAllowed,
  playEntrance,
  useAppendEntrance,
  useEntrance,
  useSwitchEntrance,
} from "./gsap-motion.js";

function allowMotion(noPreference = true): void {
  document.documentElement.dataset.appearance = "observatory";
  document.documentElement.dataset.motion = "system";
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: noPreference && query.includes("no-preference"),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.appearance;
  delete document.documentElement.dataset.motion;
});

describe("motionAllowed", () => {
  it("is on only for the observatory appearance with motion on and no reduce request", () => {
    expect(motionAllowed()).toBe(false);
    allowMotion();
    expect(motionAllowed()).toBe(true);
    document.documentElement.dataset.motion = "off";
    expect(motionAllowed()).toBe(false);
    allowMotion(false);
    expect(motionAllowed()).toBe(false);
    allowMotion();
    document.documentElement.dataset.appearance = "classic";
    expect(motionAllowed()).toBe(false);
  });
});

function Popover({
  open,
  kind = "popover-up",
  enabled = true,
}: {
  open: boolean;
  kind?: EntranceKind;
  enabled?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEntrance(ref, kind, open, enabled);
  return <div ref={ref}>menu</div>;
}

describe("useEntrance", () => {
  it("tweens from the preset only while motion is allowed", () => {
    const from = vi.spyOn(gsap, "from");
    render(<Popover open />);
    expect(from).not.toHaveBeenCalled();
    allowMotion();
    render(<Popover open />);
    expect(from).toHaveBeenCalledTimes(1);
    expect(from.mock.calls[0]?.[1]).toMatchObject({
      opacity: 0,
      y: 6,
      clearProps: "opacity,transform",
    });
  });

  // jsdom ignores visibility when focusing, so this is checked on the presets:
  // a first frame of visibility:hidden (autoAlpha) dropped the focus a chat
  // row menu gives its first item as it opens, in the packaged app (R46).
  it("never hides an entering element from focus", () => {
    allowMotion();
    const from = vi.spyOn(gsap, "from");
    for (const kind of ["popover-up", "popover-down", "panel", "row"] as const)
      render(<Popover open kind={kind} />);
    const view = render(<List keys={["a"]} scope="chat-1" />);
    view.rerender(<List keys={["a", "b"]} scope="chat-1" />);
    expect(from).toHaveBeenCalledTimes(5);
    for (const [, vars] of from.mock.calls) {
      expect(vars).not.toHaveProperty("autoAlpha");
      expect(vars).not.toHaveProperty("visibility");
      expect(vars).toHaveProperty("opacity", 0);
    }
  });
});

function List({ keys, scope, enabled = true }: { keys: string[]; scope: string; enabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useAppendEntrance(ref, keys, scope, "message", enabled);
  return (
    <div ref={ref}>
      {keys.map((key) => (
        <p key={key} data-entrance={key}>
          {key}
        </p>
      ))}
    </div>
  );
}

describe("useAppendEntrance", () => {
  it("releases completed batches instead of keeping their tween targets for the whole conversation", () => {
    allowMotion();
    const contexts = vi.spyOn(gsap, "context");
    const view = render(<List keys={["a"]} scope="chat-1" />);
    const keys = ["a"];
    for (let i = 0; i < 20; i++) {
      keys.push(`new-${i}`);
      view.rerender(<List keys={[...keys]} scope="chat-1" />);
      const el = view.container.querySelector(`[data-entrance="new-${i}"]`)!;
      for (const tween of gsap.getTweensOf(el)) tween.totalProgress(1);
    }
    const retained = contexts.mock.results
      .filter((result) => result.type === "return")
      .reduce((sum, result) => sum + (result.value as gsap.Context).getTweens().length, 0);
    expect(retained).toBe(0);
    view.unmount();
  });

  it("clears active batches on hiding and consumes hidden arrivals without replaying them on return", () => {
    allowMotion();
    const from = vi.spyOn(gsap, "from");
    const view = render(<List keys={["a"]} scope="chat-1" />);
    view.rerender(<List keys={["a", "b"]} scope="chat-1" />);
    const b = view.container.querySelector('[data-entrance="b"]')!;
    expect(gsap.getTweensOf(b)).toHaveLength(1);
    view.rerender(<List keys={["a", "b"]} scope="chat-1" enabled={false} />);
    expect(gsap.getTweensOf(b)).toHaveLength(0);
    view.rerender(<List keys={["a", "b", "hidden"]} scope="chat-1" enabled={false} />);
    view.rerender(<List keys={["a", "b", "hidden", "return-frame"]} scope="chat-1" />);
    expect(from).toHaveBeenCalledTimes(1);
    view.rerender(<List keys={["a", "b", "hidden", "return-frame", "visible"]} scope="chat-1" />);
    expect(from).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it("rises only items appended in the same scope, never the history on load or switch", () => {
    allowMotion();
    const from = vi.spyOn(gsap, "from");
    const view = render(<List keys={["a", "b"]} scope="chat-1" />);
    expect(from).not.toHaveBeenCalled();
    view.rerender(<List keys={["a", "b", "c", "d"]} scope="chat-1" />);
    expect(from).toHaveBeenCalledTimes(1);
    const targets = from.mock.calls[0]?.[0] as HTMLElement[];
    expect(targets.map((el) => el.textContent)).toEqual(["c", "d"]);
    view.rerender(<List keys={["x", "y"]} scope="chat-2" />);
    expect(from).toHaveBeenCalledTimes(1);
  });

  function row(view: ReturnType<typeof render>, key: string): HTMLElement {
    const el = view.container.querySelector<HTMLElement>(
      `[data-entrance="${key}"]`,
    );
    if (!el) throw new Error(`row ${key} missing`);
    return el;
  }

  // R49 found the appended tween still alive after unmount (R51).
  it("stops a running append tween on unmount and leaves no inline styles", () => {
    allowMotion();
    const view = render(<List keys={["a"]} scope="chat-1" />);
    view.rerender(<List keys={["a", "b"]} scope="chat-1" />);
    const b = row(view, "b");
    expect(gsap.getTweensOf(b)).toHaveLength(1);
    view.unmount();
    expect(gsap.getTweensOf(b)).toHaveLength(0);
    expect(b.style.opacity).toBe("");
    expect(b.style.transform).toBe("");
  });

  it("keeps earlier rows moving through a quick second append", () => {
    allowMotion();
    const view = render(<List keys={["a"]} scope="chat-1" />);
    view.rerender(<List keys={["a", "b"]} scope="chat-1" />);
    const b = row(view, "b");
    view.rerender(<List keys={["a", "b", "c"]} scope="chat-1" />);
    expect(gsap.getTweensOf(b)).toHaveLength(1);
    expect(gsap.getTweensOf(row(view, "c"))).toHaveLength(1);
    view.unmount();
    expect(gsap.getTweensOf(b)).toHaveLength(0);
  });

  it("slides rows in from the side with the row preset, never hiding them from focus (R54)", () => {
    allowMotion();
    const from = vi.spyOn(gsap, "from");
    function Rows({ keys }: { keys: string[] }) {
      const ref = useRef<HTMLUListElement>(null);
      useAppendEntrance(ref, keys, "chats", "row");
      return (
        <ul ref={ref}>
          {keys.map((key) => (
            <li key={key} data-entrance={key}>
              {key}
            </li>
          ))}
        </ul>
      );
    }
    const view = render(<Rows keys={["a"]} />);
    view.rerender(<Rows keys={["n", "a"]} />);
    expect(from).toHaveBeenCalledTimes(1);
    const [targets, vars] = from.mock.calls[0] as [
      HTMLElement[],
      gsap.TweenVars,
    ];
    expect(targets.map((el) => el.textContent)).toEqual(["n"]);
    expect(vars).toMatchObject({
      opacity: 0,
      x: -6,
      clearProps: "opacity,transform",
    });
    expect(vars).not.toHaveProperty("autoAlpha");
    expect(vars).not.toHaveProperty("y");
    view.unmount();
  });

  it("reverts running tweens on switching chats or turning motion off", () => {
    allowMotion();
    const view = render(<List keys={["a"]} scope="chat-1" />);
    view.rerender(<List keys={["a", "b"]} scope="chat-1" />);
    const b = row(view, "b");
    view.rerender(<List keys={["a", "b"]} scope="chat-2" />);
    expect(gsap.getTweensOf(b)).toHaveLength(0);
    expect(b.style.opacity).toBe("");

    view.rerender(<List keys={["a", "b", "c"]} scope="chat-2" />);
    const c = row(view, "c");
    expect(gsap.getTweensOf(c)).toHaveLength(1);
    document.documentElement.dataset.motion = "off";
    view.rerender(<List keys={["a", "b", "c", "d"]} scope="chat-2" />);
    expect(gsap.getTweensOf(c)).toHaveLength(0);
    expect(gsap.getTweensOf(row(view, "d"))).toHaveLength(0);
    view.unmount();
  });
});

/** A reduce-motion media query whose change the test can fire. */
function liveMedia() {
  const listeners = new Set<() => void>();
  let noPreference = true;
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return noPreference && query.includes("no-preference");
    },
    media: query,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  }));
  return {
    listeners,
    reduce() {
      noPreference = false;
      for (const fn of listeners) fn();
    },
  };
}

/** Let the attribute observer's microtask run. */
const settle = () => act(async () => await Promise.resolve());

// R58 found the switch only took effect when another message arrived: the
// cleanup lived in the effect keyed on the list. Each case below keeps the
// messages and the chat unchanged (R60).
describe("a motion switch change on its own", () => {
  function List({ keys }: { keys: string[] }) {
    const ref = useRef<HTMLDivElement>(null);
    useAppendEntrance(ref, keys, "chat-1");
    return (
      <div ref={ref}>
        {keys.map((key) => (
          <p key={key} data-entrance={key}>
            {key}
          </p>
        ))}
      </div>
    );
  }
  function running() {
    const view = render(<List keys={["a"]} />);
    view.rerender(<List keys={["a", "b"]} />);
    const b = view.container.querySelector<HTMLElement>('[data-entrance="b"]');
    if (!b) throw new Error("row b missing");
    expect(gsap.getTweensOf(b)).toHaveLength(1);
    return { view, b };
  }

  it("stops an appended entrance when the app switch turns motion off", async () => {
    allowMotion();
    const { view, b } = running();
    document.documentElement.dataset.motion = "off";
    await settle();
    expect(gsap.getTweensOf(b)).toHaveLength(0);
    expect(b.style.opacity).toBe("");
    view.unmount();
  });

  it("stops it when the appearance switches to classic", async () => {
    allowMotion();
    const { view, b } = running();
    document.documentElement.dataset.appearance = "classic";
    await settle();
    expect(gsap.getTweensOf(b)).toHaveLength(0);
    view.unmount();
  });

  it("stops it when the OS asks to reduce motion, and drops its listener on unmount", async () => {
    document.documentElement.dataset.appearance = "observatory";
    document.documentElement.dataset.motion = "system";
    const media = liveMedia();
    const { view, b } = running();
    expect(media.listeners.size).toBe(1);
    await act(async () => media.reduce());
    expect(gsap.getTweensOf(b)).toHaveLength(0);
    view.unmount();
    expect(media.listeners.size).toBe(0);
  });

  it("does not replay the history when motion is turned back on", async () => {
    allowMotion();
    const { view } = running();
    document.documentElement.dataset.motion = "off";
    await settle();
    const from = vi.spyOn(gsap, "from");
    document.documentElement.dataset.motion = "system";
    await settle();
    view.rerender(<List keys={["a", "b"]} />);
    expect(from).not.toHaveBeenCalled();
    view.unmount();
  });

  it("stops a popover entrance and a details-menu entrance too", async () => {
    allowMotion();
    const view = render(<Popover open />);
    const popover = view.container.firstElementChild as HTMLElement;
    const menu = document.createElement("div");
    document.body.append(menu);
    const tween = playEntrance(menu, "popover-down");
    expect(tween).not.toBeNull();
    expect(gsap.getTweensOf(popover)).toHaveLength(1);
    document.documentElement.dataset.motion = "off";
    await settle();
    expect(gsap.getTweensOf(popover)).toHaveLength(0);
    expect(gsap.getTweensOf(menu)).toHaveLength(0);
    expect(menu.style.opacity).toBe("");
    view.unmount();
    menu.remove();
  });

  it("lets go of the shared listener once the last entrance is done", () => {
    document.documentElement.dataset.appearance = "observatory";
    document.documentElement.dataset.motion = "system";
    const media = liveMedia();
    const menu = document.createElement("div");
    document.body.append(menu);
    const tween = playEntrance(menu, "row");
    expect(media.listeners.size).toBe(1);
    tween?.revert();
    expect(media.listeners.size).toBe(0);
    menu.remove();
  });
});

// jsdom has no layout: each element states its own box through data-top and
// data-height, and the conversation's viewport is its own box.
function stubBoxes() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const top = Number(this.dataset.top ?? 0);
      const height = Number(this.dataset.height ?? 0);
      return {
        top,
        bottom: top + height,
        height,
        left: 0,
        right: 100,
        width: 100,
        x: 0,
        y: top,
        toJSON: () => ({}),
      } as DOMRect;
    },
  );
}
type Item = { key: string; top: number };
const stack = (keys: string[], firstTop: number): Item[] =>
  keys.map((key, i) => ({ key, top: firstTop + i * 70 }));
function Conversation({
  items,
  scope,
  late = 0,
  height = 300,
  enabled = true,
}: {
  items: Item[];
  scope: string | null;
  late?: number;
  height?: number;
  enabled?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useSwitchEntrance(ref, scope, "[data-entrance]", late, enabled);
  return (
    <div ref={ref} data-top="0" data-height={height}>
      {items.map(({ key, top }) => (
        <p key={key} data-entrance={key} data-top={top} data-height="60">
          {key}
        </p>
      ))}
    </div>
  );
}
const texts = (call: unknown[] | undefined) =>
  (call?.[0] as HTMLElement[]).map((el) => el.textContent);

describe("useSwitchEntrance (R71)", () => {
  it("shares the eight-item budget between initial content and late result cards", async () => {
    allowMotion(); stubBoxes();
    const from = vi.spyOn(gsap, "from");
    const initial = Array.from({ length: 6 }, (_, i) => `first-${i}`);
    const late = Array.from({ length: 6 }, (_, i) => `late-${i}`);
    const view = render(<Conversation items={stack(initial, 0)} scope="task-1" height={1000} late={600} />);
    await act(async () => view.rerender(<Conversation items={stack([...initial, ...late], 0)} scope="task-1" height={1000} late={600} />));
    expect(from.mock.calls.reduce((sum, [targets]) => sum + (targets as HTMLElement[]).length, 0)).toBe(8);
    view.unmount();
  });

  it("keeps late starts inside the original 300ms spread deadline", async () => {
    allowMotion(); stubBoxes();
    vi.spyOn(performance, "now").mockReturnValue(0);
    const from = vi.spyOn(gsap, "from");
    const view = render(<Conversation items={stack(["first"], 0)} scope="task-1" height={1000} late={600} />);
    const next = ["first", ...Array.from({ length: 7 }, (_, i) => `late-${i}`)];
    await act(async () => view.rerender(<Conversation items={stack(next, 0)} scope="task-1" height={1000} late={600} />));
    const [targets, vars] = from.mock.calls[1] as [HTMLElement[], gsap.TweenVars];
    expect(Number(vars.delay ?? 0) + Number(vars.stagger ?? 0) * (targets.length - 1)).toBeLessThanOrEqual(0.300001);
    view.unmount();
  });

  it("shows results that arrive after the spread deadline immediately", async () => {
    allowMotion(); stubBoxes();
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const from = vi.spyOn(gsap, "from");
    const view = render(<Conversation items={stack(["first"], 0)} scope="task-1" late={600} />);
    clock.mockReturnValue(350);
    await act(async () => view.rerender(<Conversation items={stack(["first", "late"], 0)} scope="task-1" late={600} />));
    expect(from).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it("checks added candidates without scanning the full existing history on each mutation", async () => {
    allowMotion(); stubBoxes();
    const from = vi.spyOn(gsap, "from");
    const view = render(<Conversation items={stack(["first"], 0)} scope="task-1" late={600} />);
    const root = view.container.firstElementChild as HTMLElement;
    const scan = vi.spyOn(root, "querySelectorAll");
    const added = document.createElement("p");
    added.dataset.entrance = "new"; added.dataset.top = "70"; added.dataset.height = "60";
    await act(async () => { root.append(added); });
    expect(from).toHaveBeenCalledTimes(2);
    expect(scan).not.toHaveBeenCalled();
    view.unmount();
  });

  it("stops a hidden surface and does not replay its history when shown again", () => {
    allowMotion(); stubBoxes();
    const from = vi.spyOn(gsap, "from");
    const view = render(<Conversation items={stack(["a"], 0)} scope="chat-1" />);
    const a = view.getByText("a");
    view.rerender(<Conversation items={stack(["a"], 0)} scope="chat-1" enabled={false} />);
    expect(gsap.getTweensOf(a)).toHaveLength(0);
    view.rerender(<Conversation items={stack(["a", "hidden"], 0)} scope="chat-1" enabled={false} />);
    view.rerender(<Conversation items={stack(["a", "hidden"], 0)} scope="chat-1" />);
    expect(from).toHaveBeenCalledTimes(1);
    view.rerender(<Conversation items={stack(["other"], 0)} scope="chat-2" />);
    expect(from).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it("brings the messages in view in one by one, top to bottom, leaving history above alone", () => {
    allowMotion();
    stubBoxes();
    const from = vi.spyOn(gsap, "from");
    const view = render(
      <Conversation items={stack(["a", "b", "c", "d", "e", "f"], -150)} scope="chat-1" />,
    );
    expect(from).toHaveBeenCalledTimes(1);
    expect(texts(from.mock.calls[0])).toEqual(["c", "d", "e", "f"]);
    expect(from.mock.calls[0]?.[1]).toMatchObject({
      opacity: 0,
      y: 10,
      stagger: 0.05,
      clearProps: "opacity,transform",
    });
    // Appends in the same chat are useAppendEntrance's, not a new sequence.
    view.rerender(
      <Conversation items={stack(["a", "b", "c", "d", "e", "f", "g"], -150)} scope="chat-1" />,
    );
    expect(from).toHaveBeenCalledTimes(1);
    view.rerender(<Conversation items={stack(["x", "y"], 0)} scope="chat-2" />);
    expect(from).toHaveBeenCalledTimes(2);
    expect(texts(from.mock.calls[1])).toEqual(["x", "y"]);
    view.unmount();
  });

  it("stays still without motion, without a chat, or while the surface is hidden", () => {
    stubBoxes();
    const from = vi.spyOn(gsap, "from");
    render(<Conversation items={stack(["a"], 0)} scope="chat-1" />);
    allowMotion();
    render(<Conversation items={stack(["a"], 0)} scope={null} />);
    render(<Conversation items={stack(["a"], 0)} scope="chat-1" height={0} />);
    expect(from).not.toHaveBeenCalled();
  });

  it("keeps a long screen of short messages to the last eight within a third of a second", () => {
    allowMotion();
    stubBoxes();
    const from = vi.spyOn(gsap, "from");
    const keys = Array.from({ length: 12 }, (_, i) => `m${i}`);
    render(<Conversation items={stack(keys, 0)} scope="chat-1" height={1000} />);
    expect(texts(from.mock.calls[0])).toEqual(keys.slice(-8));
    const stagger = (from.mock.calls[0]?.[1] as gsap.TweenVars).stagger as number;
    expect(stagger * 7).toBeLessThanOrEqual(0.3 + 1e-9);
  });

  it("leaves no motion or inline style behind on unmount or when motion is turned off", async () => {
    allowMotion();
    stubBoxes();
    const first = render(<Conversation items={stack(["a", "b"], 0)} scope="chat-1" />);
    const a = first.getByText("a");
    expect(gsap.getTweensOf(a)).toHaveLength(1);
    first.unmount();
    expect(gsap.getTweensOf(a)).toHaveLength(0);
    expect(a.style.opacity).toBe("");
    const second = render(<Conversation items={stack(["c"], 0)} scope="chat-2" />);
    const c = second.getByText("c");
    expect(gsap.getTweensOf(c)).toHaveLength(1);
    document.documentElement.dataset.motion = "off";
    await settle();
    expect(gsap.getTweensOf(c)).toHaveLength(0);
    expect(c.style.opacity).toBe("");
    second.unmount();
  });

  it("lets items that mount just after the switch join in, if they are in view", async () => {
    allowMotion();
    stubBoxes();
    const from = vi.spyOn(gsap, "from");
    const view = render(<Conversation items={stack(["a"], 0)} scope="task-1" late={60} />);
    await act(async () => {
      view.rerender(
        <Conversation items={[...stack(["a", "b"], 0), { key: "far", top: 900 }]} scope="task-1" late={60} />,
      );
    });
    expect(from).toHaveBeenCalledTimes(2);
    expect(texts(from.mock.calls[1])).toEqual(["b"]);
    expect((from.mock.calls[1]?.[1] as gsap.TweenVars).delay).toBeGreaterThanOrEqual(0);
    expect(gsap.getTweensOf(view.getByText("far"))).toHaveLength(0);
    await act(async () => await new Promise((done) => setTimeout(done, 90)));
    await act(async () => {
      view.rerender(
        <Conversation items={[...stack(["a", "b", "c"], 0), { key: "far", top: 900 }]} scope="task-1" late={60} />,
      );
    });
    expect(from).toHaveBeenCalledTimes(2);
    expect(gsap.getTweensOf(view.getByText("c"))).toHaveLength(0);
    view.unmount();
  });
});
