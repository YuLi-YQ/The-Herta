import { act, render } from "@testing-library/react";
import { memo, useState } from "react";
import { describe, expect, it } from "vitest";
import { DiffBody } from "./DiffBody.js";
import { useWorkspaceRefs, WorkspaceRefsProvider } from "./WorkspaceRefs.js";

/**
 * Two renders that must NOT happen (perf audit 2026-09-20). Both were
 * re-renders caused by an ancestor changing state that cannot affect the
 * component — invisible on screen, paid on every pointer move and keystroke.
 */
describe("renders that must not happen", () => {
  it("WorkspaceRefs hands out ONE value object: a parent re-render does not reach a memoized consumer", () => {
    // The provider passed a fresh `{…}` each render, and a context change
    // walks straight past `memo`: Conversation and Composer re-rendered on
    // every sidebar-search keystroke, sidebar collapse and Settings open.
    let consumerRenders = 0;
    let bump: () => void = () => {};
    const Consumer = memo(function Consumer(): JSX.Element {
      useWorkspaceRefs();
      consumerRenders += 1;
      return <span>consumer</span>;
    });
    // The child element is created ONCE, outside, so only a context change
    // (not new props) could re-render it — as with the real Workbench tree.
    const child = <Consumer />;
    function Parent(): JSX.Element {
      const [n, setN] = useState(0);
      bump = () => setN((v) => v + 1);
      return (
        <div data-n={n}>
          <WorkspaceRefsProvider>{child}</WorkspaceRefsProvider>
        </div>
      );
    }
    render(<Parent />);
    expect(consumerRenders).toBe(1);
    act(() => bump());
    act(() => bump());
    expect(consumerRenders).toBe(1);
  });

  it("DiffBody bails out when its text is unchanged, however often the parent renders", () => {
    // Up to ~5 000 rows of three elements. The file viewer re-renders on
    // every pointer move of its divider (its width is state); an activity
    // row on each tick of its group's timer. Neither changes a diff.
    const text = Array.from({ length: 400 }, (_, i) =>
      i % 3 === 0 ? `+added ${i}` : i % 3 === 1 ? `-removed ${i}` : ` ctx ${i}`,
    ).join("\n");
    // The probe: DiffBody calls `text.split` exactly once per render, so a
    // text whose `split` counts its calls counts DiffBody's renders. (A
    // Profiler around it would not: it reports every commit of the PARENT
    // that contains it, bailed-out subtree or not.)
    let diffRenders = 0;
    const counted = (s: string): string => {
      const boxed = new String(s);
      boxed.split = ((...args: Parameters<string["split"]>) => {
        diffRenders += 1;
        return s.split(...args);
      }) as string["split"];
      return boxed as unknown as string;
    };
    let setWidth: (w: number) => void = () => {};
    let setText: (t: string) => void = () => {};
    function Panel(): JSX.Element {
      const [width, sw] = useState(400);
      const [t, st] = useState(() => counted(text));
      setWidth = sw;
      setText = st;
      return (
        <div style={{ width }}>
          <DiffBody text={t} />
        </div>
      );
    }
    const view = render(<Panel />);
    const diffCommits = (): number => diffRenders;
    expect(diffCommits()).toBe(1);
    expect(view.container.querySelectorAll(".diff-body__line")).toHaveLength(
      400,
    );
    for (const w of [401, 402, 403, 404, 405]) act(() => setWidth(w));
    expect(diffCommits()).toBe(1);
    // Anti-vacuous: a CHANGED diff does render.
    act(() => setText(counted(`${text}\n+one more`)));
    expect(diffCommits()).toBe(2);
    expect(view.container.querySelectorAll(".diff-body__line")).toHaveLength(
      401,
    );
  });
});
