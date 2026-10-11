import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { computeSectionPath } from "./sectionizer.js";

function nodeOf(html: string, selector: string): Element {
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  const el = document.querySelector(selector);
  if (el === null) throw new Error(`selector matched nothing: ${selector}`);
  return el as unknown as Element;
}

describe("sectionizer", () => {
  it("returns empty path for top-of-document content", () => {
    const el = nodeOf(`<p id="t">hi</p>`, "#t");
    expect(computeSectionPath(el)).toEqual([]);
  });

  it("walks back through prior headings", () => {
    const html = `
      <h1>Top</h1>
      <h2>Sub</h2>
      <p id="t">para</p>
    `;
    const el = nodeOf(html, "#t");
    expect(computeSectionPath(el)).toEqual(["Top", "Sub"]);
  });

  it("pops sibling headings of equal/lower depth", () => {
    const html = `
      <h1>A</h1>
      <h2>A.1</h2>
      <h2>A.2</h2>
      <p id="t">para</p>
    `;
    const el = nodeOf(html, "#t");
    expect(computeSectionPath(el)).toEqual(["A", "A.2"]);
  });

  it("ignores empty headings", () => {
    const html = `<h1></h1><h2>Real</h2><p id="t">x</p>`;
    const el = nodeOf(html, "#t");
    expect(computeSectionPath(el)).toEqual(["Real"]);
  });
});
