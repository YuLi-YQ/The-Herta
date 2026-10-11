/**
 * mermaid behind one lazy door (ADR 0054 §4/§5): initialized once per
 * theme at `securityLevel: "strict"` (its own sanitizer, no HTML labels,
 * no click bindings), rendering to an SVG string the caller adopts as
 * nodes. The chunk is ~2 MB and loads on the first ```mermaid fence only.
 */
type Mermaid = typeof import("mermaid").default;

let mermaidPromise: Promise<Mermaid> | null = null;
let initializedTheme: "light" | "dark" | null = null;
let seq = 0;

function currentTheme(): "light" | "dark" {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

async function loadMermaid(): Promise<Mermaid> {
  mermaidPromise ??= import("mermaid").then((m) => m.default);
  const mermaid = await mermaidPromise;
  const theme = currentTheme();
  if (initializedTheme !== theme) {
    initializedTheme = theme;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: theme === "dark" ? "dark" : "neutral",
      fontFamily:
        'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
    });
  }
  return mermaid;
}

/** Render one diagram. Resolves to the SVG element (detached, adopted into
 *  the caller's document) or rejects on a syntax error — the caller then
 *  shows the source instead. */
export async function renderMermaid(code: string): Promise<SVGElement> {
  const mermaid = await loadMermaid();
  seq += 1;
  const { svg } = await mermaid.render(`herta-viewer-diagram-${seq}`, code);
  const doc = new DOMParser().parseFromString(svg, "text/html");
  const el = doc.body.querySelector("svg");
  if (el === null) throw new Error("mermaid produced no svg");
  return document.adoptNode(el);
}
