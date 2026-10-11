import { cleanText } from "./clean-text.js";

export function computeSectionPath(node: Element): string[] {
  const stack: Array<{ level: number; title: string }> = [];
  let cur: Element | null = node;
  // Walk previous siblings of cur and its ancestors, gathering headings in document order.
  const prior: Element[] = [];
  while (cur !== null) {
    let sib = cur.previousElementSibling;
    while (sib !== null) {
      collectHeadings(sib, prior);
      sib = sib.previousElementSibling;
    }
    cur = cur.parentElement;
  }
  // prior is in reverse-document-order (most-recent ancestor sibling first); reverse to doc order.
  prior.reverse();
  for (const h of prior) {
    const level = headingLevel(h);
    if (level === 0) continue;
    const title = cleanText(h.textContent ?? "");
    if (title.length === 0) continue;
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top !== undefined && top.level >= level) {
        stack.pop();
      } else {
        break;
      }
    }
    stack.push({ level, title });
  }
  return stack.map((s) => s.title);
}

function headingLevel(el: Element): number {
  const tag = el.tagName.toLowerCase();
  if (tag === "h1") return 1;
  if (tag === "h2") return 2;
  if (tag === "h3") return 3;
  if (tag === "h4") return 4;
  if (tag === "h5") return 5;
  if (tag === "h6") return 6;
  return 0;
}

function collectHeadings(el: Element, out: Element[]): void {
  if (headingLevel(el) > 0) {
    out.push(el);
    return;
  }
  // Descend: a heading nested inside a wrapper still counts.
  const inner = el.querySelectorAll("h1, h2, h3, h4, h5, h6");
  for (let i = inner.length - 1; i >= 0; i--) {
    const h = inner[i];
    if (h !== undefined) out.push(h as unknown as Element);
  }
}
