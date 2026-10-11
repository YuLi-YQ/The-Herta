import {
  attr,
  attrNum,
  child,
  children,
  descendants,
  type OoxmlPackage,
  openPackage,
  partXml,
  relId,
  relsFor,
} from "./ooxml.js";

/**
 * A deck reader for the viewer (ADR 0054 §4): each slide as positioned
 * boxes — text with its runs' size / weight / color and paragraph
 * bullets, pictures, simple shapes, connectors, tables, backgrounds — in
 * pixel coordinates at the deck's natural size (EMU ÷ 9525). Placeholders
 * inherit position and text style from the layout and master, theme
 * colors resolve through the master's color map, and the master's and
 * layout's own decorative shapes draw under the slide's.
 *
 * What it does not do, on purpose: custom geometry paths (drawn as their
 * bounding box), charts and SmartArt (a labeled placeholder box), effects,
 * animations, 3-D. A slide read here is a faithful sketch of the slide,
 * not the slide — enough to know what the deck says and where.
 */
export const MAX_SLIDES = 300;
export const EMU_PER_PX = 9525;

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Degrees, clockwise. */
  readonly rot: number;
  readonly flipH: boolean;
  readonly flipV: boolean;
}

export type Fill =
  | { readonly kind: "solid"; readonly color: string }
  | { readonly kind: "gradient"; readonly css: string }
  | { readonly kind: "image"; readonly src: string };

export interface Line {
  readonly color: string;
  /** px */
  readonly width: number;
}

export interface TextRun {
  readonly text: string;
  /** px */
  readonly size: number;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly strike: boolean;
  readonly color: string | null;
  /** A line break inside the paragraph. */
  readonly break?: boolean;
}

export interface Paragraph {
  readonly runs: readonly TextRun[];
  readonly align: "left" | "center" | "right" | "justify";
  /** Bullet glyph or number label; null = none. */
  readonly bullet: string | null;
  readonly bulletColor: string | null;
  /** px, the paragraph's left margin and the first-line indent (negative
   *  = hanging, where the bullet sits). */
  readonly marL: number;
  readonly indent: number;
  /** Line-height multiplier (1 = single). */
  readonly lineSpacing: number;
  /** px */
  readonly spaceBefore: number;
  readonly spaceAfter: number;
  /** The size an EMPTY paragraph takes (from endParaRPr), px. */
  readonly emptySize: number;
}

export type Geometry = "rect" | "roundRect" | "ellipse" | "other";

export interface TextShape {
  readonly kind: "text";
  readonly box: Box;
  readonly fill: Fill | null;
  readonly line: Line | null;
  readonly geometry: Geometry;
  readonly paragraphs: readonly Paragraph[];
  readonly anchor: "top" | "middle" | "bottom";
  readonly insets: {
    readonly l: number;
    readonly t: number;
    readonly r: number;
    readonly b: number;
  };
  readonly wrap: boolean;
  /** Vertical (East-Asian) text direction. */
  readonly vertical: boolean;
}

export interface PictureShape {
  readonly kind: "picture";
  readonly box: Box;
  readonly src: string;
  /** Fractions cropped from each side (0..1). */
  readonly crop: {
    readonly l: number;
    readonly t: number;
    readonly r: number;
    readonly b: number;
  };
}

export interface TableCell {
  readonly paragraphs: readonly Paragraph[];
  readonly fill: Fill | null;
  readonly colSpan: number;
  readonly rowSpan: number;
  /** Covered by a span to the left / above — not drawn. */
  readonly merged: boolean;
}

export interface TableShape {
  readonly kind: "table";
  readonly box: Box;
  readonly colWidths: readonly number[];
  readonly rows: readonly {
    readonly height: number;
    readonly cells: readonly TableCell[];
  }[];
}

export interface LineShape {
  readonly kind: "line";
  readonly box: Box;
  readonly line: Line;
}

export interface PlaceholderShape {
  readonly kind: "placeholder";
  readonly box: Box;
  readonly what: "chart" | "diagram" | "media" | "ole";
}

export type Shape =
  | TextShape
  | PictureShape
  | TableShape
  | LineShape
  | PlaceholderShape;

export interface Slide {
  readonly index: number;
  readonly background: Fill | null;
  readonly shapes: readonly Shape[];
  /** The first title-ish text, for the thumbnail strip's label. */
  readonly title: string;
}

export interface Deck {
  readonly width: number;
  readonly height: number;
  readonly slides: readonly Slide[];
  readonly slidesCapped: boolean;
}

/** Media resolver the view supplies: package path + bytes → a URL the
 *  <img> can draw (a blob: URL the view owns and revokes). */
export type MediaResolver = (path: string, bytes: Uint8Array) => string;

// ---- units & colors ---------------------------------------------------------

const px = (emu: number): number => emu / EMU_PER_PX;
const ptToPx = (pt: number): number => (pt * 96) / 72;

interface Theme {
  readonly colors: ReadonlyMap<string, string>;
}

const DEFAULT_THEME_COLORS: ReadonlyMap<string, string> = new Map([
  ["dk1", "#000000"],
  ["lt1", "#ffffff"],
  ["dk2", "#44546a"],
  ["lt2", "#e7e6e6"],
  ["accent1", "#4472c4"],
  ["accent2", "#ed7d31"],
  ["accent3", "#a5a5a5"],
  ["accent4", "#ffc000"],
  ["accent5", "#5b9bd5"],
  ["accent6", "#70ad47"],
  ["hlink", "#0563c1"],
  ["folHlink", "#954f72"],
]);

