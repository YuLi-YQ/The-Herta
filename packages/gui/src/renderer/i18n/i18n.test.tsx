import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { interpolate, useLocale, useT } from "./LocaleProvider.js";
import { en } from "./messages/en.js";
import { zh } from "./messages/zh.js";
import { renderWithLocale } from "./test-util.js";

const PLACEHOLDER = /\{(\w+)\}/g;
function placeholders(s: string): Set<string> {
  return new Set(Array.from(s.matchAll(PLACEHOLDER), (m) => m[1] ?? ""));
}

describe("catalog parity", () => {
  it("zh and en have identical key sets", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
  });
  it("each key has identical placeholders across locales", () => {
    for (const k of Object.keys(zh) as (keyof typeof zh)[]) {
      expect(placeholders(en[k])).toEqual(placeholders(zh[k]));
    }
  });
});

function Probe(): JSX.Element {
  const t = useT();
  const { locale, setLocale } = useLocale();
  return (
    <div>
      <span data-testid="nav">{t("nav.voice")}</span>
      <span data-testid="loc">{locale}</span>
      <button type="button" onClick={() => setLocale("zh")}>
        swap
      </button>
    </div>
  );
}

describe("useT / LocaleProvider", () => {
  it("renders the active locale and swaps live", () => {
    renderWithLocale(<Probe />);
    expect(screen.getByTestId("nav").textContent).toBe("Voice");
    fireEvent.click(screen.getByText("swap"));
    expect(screen.getByTestId("loc").textContent).toBe("zh");
    expect(screen.getByTestId("nav").textContent).toBe("语音");
  });

  it("interpolates params and leaves unknown placeholders intact", () => {
    expect(interpolate("{n} min ago", { n: 3 })).toBe("3 min ago");
    expect(interpolate("hi {who}", {})).toBe("hi {who}");
    expect(interpolate("plain")).toBe("plain");
  });

  it("returns the key itself for an unknown key (no crash)", () => {
    function Unknown(): JSX.Element {
      const t = useT();
      // @ts-expect-error — exercising the runtime fallback for a missing key
      return <span data-testid="u">{t("nope.missing")}</span>;
    }
    renderWithLocale(<Unknown />);
    expect(screen.getByTestId("u").textContent).toBe("nope.missing");
  });
});
