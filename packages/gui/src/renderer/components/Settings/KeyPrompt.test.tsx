import { fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  HertaBridgeProvider,
  useHertaBridge,
} from "../../context/HertaBridgeContext.js";
import { useActiveSession } from "../../hooks/useActiveSession.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import { KeyPrompt } from "./KeyPrompt.js";

/** Opens the no-key card with `text` (and optionally the pictures held with
 *  it), and surfaces the composer draft (+ its restaged pictures) so a test
 *  can assert a cancel restored the held message. */
function Harness({
  text,
  images,
}: {
  readonly text: string;
  readonly images?: readonly {
    readonly id: string;
    readonly name: string;
    readonly path: string;
  }[];
}): JSX.Element {
  const { sessionStore } = useHertaBridge();
  const { composerDraft, composerDraftImages } = useActiveSession();
  return (
    <>
      <button
        type="button"
        onClick={() => sessionStore.requestKeyPrompt(text, images)}
      >
        open
      </button>
      <span data-testid="draft">{composerDraft ?? ""}</span>
      <span data-testid="draft-images">
        {(composerDraftImages ?? []).map((i) => i.id).join(",")}
      </span>
      <KeyPrompt />
    </>
  );
}

function renderHarness(
  mock: ReturnType<typeof createMockHertaBridge>,
  text: string,
  images?: readonly {
    readonly id: string;
    readonly name: string;
    readonly path: string;
  }[],
) {
  return renderWithLocale(
    <HertaBridgeProvider bridge={mock.bridge}>
      <Harness text={text} {...(images !== undefined ? { images } : {})} />
    </HertaBridgeProvider>,
  );
}

