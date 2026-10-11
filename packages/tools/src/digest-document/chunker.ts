/**
 * Split a long text into summarization chunks (ADR 0043, the digest tool).
 *
 * Pure and deterministic: the same file chunks the same way every time, so a
 * digest's `L<from>–L<to>` ranges are stable citations into the source. When
 * a chunk runs over its budget the cut goes to the best seam behind the
 * cursor — the last page-marker line (`── 第 N 页 ──` / `── page N ──`, ADR
 * 0038 §5) first, the last blank line second — provided the seam leaves the
 * chunk at least half full; otherwise it is a hard cut at the cursor (one
 * enormous paragraph). The half-full floor is what keeps a document of tiny
 * pages from becoming hundreds of tiny chunks.
 */
export interface DocumentChunk {
  /** 1-based, inclusive. */
  readonly fromLine: number;
  readonly toLine: number;
  readonly text: string;
  /** Page span when the text carries page markers (the page the chunk
   *  starts in, the page it ends in); absent for Word/plain text. */
  readonly pages?: readonly [number, number];
}

/** Target size of one chunk, in chars. ~12K keeps one flash call well under
 *  its comfortable input and makes a 300K-char book ≈ 25 chunks. */
export const DIGEST_CHUNK_CHARS = 12_000;

/** A page-marker line in either language (the shape `pageMarkerLine` in
 *  core emits). The number is the page. */
export const PAGE_MARKER_LINE = /^── (?:第 (\d+) 页|page (\d+)) ──$/;

export function pageOfMarkerLine(line: string): number | undefined {
  const m = PAGE_MARKER_LINE.exec(line);
  if (m === null) return undefined;
  return Number(m[1] ?? m[2]);
}

export function chunkDocument(
  text: string,
  opts: { readonly targetChars?: number } = {},
): DocumentChunk[] {
  const target = Math.max(1, opts.targetChars ?? DIGEST_CHUNK_CHARS);
  const lines = text.split("\n");
  // A trailing newline yields a final empty "line" that is not a line.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const n = lines.length;

  // Prefix sums of chars (each line + its newline), the marker page per
  // line, and the page in effect at each line (last marker at or before it).
  const cum: number[] = [0];
  const markerPage: (number | undefined)[] = [];
  const pageAt: (number | undefined)[] = [];
  let page: number | undefined;
  for (let i = 0; i < n; i += 1) {
    const line = lines[i] ?? "";
    cum.push((cum[i] ?? 0) + line.length + 1);
    const p = pageOfMarkerLine(line);
    markerPage.push(p);
    if (p !== undefined) page = p;
    pageAt.push(page);
  }
  const sizeOf = (from: number, toExclusive: number): number =>
    (cum[toExclusive] ?? 0) - (cum[from] ?? 0);

  const chunks: DocumentChunk[] = [];
  const emit = (from: number, toExclusive: number): void => {
    if (toExclusive <= from) return;
    // The span's first page: the page in effect at its first line, or — when
    // it starts before any marker — the first marker inside it.
    let first = pageAt[from];
    if (first === undefined) {
      for (let k = from; k < toExclusive; k += 1) {
        const p = markerPage[k];
        if (p !== undefined) {
          first = p;
          break;
        }
      }
    }
    const last = pageAt[toExclusive - 1];
    chunks.push({
      fromLine: from + 1,
      toLine: toExclusive,
      text: lines.slice(from, toExclusive).join("\n"),
      ...(first !== undefined && last !== undefined
        ? { pages: [first, last] as const }
        : {}),
    });
  };

  let start = 0;
  let i = 0;
  while (i < n) {
    if (sizeOf(start, i + 1) < target) {
      i += 1;
      continue;
    }
    // Over budget at line i. Best seam behind the cursor that leaves the
    // chunk at least half full: the last page marker (it starts the next
    // chunk), else the last blank line (it ends this one), else line i.
    let cut = i + 1;
    let chosen = false;
    for (let k = i; k > start; k -= 1) {
      if (markerPage[k] !== undefined && sizeOf(start, k) * 2 >= target) {
        cut = k;
        chosen = true;
        break;
      }
    }
    if (!chosen) {
      for (let k = i; k > start; k -= 1) {
        if (
          (lines[k] ?? "").trim().length === 0 &&
          sizeOf(start, k + 1) * 2 >= target
        ) {
          cut = k + 1;
          break;
        }
      }
    }
    emit(start, cut);
    start = cut;
    i = cut;
  }
  emit(start, n);
  return chunks;
}