const DEFAULT_CLR_MAP: ReadonlyMap<string, string> = new Map([
  ["bg1", "lt1"],
  ["tx1", "dk1"],
  ["bg2", "lt2"],
  ["tx2", "dk2"],
]);

const PRESET_COLORS: Readonly<Record<string, string>> = {
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  green: "#008000",
  blue: "#0000ff",
  yellow: "#ffff00",
  gray: "#808080",
  grey: "#808080",
  lightGray: "#d3d3d3",
  darkGray: "#a9a9a9",
  orange: "#ffa500",
  purple: "#800080",
};

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const n = Number.parseInt(h.length === 3 ? h.replace(/./g, "$&$&") : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rr = r / 255;
  const gg = g / 255;
  const bb = b / 255;
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rr) h = (gg - bb) / d + (gg < bb ? 6 : 0);
  else if (max === gg) h = (bb - rr) / d + 2;
  else h = (rr - gg) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t0: number): number => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [
    Math.round(f(h + 1 / 3) * 255),
    Math.round(f(h) * 255),
    Math.round(f(h - 1 / 3) * 255),
  ];
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** Resolve a color element (`a:srgbClr`, `a:schemeClr`, `a:sysClr`,
 *  `a:prstClr`) with its modifiers to a CSS color, or null. */
