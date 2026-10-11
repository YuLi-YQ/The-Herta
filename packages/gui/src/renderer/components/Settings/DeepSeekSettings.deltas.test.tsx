import { act, waitFor } from "@testing-library/react";
import { Profiler } from "react";
import { describe, expect, it } from "vitest";
import { HertaBridgeProvider } from "../../context/HertaBridgeContext.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import { DeepSeekSettings } from "./DeepSeekSettings.js";

describe("DeepSeekSettings — streamed tokens do not re-render the pane (perf audit 2026-09-20)", () => {
  it("re-renders when the turn starts and ends (its controls lock), never per delta", async () => {
    // The pane read the WHOLE session snapshot to derive one boolean —
    // "is a turn running" — so with Settings open during a reply it
    // re-rendered on every streamed token. It selects the boolean now.
    const mock = createMockHertaBridge({
      deepSeekKeyStatus: { set: true, hint: "30fc", encrypted: true },
    });
    let commits = 0;
    const view = renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <Profiler
          id="pane"
          onRender={() => {
            commits += 1;
          }}
        >
          <DeepSeekSettings />
        </Profiler>
      </HertaBridgeProvider>,
    );
    await waitFor(() => expect(view.getByText(/30fc/)).toBeTruthy());
    // Let the pane's own reads settle before counting.
    await act(async () => {
      await Promise.resolve();
    });

    const idle = commits;
    act(() => mock.emitTurn({ kind: "started", turnId: "t1" }));
    const started = commits;
    expect(started).toBeGreaterThan(idle); // busy flipped: the controls lock

    for (let i = 0; i < 40; i += 1) {
      act(() =>
        mock.emitAgent({
          kind: "agent",
          event: { type: "assistant.delta", layer: "actor", text: "字" },
        }),
      );
    }
    expect(commits).toBe(started); // forty tokens, zero renders

    act(() => mock.emitTurn({ kind: "finished", turnId: "t1" }));
    expect(commits).toBeGreaterThan(started); // and they unlock
  });
});