describe("KeyPrompt", () => {
  it("is closed until the no-key card is requested", () => {
    const mock = createMockHertaBridge();
    const { queryByText } = renderHarness(mock, "hi");
    expect(queryByText("Connect Herta to DeepSeek")).toBeNull();
  });

  it("Save stores the key and re-sends the held message", async () => {
    const mock = createMockHertaBridge();
    const { getByText, getByLabelText, queryByText } = renderHarness(
      mock,
      "hello world",
    );
    fireEvent.click(getByText("open"));
    expect(queryByText("Connect Herta to DeepSeek")).toBeTruthy();

    fireEvent.change(getByLabelText("DeepSeek API key"), {
      target: { value: "sk-newkey99" },
    });
    fireEvent.click(getByText("Save & send"));

    await waitFor(() =>
      expect(mock.calls.setDeepSeekKey).toEqual(["sk-newkey99"]),
    );
    // The held message is re-submitted once the key is live.
    await waitFor(() => expect(mock.calls.submitText).toContain("hello world"));
    // The card closes after a successful save.
    await waitFor(() =>
      expect(queryByText("Connect Herta to DeepSeek")).toBeNull(),
    );
  });

  it("a rejected key keeps the card open and does NOT re-send", async () => {
    const mock = createMockHertaBridge({ rejectDeepSeekKey: true });
    const { getByText, getByLabelText, queryByText } = renderHarness(
      mock,
      "hello world",
    );
    fireEvent.click(getByText("open"));
    fireEvent.change(getByLabelText("DeepSeek API key"), {
      target: { value: "sk-wrong" },
    });
    fireEvent.click(getByText("Save & send"));

    await waitFor(() =>
      expect(mock.calls.setDeepSeekKey).toEqual(["sk-wrong"]),
    );
    // The error shows, the card stays open, and the message is NOT re-sent.
    await waitFor(() =>
      expect(queryByText(/DeepSeek rejected that key/)).toBeTruthy(),
    );
    expect(queryByText("Connect Herta to DeepSeek")).toBeTruthy();
    expect(mock.calls.submitText).not.toContain("hello world");
  });

  it("a verification answering after Not now leaves NO stale error for the next prompt (UX review 2026-09-22, item 16)", async () => {
    const mock = createMockHertaBridge();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    Object.assign(mock.bridge, {
      setDeepSeekKey: async (key: string) => {
        mock.calls.setDeepSeekKey.push(key);
        await gate;
        return { ok: false as const, reason: "rejected" as const };
      },
    });
    const { getByText, getByLabelText, queryByText } = renderHarness(
      mock,
      "held message",
    );
    fireEvent.click(getByText("open"));
    fireEvent.change(getByLabelText("DeepSeek API key"), {
      target: { value: "sk-wrong" },
    });
    fireEvent.click(getByText("Save & send"));
    fireEvent.click(getByText("Not now"));
    await waitFor(() =>
      expect(queryByText("Connect Herta to DeepSeek")).toBeNull(),
    );
    // The old verification answers "rejected" after the card closed…
    release();
    await gate;
    await new Promise((r) => setTimeout(r, 0));
    // …and the next prompt opens clean: no error over an empty field, and
    // the field is not stuck disabled.
    fireEvent.click(getByText("open"));
    expect(queryByText(/DeepSeek rejected that key/)).toBeNull();
    expect(
      (getByLabelText("DeepSeek API key") as HTMLInputElement).disabled,
    ).toBe(false);
  });

  it("does NOT re-send if the user cancels while the key is being verified", async () => {
    // setDeepSeekKey hangs until we release it, so the user can cancel mid-verify.
    const mock = createMockHertaBridge();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    Object.assign(mock.bridge, {
      setDeepSeekKey: async (key: string) => {
        mock.calls.setDeepSeekKey.push(key);
        await gate;
        return {
          ok: true as const,
          encrypted: true,
          status: { set: true, hint: "5678", encrypted: true },
          unverified: false,
        };
      },
    });
    const { getByText, getByLabelText, queryByText } = renderHarness(
      mock,
      "held message",
    );
    fireEvent.click(getByText("open"));
    fireEvent.change(getByLabelText("DeepSeek API key"), {
      target: { value: "sk-slow5678" },
    });
    fireEvent.click(getByText("Save & send"));
    // Cancel while verification is still in flight.
    fireEvent.click(getByText("Not now"));
    await waitFor(() =>
      expect(queryByText("Connect Herta to DeepSeek")).toBeNull(),
    );
    // Now the (slow) verification resolves OK — but the cancelled prompt must
    // NOT re-send the message.
    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(mock.calls.submitText).not.toContain("held message");
  });

  it("Cancel restores the held message to the composer without saving", async () => {
    const mock = createMockHertaBridge();
    const { getByText, getByTestId, queryByText } = renderHarness(
      mock,
      "draft to keep",
    );
    fireEvent.click(getByText("open"));
    fireEvent.click(getByText("Not now"));

    await waitFor(() =>
      expect(queryByText("Connect Herta to DeepSeek")).toBeNull(),
    );
    expect(mock.calls.setDeepSeekKey).toEqual([]);
    expect(getByTestId("draft").textContent).toBe("draft to keep");
  });

  // ── Pictures held with the message (ADR 0048 §4) ──────────────────────────
  // The key check refused BEFORE `commit` consumed the staged copies, so the
  // ids stay valid on both exits from the card.

  it("Save & send re-sends the held pictures with the message", async () => {
    const mock = createMockHertaBridge();
    const img = { id: "img-7", name: "shot.png", path: ".herta/a/shot.png" };
    const { getByText, getByLabelText } = renderHarness(mock, "看看这个", [
      img,
    ]);
    fireEvent.click(getByText("open"));
    fireEvent.change(getByLabelText("DeepSeek API key"), {
      target: { value: "sk-newkey99" },
    });
    fireEvent.click(getByText("Save & send"));
    await waitFor(() => expect(mock.calls.submitText).toContain("看看这个"));
    expect(mock.calls.submitTextStaged[0]).toEqual(["img-7"]);
  });

  it("Cancel returns the held pictures to the composer draft", async () => {
    const mock = createMockHertaBridge();
    const img = { id: "img-9", name: "shot.png", path: ".herta/a/shot.png" };
    const { getByText, getByTestId, queryByText } = renderHarness(
      mock,
      "还没发出去",
      [img],
    );
    fireEvent.click(getByText("open"));
    fireEvent.click(getByText("Not now"));
    await waitFor(() =>
      expect(queryByText("Connect Herta to DeepSeek")).toBeNull(),
    );
    expect(getByTestId("draft").textContent).toBe("还没发出去");
    expect(getByTestId("draft-images").textContent).toBe("img-9");
  });
});