function resolveColorEl(
  el: Element,
  theme: Theme,
  clrMap: ReadonlyMap<string, string>,
  phColor: string | null,
): string | null {
  let hex: string | null = null;
  const val = attr(el, "val");
  switch (el.localName) {
    case "srgbClr":
      hex = val === null ? null : `#${val}`;
      break;
    case "sysClr":
      hex = attr(el, "lastClr") !== null ? `#${attr(el, "lastClr")}` : null;
      break;
    case "prstClr":
      hex = val === null ? null : (PRESET_COLORS[val] ?? null);
      break;
    case "schemeClr": {
      if (val === null) break;
      if (val === "phClr") hex = phColor;
      else {
        const mapped = clrMap.get(val) ?? DEFAULT_CLR_MAP.get(val) ?? val;
        hex =
          theme.colors.get(mapped) ?? DEFAULT_THEME_COLORS.get(mapped) ?? null;
      }
      break;
    }
    default:
      return null;
  }
  if (hex === null || !/^#[0-9a-f]{6}$/i.test(hex)) return null;
  let [r, g, b] = hexToRgb(hex);
  let alpha = 1;
  for (const mod of el.children) {
    const v = attrNum(mod, "val");
    if (v === null) continue;
    const f = v / 100_000;
    switch (mod.localName) {
      case "lumMod": {
        const [h, s, l] = rgbToHsl(r, g, b);
        [r, g, b] = hslToRgb(h, s, clamp01(l * f));
        break;
      }
      case "lumOff": {
        const [h, s, l] = rgbToHsl(r, g, b);
        [r, g, b] = hslToRgb(h, s, clamp01(l + f));
        break;
      }
      case "tint": {
        // Toward white by (1 - tint).
        r = Math.round(255 - (255 - r) * f);
        g = Math.round(255 - (255 - g) * f);
        b = Math.round(255 - (255 - b) * f);
        break;
      }
      case "shade": {
        r = Math.round(r * f);
        g = Math.round(g * f);
        b = Math.round(b * f);
        break;
      }
      case "alpha":
        alpha = clamp01(f);
        break;
      default:
        break;
    }
  }
  const h2 = (n: number): string => n.toString(16).padStart(2, "0");
  return alpha < 1
    ? `rgba(${r},${g},${b},${alpha.toFixed(3)})`
    : `#${h2(r)}${h2(g)}${h2(b)}`;
}

/** The first color child of `el` (a fill or a color container). */
function firstColor(
  el: Element | null,
  ctx: Ctx,
  phColor: string | null = null,
): string | null {
  if (el === null) return null;
  for (const c of el.children) {
    const col = resolveColorEl(c, ctx.theme, ctx.clrMap, phColor);
    if (col !== null) return col;
  }
  return null;
}

// ---- context ----------------------------------------------------------------

interface Ctx {
  readonly pkg: OoxmlPackage;
  readonly theme: Theme;
  readonly clrMap: ReadonlyMap<string, string>;
  readonly media: MediaResolver;
  readonly mediaCache: Map<string, string>;
  /** rels of the part whose shapes are being read (for r:embed). */
  rels: ReadonlyMap<string, { readonly target: string; readonly type: string }>;
}

function readTheme(pkg: OoxmlPackage, themePath: string | null): Theme {
  const colors = new Map<string, string>(DEFAULT_THEME_COLORS);
  if (themePath === null) return { colors };
  const doc = partXml(pkg, themePath);
  if (doc === null) return { colors };
  const scheme = descendants(doc, "clrScheme")[0];
  if (scheme === undefined) return { colors };
  for (const entry of scheme.children) {
    const c = entry.children[0];
    if (c === undefined) continue;
    let hex: string | null = null;
    if (c.localName === "srgbClr") hex = attr(c, "val");
    else if (c.localName === "sysClr") hex = attr(c, "lastClr");
    if (hex !== null) colors.set(entry.localName, `#${hex}`);
  }
  return { colors };
}

function readClrMap(masterDoc: Document | null): ReadonlyMap<string, string> {
  const map = new Map<string, string>(DEFAULT_CLR_MAP);
  if (masterDoc === null) return map;
  const el = descendants(masterDoc, "clrMap")[0];
  if (el === undefined) return map;
  for (const a of el.attributes) map.set(a.localName, a.value);
  return map;
}

// ---- fills, lines, geometry --------------------------------------------------

function readFill(
  spPr: Element | null,
  ctx: Ctx,
  phColor: string | null,
): Fill | null | undefined {
  if (spPr === null) return undefined;
  for (const c of spPr.children) {
    switch (c.localName) {
      case "noFill":
        return null;
      case "solidFill": {
        const color = firstColor(c, ctx, phColor);
        return color === null ? undefined : { kind: "solid", color };
      }
      case "gradFill": {
        const stops: { pos: number; color: string }[] = [];
        for (const gs of descendants(c, "gs")) {
          const color = firstColor(gs, ctx, phColor);
          const pos = (attrNum(gs, "pos") ?? 0) / 1000;
          if (color !== null) stops.push({ pos, color });
        }
        if (stops.length === 0) return undefined;
        stops.sort((a, b) => a.pos - b.pos);
        const first = stops[0] as { pos: number; color: string };
        if (stops.length === 1) return { kind: "solid", color: first.color };
        const lin = child(c, "lin");
        const path = child(c, "path");
        const list = stops.map((s) => `${s.color} ${s.pos}%`).join(", ");
        if (path !== null)
          return { kind: "gradient", css: `radial-gradient(circle, ${list})` };
        const ang = lin === null ? 0 : (attrNum(lin, "ang") ?? 0) / 60_000;
        return {
          kind: "gradient",
          css: `linear-gradient(${ang + 90}deg, ${list})`,
        };
      }
      case "blipFill": {
        const src = blipSrc(c, ctx);
        return src === null ? undefined : { kind: "image", src };
      }
      default:
        break;
    }
  }
  return undefined;
}

function readLine(
  spPr: Element | null,
  ctx: Ctx,
  phColor: string | null,
): Line | null | undefined {
  const ln = spPr === null ? null : child(spPr, "ln");
  if (ln === null) return undefined;
  if (child(ln, "noFill") !== null) return null;
  const color = firstColor(child(ln, "solidFill"), ctx, phColor);
  const w = attrNum(ln, "w");
  if (color === null && w === null) return undefined;
  return {
    color: color ?? phColor ?? "#000000",
    width: Math.max(0.75, px(w ?? 9525)),
  };
}

function readGeometry(spPr: Element | null): Geometry {
  const prst = spPr === null ? null : child(spPr, "prstGeom");
  const name = prst === null ? null : attr(prst, "prst");
  if (name === null)
    return spPr !== null && child(spPr, "custGeom") !== null ? "other" : "rect";
  if (name === "rect" || name === "snip1Rect" || name === "flowChartProcess")
    return "rect";
  if (name.startsWith("round") || name === "flowChartAlternateProcess")
    return "roundRect";
  if (name === "ellipse" || name === "flowChartConnector") return "ellipse";
  return "other";
}

function isLineGeometry(spPr: Element | null): boolean {
  const prst = spPr === null ? null : child(spPr, "prstGeom");
  const name = prst === null ? null : attr(prst, "prst");
  return (
    name === "line" ||
    name === "straightConnector1" ||
    (name?.startsWith("bentConnector") ?? false) ||
    (name?.startsWith("curvedConnector") ?? false)
  );
}

function blipSrc(blipFill: Element, ctx: Ctx): string | null {
  const blip = child(blipFill, "blip");
  const rid = blip === null ? null : relId(blip, "embed");
  if (rid === null) return null;
  const rel = ctx.rels.get(rid);
  if (rel === undefined) return null;
  const cached = ctx.mediaCache.get(rel.target);
  if (cached !== undefined) return cached;
  const bytes = ctx.pkg.parts.get(rel.target);
  if (bytes === undefined) return null;
  const url = ctx.media(rel.target, bytes);
  ctx.mediaCache.set(rel.target, url);
  return url;
}

// ---- transforms -------------------------------------------------------------

interface GroupTransform {
  readonly ox: number;
  readonly oy: number;
  readonly sx: number;
  readonly sy: number;
  readonly chx: number;
  readonly chy: number;
}

const IDENTITY: GroupTransform = { ox: 0, oy: 0, sx: 1, sy: 1, chx: 0, chy: 0 };

function readXfrm(xfrm: Element | null, g: GroupTransform): Box | null {
  if (xfrm === null) return null;
  const off = child(xfrm, "off");
  const ext = child(xfrm, "ext");
  if (off === null || ext === null) return null;
  const x = px(attrNum(off, "x") ?? 0);
  const y = px(attrNum(off, "y") ?? 0);
  const w = px(attrNum(ext, "cx") ?? 0);
  const h = px(attrNum(ext, "cy") ?? 0);
  return {
    x: g.ox + (x - g.chx) * g.sx,
    y: g.oy + (y - g.chy) * g.sy,
    w: w * g.sx,
    h: h * g.sy,
    rot: (attrNum(xfrm, "rot") ?? 0) / 60_000,
    flipH: attr(xfrm, "flipH") === "1",
    flipV: attr(xfrm, "flipV") === "1",
  };
}

// ---- text styles ------------------------------------------------------------

interface LevelStyle {
  readonly align?: Paragraph["align"];
  readonly marL?: number;
  readonly indent?: number;
  readonly bullet?: string | null;
  readonly bulletColor?: string | null;
  readonly autoNum?: string | null;
  readonly size?: number;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly color?: string | null;
  readonly lineSpacing?: number;
  readonly spaceBefore?: number;
  readonly spaceAfter?: number;
}

/** One `a:lvlNpPr` / `a:pPr` → the properties it states. */
function readParaProps(pPr: Element | null, ctx: Ctx): LevelStyle {
  if (pPr === null) return {};
  const out: {
    -readonly [K in keyof LevelStyle]: LevelStyle[K];
  } = {};
  const algn = attr(pPr, "algn");
  if (algn === "ctr") out.align = "center";
  else if (algn === "r") out.align = "right";
  else if (algn === "just" || algn === "dist") out.align = "justify";
  else if (algn === "l") out.align = "left";
  const marL = attrNum(pPr, "marL");
  if (marL !== null) out.marL = px(marL);
  const indent = attrNum(pPr, "indent");
  if (indent !== null) out.indent = px(indent);
  for (const c of pPr.children) {
    switch (c.localName) {
      case "buNone":
        out.bullet = null;
        out.autoNum = null;
        break;
      case "buChar":
        out.bullet = bulletGlyph(attr(c, "char") ?? "•");
        out.autoNum = null;
        break;
      case "buAutoNum":
        out.autoNum = attr(c, "type") ?? "arabicPeriod";
        out.bullet = null;
        break;
      case "buClr":
        out.bulletColor = firstColor(c, ctx);
        break;
      case "lnSpc": {
        const pct = child(c, "spcPct");
        if (pct !== null)
          out.lineSpacing = (attrNum(pct, "val") ?? 100_000) / 100_000;
        break;
      }
      case "spcBef": {
        const pts = child(c, "spcPts");
        if (pts !== null)
          out.spaceBefore = ptToPx((attrNum(pts, "val") ?? 0) / 100);
        break;
      }
      case "spcAft": {
        const pts = child(c, "spcPts");
        if (pts !== null)
          out.spaceAfter = ptToPx((attrNum(pts, "val") ?? 0) / 100);
        break;
      }
      case "defRPr": {
        const run = readRunProps(c, ctx);
        if (run.size !== undefined) out.size = run.size;
        if (run.bold !== undefined) out.bold = run.bold;
        if (run.italic !== undefined) out.italic = run.italic;
        if (run.color !== undefined) out.color = run.color;
        break;
      }
      default:
        break;
    }
  }
  return out;
}

interface RunProps {
  readonly size?: number;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly strike?: boolean;
  readonly color?: string | null;
}

function readRunProps(rPr: Element | null, ctx: Ctx): RunProps {
  if (rPr === null) return {};
  const out: { -readonly [K in keyof RunProps]: RunProps[K] } = {};
  const sz = attrNum(rPr, "sz");
  if (sz !== null) out.size = ptToPx(sz / 100);
  const b = attr(rPr, "b");
  if (b !== null) out.bold = b === "1" || b === "true";
  const i = attr(rPr, "i");
  if (i !== null) out.italic = i === "1" || i === "true";
  const u = attr(rPr, "u");
  if (u !== null) out.underline = u !== "none";
  const strike = attr(rPr, "strike");
  if (strike !== null) out.strike = strike !== "noStrike";
  const fill = child(rPr, "solidFill");
  if (fill !== null) out.color = firstColor(fill, ctx);
  return out;
}

/** Wingdings/Symbol bullet glyphs PowerPoint writes as Latin letters. */
function bulletGlyph(ch: string): string {
  const map: Readonly<Record<string, string>> = {
    "§": "■",
    n: "■",
    q: "❑",
    v: "❖",
    Ø: "➢",
    ü: "✓",
    l: "●",
    u: "◆",
    w: "◆",
    p: "□",
    ">": "›",
    "": "•",
  };
  return map[ch] ?? ch;
}

/** The nine levels of a list style (`a:lstStyle` or a `p:txStyles`
 *  group): index 0 = lvl1. */
type ListStyle = readonly (LevelStyle | undefined)[];

function readListStyle(el: Element | null, ctx: Ctx): ListStyle {
  const levels: (LevelStyle | undefined)[] = [];
  if (el === null) return levels;
  for (const c of el.children) {
    const m = /^lvl(\d)pPr$/.exec(c.localName);
    if (m === null) continue;
    levels[Number.parseInt(m[1] as string, 10) - 1] = readParaProps(c, ctx);
  }
  return levels;
}

function mergeLevel(chain: readonly (LevelStyle | undefined)[]): LevelStyle {
  const out: { -readonly [K in keyof LevelStyle]: LevelStyle[K] } = {};
  for (const s of chain) {
    if (s === undefined) continue;
    for (const [k, v] of Object.entries(s) as [keyof LevelStyle, unknown][]) {
      if (v !== undefined && out[k] === undefined)
        (out as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}

// ---- placeholders & inheritance ---------------------------------------------

interface PlaceholderKey {
  readonly type: string;
  readonly idx: string | null;
}

function placeholderOf(sp: Element): PlaceholderKey | null {
  const nvPr = descendants(sp, "nvPr")[0];
  const ph = nvPr === undefined ? null : child(nvPr, "ph");
  if (ph === null) return null;
  return { type: attr(ph, "type") ?? "body", idx: attr(ph, "idx") };
}

function sameFamily(a: string, b: string): boolean {
  const title = new Set(["title", "ctrTitle"]);
  const body = new Set([
    "body",
    "subTitle",
    "obj",
    "tbl",
    "chart",
    "dgm",
    "media",
    "pic",
    "clipArt",
  ]);
  if (a === b) return true;
  if (title.has(a) && title.has(b)) return true;
  return body.has(a) && body.has(b);
}

/** Find the shape in `doc` that a placeholder inherits from: same idx
 *  first, then same type (family). */
function findPlaceholder(
  doc: Document | null,
  key: PlaceholderKey,
): Element | null {
  if (doc === null) return null;
  const sps = descendants(doc, "sp");
  if (key.idx !== null) {
    for (const sp of sps) {
      const ph = placeholderOf(sp);
      if (ph !== null && ph.idx === key.idx) return sp;
    }
  }
  for (const sp of sps) {
    const ph = placeholderOf(sp);
    if (
      ph !== null &&
      (ph.type === key.type ||
        (ph.idx === null && sameFamily(ph.type, key.type)))
    )
      return sp;
  }
  return null;
}

interface SlideParts {
  readonly slide: Document;
  readonly slidePath: string;
  readonly layout: Document | null;
  readonly layoutPath: string | null;
  readonly master: Document | null;
  readonly masterPath: string | null;
  readonly txStyles: {
    readonly title: ListStyle;
    readonly body: ListStyle;
    readonly other: ListStyle;
  };
}

// ---- text bodies ------------------------------------------------------------

function readParagraphs(
  txBody: Element,
  ctx: Ctx,
  chain: readonly ListStyle[],
  fontScale: number,
  defaultColor: string | null,
): Paragraph[] {
  const out: Paragraph[] = [];
  const counters = new Map<number, number>();
  const ownStyle = readListStyle(child(txBody, "lstStyle"), ctx);
  for (const p of children(txBody, "p")) {
    const pPr = child(p, "pPr");
    const lvl = pPr === null ? 0 : (attrNum(pPr, "lvl") ?? 0);
    const level = mergeLevel([
      readParaProps(pPr, ctx),
      ownStyle[lvl],
      ...chain.map((ls) => ls[lvl]),
      // The first level's style is the default for deeper levels that
      // state nothing of their own.
      ...chain.map((ls) => ls[0]),
    ]);
    const baseSize = (level.size ?? ptToPx(18)) * fontScale;
    const runs: TextRun[] = [];
    for (const c of p.children) {
      if (c.localName === "r" || c.localName === "fld") {
        const rp = readRunProps(child(c, "rPr"), ctx);
        const text = child(c, "t")?.textContent ?? "";
        runs.push({
          text,
          size: rp.size !== undefined ? rp.size * fontScale : baseSize,
          bold: rp.bold ?? level.bold ?? false,
          italic: rp.italic ?? level.italic ?? false,
          underline: rp.underline ?? false,
          strike: rp.strike ?? false,
          color: rp.color ?? level.color ?? defaultColor,
        });
      } else if (c.localName === "br") {
        runs.push({
          text: "",
          size: baseSize,
          bold: false,
          italic: false,
          underline: false,
          strike: false,
          color: null,
          break: true,
        });
      }
    }
    const endParaRPr = child(p, "endParaRPr");
    const endSz = endParaRPr === null ? null : attrNum(endParaRPr, "sz");
    const emptySize =
      endSz === null ? baseSize : ptToPx(endSz / 100) * fontScale;
    const hasText = runs.some((r) => r.text.length > 0);
    let bullet: string | null = null;
    if (hasText) {
      if (level.autoNum !== undefined && level.autoNum !== null) {
        const n = (counters.get(lvl) ?? 0) + 1;
        counters.set(lvl, n);
        bullet = autoNumLabel(level.autoNum, n);
      } else if (level.bullet !== undefined && level.bullet !== null) {
        bullet = level.bullet;
      }
    }
    if (!hasText) counters.delete(lvl);
    const marL =
      level.marL ??
      (bullet !== null ? ptToPx(18) * (lvl + 1) : ptToPx(18) * lvl);
    const indent = level.indent ?? (bullet !== null ? -ptToPx(18) : 0);
    out.push({
      runs,
      align: level.align ?? "left",
      bullet,
      bulletColor: level.bulletColor ?? runs[0]?.color ?? defaultColor,
      marL,
      indent,
      lineSpacing: level.lineSpacing ?? 1,
      spaceBefore: level.spaceBefore ?? 0,
      spaceAfter: level.spaceAfter ?? 0,
      emptySize,
    });
  }
  return out;
}

function autoNumLabel(type: string, n: number): string {
  const roman = (num: number): string => {
    const table: [number, string][] = [
      [1000, "M"],
      [900, "CM"],
      [500, "D"],
      [400, "CD"],
      [100, "C"],
      [90, "XC"],
      [50, "L"],
      [40, "XL"],
      [10, "X"],
      [9, "IX"],
      [5, "V"],
      [4, "IV"],
      [1, "I"],
    ];
    let s = "";
    let v = num;
    for (const [k, r] of table)
      while (v >= k) {
        s += r;
        v -= k;
      }
    return s;
  };
  const alpha = String.fromCharCode(96 + ((n - 1) % 26) + 1);
  if (type.startsWith("alphaLc"))
    return type.endsWith("ParenR") ? `${alpha})` : `${alpha}.`;
  if (type.startsWith("alphaUc"))
    return type.endsWith("ParenR")
      ? `${alpha.toUpperCase()})`
      : `${alpha.toUpperCase()}.`;
  if (type.startsWith("romanLc")) return `${roman(n).toLowerCase()}.`;
  if (type.startsWith("romanUc")) return `${roman(n)}.`;
  if (type.endsWith("ParenR") || type.endsWith("ParenBoth")) return `${n})`;
  return `${n}.`;
}

function readBodyPr(txBody: Element | null): {
  anchor: TextShape["anchor"];
  insets: TextShape["insets"];
  wrap: boolean;
  fontScale: number;
  vertical: boolean;
} {
  const bodyPr = txBody === null ? null : child(txBody, "bodyPr");
  const anchorAttr = bodyPr === null ? null : attr(bodyPr, "anchor");
  const anchor =
    anchorAttr === "ctr" ? "middle" : anchorAttr === "b" ? "bottom" : "top";
  const ins = (name: string, dflt: number): number => {
    const v = bodyPr === null ? null : attrNum(bodyPr, name);
    return px(v ?? dflt);
  };
  const norm = bodyPr === null ? null : child(bodyPr, "normAutofit");
  const fontScale =
    norm === null ? 1 : (attrNum(norm, "fontScale") ?? 100_000) / 100_000;
  const vert = bodyPr === null ? null : attr(bodyPr, "vert");
  return {
    anchor,
    insets: {
      l: ins("lIns", 91_440),
      t: ins("tIns", 45_720),
      r: ins("rIns", 91_440),
      b: ins("bIns", 45_720),
    },
    wrap: bodyPr === null ? true : attr(bodyPr, "wrap") !== "none",
    fontScale,
    vertical: vert === "eaVert" || vert === "vert" || vert === "vert270",
  };
}

// ---- shapes -----------------------------------------------------------------

function readShapes(
  tree: Element,
  ctx: Ctx,
  parts: SlideParts,
  g: GroupTransform,
  out: Shape[],
  fromMaster: boolean,
): void {
  for (const el of tree.children) {
    switch (el.localName) {
      case "sp":
        readSp(el, ctx, parts, g, out, fromMaster);
        break;
      case "pic":
        readPic(el, ctx, g, out);
        break;
      case "cxnSp":
        readConnector(el, ctx, g, out);
        break;
      case "grpSp": {
        const grpSpPr = child(el, "grpSpPr");
        const xfrm = grpSpPr === null ? null : child(grpSpPr, "xfrm");
        const box = readXfrm(xfrm, g);
        const chOff = xfrm === null ? null : child(xfrm, "chOff");
        const chExt = xfrm === null ? null : child(xfrm, "chExt");
        let inner: GroupTransform = g;
        if (box !== null && chOff !== null && chExt !== null) {
          const chx = px(attrNum(chOff, "x") ?? 0);
          const chy = px(attrNum(chOff, "y") ?? 0);
          const chw = px(attrNum(chExt, "cx") ?? 0);
          const chh = px(attrNum(chExt, "cy") ?? 0);
          inner = {
            ox: box.x,
            oy: box.y,
            sx: chw > 0 ? box.w / chw : g.sx,
            sy: chh > 0 ? box.h / chh : g.sy,
            chx,
            chy,
          };
        }
        readShapes(el, ctx, parts, inner, out, fromMaster);
        break;
      }
      case "graphicFrame":
        readGraphicFrame(el, ctx, parts, g, out);
        break;
      default:
        break;
    }
  }
}

function readSp(
  sp: Element,
  ctx: Ctx,
  parts: SlideParts,
  g: GroupTransform,
  out: Shape[],
  fromMaster: boolean,
): void {
  const ph = placeholderOf(sp);
  // A layout's / master's placeholder is a prompt, not content.
  if (fromMaster && ph !== null) return;
  const spPr = child(sp, "spPr");
  let box = readXfrm(spPr === null ? null : child(spPr, "xfrm"), g);
  // Inheritance chain for placeholders: layout → master.
  let layoutSp: Element | null = null;
  let masterSp: Element | null = null;
  if (ph !== null) {
    layoutSp = findPlaceholder(parts.layout, ph);
    masterSp = findPlaceholder(parts.master, ph);
    if (box === null) {
      const lx = layoutSp === null ? null : child(layoutSp, "spPr");
      box = readXfrm(lx === null ? null : child(lx, "xfrm"), g);
    }
    if (box === null) {
      const mx = masterSp === null ? null : child(masterSp, "spPr");
      box = readXfrm(mx === null ? null : child(mx, "xfrm"), g);
    }
  }
  if (box === null) return;

  const style = child(sp, "style");
  const fillRef = style === null ? null : child(style, "fillRef");
  const lnRef = style === null ? null : child(style, "lnRef");
  const fontRef = style === null ? null : child(style, "fontRef");
  const fillRefColor = firstColor(fillRef, ctx);
  const lnRefColor = firstColor(lnRef, ctx);
  const fontRefColor = firstColor(fontRef, ctx);

  const explicitFill = readFill(spPr, ctx, fillRefColor);
  const fill =
    explicitFill !== undefined
      ? explicitFill
      : fillRef !== null &&
          (attrNum(fillRef, "idx") ?? 0) > 0 &&
          fillRefColor !== null
        ? ({ kind: "solid", color: fillRefColor } as Fill)
        : null;
  const explicitLine = readLine(spPr, ctx, lnRefColor);
  const line =
    explicitLine !== undefined
      ? explicitLine
      : lnRef !== null &&
          (attrNum(lnRef, "idx") ?? 0) > 0 &&
          lnRefColor !== null
        ? { color: lnRefColor, width: 1 }
        : null;

  if (isLineGeometry(spPr)) {
    if (line !== null) out.push({ kind: "line", box, line });
    return;
  }

  const txBody = child(sp, "txBody");
  const body = readBodyPr(txBody);
  const chain: ListStyle[] = [];
  const layoutTx = layoutSp === null ? null : child(layoutSp, "txBody");
  const masterTx = masterSp === null ? null : child(masterSp, "txBody");
  if (layoutTx !== null)
    chain.push(readListStyle(child(layoutTx, "lstStyle"), ctx));
  if (masterTx !== null)
    chain.push(readListStyle(child(masterTx, "lstStyle"), ctx));
  if (ph !== null) {
    chain.push(
      ph.type === "title" || ph.type === "ctrTitle"
        ? parts.txStyles.title
        : parts.txStyles.body,
    );
  } else {
    chain.push(parts.txStyles.other);
  }
  const defaultColor = fontRefColor ?? firstColorOfTx1(ctx);
  const paragraphs =
    txBody === null
      ? []
      : readParagraphs(txBody, ctx, chain, body.fontScale, defaultColor);
  out.push({
    kind: "text",
    box,
    fill,
    line,
    geometry: readGeometry(spPr),
    paragraphs,
    anchor: body.anchor,
    insets: body.insets,
    wrap: body.wrap,
    vertical: body.vertical,
  });
}

function firstColorOfTx1(ctx: Ctx): string {
  const mapped = ctx.clrMap.get("tx1") ?? "dk1";
  return ctx.theme.colors.get(mapped) ?? "#000000";
}

function readPic(
  pic: Element,
  ctx: Ctx,
  g: GroupTransform,
  out: Shape[],
): void {
  const spPr = child(pic, "spPr");
  const box = readXfrm(spPr === null ? null : child(spPr, "xfrm"), g);
  const blipFill = child(pic, "blipFill");
  if (box === null || blipFill === null) return;
  const src = blipSrc(blipFill, ctx);
  if (src === null) return;
  const srcRect = child(blipFill, "srcRect");
  const frac = (name: string): number =>
    srcRect === null ? 0 : clamp01((attrNum(srcRect, name) ?? 0) / 100_000);
  out.push({
    kind: "picture",
    box,
    src,
    crop: { l: frac("l"), t: frac("t"), r: frac("r"), b: frac("b") },
  });
}

function readConnector(
  cxn: Element,
  ctx: Ctx,
  g: GroupTransform,
  out: Shape[],
): void {
  const spPr = child(cxn, "spPr");
  const box = readXfrm(spPr === null ? null : child(spPr, "xfrm"), g);
  if (box === null) return;
  const style = child(cxn, "style");
  const lnRef = style === null ? null : child(style, "lnRef");
  const refColor = firstColor(lnRef, ctx);
  const line = readLine(spPr, ctx, refColor);
  const resolved =
    line !== undefined
      ? line
      : refColor !== null
        ? { color: refColor, width: 1 }
        : null;
  if (resolved !== null) out.push({ kind: "line", box, line: resolved });
}

function readGraphicFrame(
  frame: Element,
  ctx: Ctx,
  parts: SlideParts,
  g: GroupTransform,
  out: Shape[],
): void {
  const box = readXfrm(child(frame, "xfrm"), g);
  if (box === null) return;
  const graphicData = descendants(frame, "graphicData")[0];
  const uri = graphicData === undefined ? "" : (attr(graphicData, "uri") ?? "");
  const tbl = graphicData === undefined ? null : child(graphicData, "tbl");
  if (tbl !== null) {
    readTable(tbl, box, ctx, parts, out);
    return;
  }
  const what: PlaceholderShape["what"] = uri.endsWith("/chart")
    ? "chart"
    : uri.endsWith("/diagram")
      ? "diagram"
      : uri.includes("ole")
        ? "ole"
        : "media";
  out.push({ kind: "placeholder", box, what });
}

function readTable(
  tbl: Element,
  box: Box,
  ctx: Ctx,
  parts: SlideParts,
  out: Shape[],
): void {
  const grid = child(tbl, "tblGrid");
  const colWidths =
    grid === null
      ? []
      : children(grid, "gridCol").map((c) => px(attrNum(c, "w") ?? 0));
  const rows: { height: number; cells: TableCell[] }[] = [];
  const chain: ListStyle[] = [parts.txStyles.other];
  const defaultColor = firstColorOfTx1(ctx);
  for (const tr of children(tbl, "tr")) {
    const cells: TableCell[] = [];
    for (const tc of children(tr, "tc")) {
      const txBody = child(tc, "txBody");
      const tcPr = child(tc, "tcPr");
      const fill = readFill(tcPr, ctx, null);
      const merged = attr(tc, "hMerge") === "1" || attr(tc, "vMerge") === "1";
      cells.push({
        paragraphs:
          txBody === null
            ? []
            : readParagraphs(txBody, ctx, chain, 1, defaultColor),
        fill: fill === undefined ? null : fill,
        colSpan: attrNum(tc, "gridSpan") ?? 1,
        rowSpan: attrNum(tc, "rowSpan") ?? 1,
        merged,
      });
    }
    rows.push({ height: px(attrNum(tr, "h") ?? 0), cells });
  }
  out.push({ kind: "table", box, colWidths, rows });
}

// ---- backgrounds ------------------------------------------------------------

function readBackground(
  doc: Document | null,
  ctx: Ctx,
): Fill | null | undefined {
  if (doc === null) return undefined;
  const bg = descendants(doc, "bg")[0];
  if (bg === undefined) return undefined;
  const bgPr = child(bg, "bgPr");
  if (bgPr !== null) {
    const fill = readFill(bgPr, ctx, null);
    return fill === undefined ? undefined : fill;
  }
  const bgRef = child(bg, "bgRef");
  if (bgRef !== null) {
    const color = firstColor(bgRef, ctx);
    return color === null ? undefined : { kind: "solid", color };
  }
  return undefined;
}

// ---- the deck ---------------------------------------------------------------

function slideTitle(shapes: readonly Shape[]): string {
  for (const s of shapes) {
    if (s.kind !== "text") continue;
    const text = s.paragraphs
      .map((p) => p.runs.map((r) => r.text).join(""))
      .join(" ")
      .trim();
    if (text.length > 0) return text.slice(0, 80);
  }
  return "";
}

/** Parse a .pptx. Throws for a package that is not a presentation. */
export function parseDeck(bytes: Uint8Array, media: MediaResolver): Deck {
  const pkg = openPackage(bytes);
  const presPath = "ppt/presentation.xml";
  const pres = partXml(pkg, presPath);
  if (pres === null) throw new Error("not a presentation");
  const sldSz = descendants(pres, "sldSz")[0];
  const width = px(
    sldSz === undefined ? 12_192_000 : (attrNum(sldSz, "cx") ?? 12_192_000),
  );
  const height = px(
    sldSz === undefined ? 6_858_000 : (attrNum(sldSz, "cy") ?? 6_858_000),
  );
  const presRels = relsFor(pkg, presPath);
  const ids = descendants(pres, "sldId");
  const slidesCapped = ids.length > MAX_SLIDES;

  const mediaCache = new Map<string, string>();
  const slides: Slide[] = [];
  const masterCache = new Map<
    string,
    {
      doc: Document | null;
      theme: Theme;
      clrMap: ReadonlyMap<string, string>;
      txStyles: SlideParts["txStyles"];
    }
  >();

  for (const [i, sldId] of ids.slice(0, MAX_SLIDES).entries()) {
    const rid = relId(sldId);
    const rel = rid === null ? undefined : presRels.get(rid);
    if (rel === undefined) continue;
    const slidePath = rel.target;
    const slideDoc = partXml(pkg, slidePath);
    if (slideDoc === null) continue;
    const slideRels = relsFor(pkg, slidePath);
    let layoutPath: string | null = null;
    for (const r of slideRels.values())
      if (r.type === "slideLayout") layoutPath = r.target;
    const layoutDoc = layoutPath === null ? null : partXml(pkg, layoutPath);
    const layoutRels =
      layoutPath === null ? new Map() : relsFor(pkg, layoutPath);
    let masterPath: string | null = null;
    for (const r of layoutRels.values())
      if (r.type === "slideMaster") masterPath = r.target;

    let masterInfo =
      masterPath === null ? undefined : masterCache.get(masterPath);
    if (masterInfo === undefined) {
      const masterDoc = masterPath === null ? null : partXml(pkg, masterPath);
      const masterRels =
        masterPath === null ? new Map() : relsFor(pkg, masterPath);
      let themePath: string | null = null;
      for (const r of masterRels.values())
        if (r.type === "theme") themePath = r.target;
      const theme = readTheme(pkg, themePath);
      const clrMap = readClrMap(masterDoc);
      const tmpCtx: Ctx = {
        pkg,
        theme,
        clrMap,
        media,
        mediaCache,
        rels: masterRels,
      };
      const txStylesEl =
        masterDoc === null ? undefined : descendants(masterDoc, "txStyles")[0];
      const txStyles = {
        title: readListStyle(
          txStylesEl === undefined ? null : child(txStylesEl, "titleStyle"),
          tmpCtx,
        ),
        body: readListStyle(
          txStylesEl === undefined ? null : child(txStylesEl, "bodyStyle"),
          tmpCtx,
        ),
        other: readListStyle(
          txStylesEl === undefined ? null : child(txStylesEl, "otherStyle"),
          tmpCtx,
        ),
      };
      masterInfo = { doc: masterDoc, theme, clrMap, txStyles };
      if (masterPath !== null) masterCache.set(masterPath, masterInfo);
    }

    const parts: SlideParts = {
      slide: slideDoc,
      slidePath,
      layout: layoutDoc,
      layoutPath,
      master: masterInfo.doc,
      masterPath,
      txStyles: masterInfo.txStyles,
    };
    const ctx: Ctx = {
      pkg,
      theme: masterInfo.theme,
      clrMap: masterInfo.clrMap,
      media,
      mediaCache,
      rels: slideRels,
    };

    // Background: slide → layout → master.
    let background = readBackground(slideDoc, ctx);
    if (background === undefined && layoutDoc !== null) {
      ctx.rels = layoutRels;
      background = readBackground(layoutDoc, ctx);
    }
    if (background === undefined && masterInfo.doc !== null) {
      ctx.rels = masterPath === null ? new Map() : relsFor(pkg, masterPath);
      background = readBackground(masterInfo.doc, ctx);
    }

    const shapes: Shape[] = [];
    const showMasterSp = (doc: Document | null): boolean => {
      if (doc === null) return true;
      const root = doc.documentElement;
      return attr(root, "showMasterSp") !== "0";
    };
    // Master and layout decorations draw under the slide's own shapes.
    if (
      masterInfo.doc !== null &&
      showMasterSp(layoutDoc) &&
      showMasterSp(slideDoc)
    ) {
      ctx.rels = masterPath === null ? new Map() : relsFor(pkg, masterPath);
      const tree = descendants(masterInfo.doc, "spTree")[0];
      if (tree !== undefined)
        readShapes(tree, ctx, parts, IDENTITY, shapes, true);
    }
    if (layoutDoc !== null && showMasterSp(slideDoc)) {
      ctx.rels = layoutRels;
      const tree = descendants(layoutDoc, "spTree")[0];
      if (tree !== undefined)
        readShapes(tree, ctx, parts, IDENTITY, shapes, true);
    }
    ctx.rels = slideRels;
    const tree = descendants(slideDoc, "spTree")[0];
    const own: Shape[] = [];
    if (tree !== undefined) readShapes(tree, ctx, parts, IDENTITY, own, false);
    shapes.push(...own);

    slides.push({
      index: i + 1,
      background: background ?? null,
      shapes,
      title: slideTitle(own),
    });
  }
  return { width, height, slides, slidesCapped };
}
