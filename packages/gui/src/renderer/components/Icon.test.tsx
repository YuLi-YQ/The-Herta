import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Icon, type IconName } from "./Icon.js";

const NAMES: IconName[] = [
  "sidebar",
  "plus",
  "more",
  "send",
  "stop",
  "attach",
  "globe",
  "clock",
  "close",
  "file",
  "spark",
];

describe("line icons (R75)", () => {
  it("draws every icon as decorative, text-coloured and sized by font-size", () => {
    for (const name of NAMES) {
      const { container, unmount } = render(<Icon name={name} />);
      const svg = container.querySelector("svg");
      expect(svg, name).not.toBeNull();
      expect(svg).toHaveAttribute("aria-hidden", "true");
      expect(svg).toHaveAttribute("focusable", "false");
      expect(svg).toHaveAttribute("width", "1em");
      expect(svg).toHaveAttribute("stroke", "currentColor");
      expect(svg).toHaveAttribute("data-icon", name);
      expect(svg?.childElementCount).toBeGreaterThan(0);
      unmount();
    }
  });

  it("keeps an extra class beside its own", () => {
    const { container } = render(<Icon name="spark" className="herta-pin-mark" />);
    expect(container.querySelector("svg")).toHaveClass("herta-icon", "herta-pin-mark");
  });
});

/** The surfaces people use read their icons from Icon, not from font glyphs
 *  that draw differently in every font (☰ ＋ ··· ↑ ■ ◷ ◎ ◆ × ✦). */
describe("no glyph icons left in the main surfaces (R75)", () => {
  const files = [
    "HertaChat.tsx",
    "ChatSidebar.tsx",
    "RoundThreeWorkbench.tsx",
    "ProjectSidebar.tsx",
    "RoundDashboard.tsx",
    "WebSearch.tsx",
    "ChatMemory.tsx",
    "ChatStorage.tsx",
    "RoundReader.tsx",
    "Settings/SettingsModal.tsx",
  ];
  const source = (name: string): string => {
    for (const base of ["src/renderer/components", "packages/gui/src/renderer/components"]) {
      try {
        return readFileSync(resolve(process.cwd(), base, name), "utf8");
      } catch {
        /* try the other root */
      }
    }
    throw new Error(`${name} not found`);
  };
  for (const name of files) {
    it(name, () => {
      const text = source(name);
      // A glyph standing alone as an element's content, or leading a label.
      expect(text).not.toMatch(/^\s*(☰|＋|···|↑|■|◷|◆|×|✦)\s*$/m);
      expect(text).not.toMatch(/>\s*(☰|＋|···|↑|■|◷|◆|×|✦)\s*</);
      expect(text).not.toMatch(/(◎|◷|＋) ?(联网|新聊天|新建任务|\{)/);
    });
  }
});
