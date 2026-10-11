// Offline tooling: slice the two V2 source ASCII-video JSONs (in
// reference_UX_design/HertaHalftone/V2) into 4 committed segment assets
// (2 x 60-frame / 2.5s windows per source clip).
// V2 uses the "scene" (layered) outputs for openings B and C; opening A was
// dropped (not good in V2). Each scene clip carries a `layers` array
// (detail + coarse) that the renderer maps to per-layer ink styles — slicing
// keeps the cell layout fixed, so the layer ranges are copied verbatim.
// Run once via: node packages/gui/scripts/cut-opening-segments.mjs
// Runtime never imports from reference_UX_design/ — only the generated
// assets under src/renderer/assets/openings/ are committed and loaded.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)); // packages/gui/scripts
const REPO_ROOT = join(HERE, "..", "..", "..");
const SRC_DIR = join(REPO_ROOT, "reference_UX_design", "HertaHalftone", "V2");
const OUT_DIR = join(HERE, "..", "src", "renderer", "assets", "openings");

const SOURCES = [
  { file: "video_adaptive_ascii_B_scene.json", prefix: "b" },
  { file: "video_adaptive_ascii_C_scene.json", prefix: "c" },
];
const SEGMENTS = 2;
const FRAMES_PER_SEGMENT = 60;

function sliceSource(src) {
  const { activeCount, frameCount } = src;
  const bytes = Buffer.from(src.framesBase64, "base64");
  if (bytes.length !== activeCount * frameCount) {
    throw new Error(
      `byte mismatch for ${src.source}: ${bytes.length} != ${activeCount * frameCount}`,
    );
  }
  const segments = [];
  for (let s = 0; s < SEGMENTS; s += 1) {
    const startByte = s * FRAMES_PER_SEGMENT * activeCount;
    const endByte = startByte + FRAMES_PER_SEGMENT * activeCount;
    const slice = bytes.subarray(startByte, endByte);
    if (slice.length !== FRAMES_PER_SEGMENT * activeCount) {
      throw new Error(`slice ${s} length ${slice.length} wrong`);
    }
    const segment = {
      type: "adaptive-ascii-video-segment-v1",
      width: src.width,
      height: src.height,
      fps: src.fps,
      frameCount: FRAMES_PER_SEGMENT,
      activeCount,
      cells: src.cells,
      framesBase64: Buffer.from(slice).toString("base64"),
    };
    // Preserve the layer ranges (detail / coarse) so the renderer can pick
    // per-layer ink styles. Layers index into the fixed cell layout, which
    // slicing does not change, so they copy over unchanged.
    if (Array.isArray(src.layers)) {
      segment.layers = src.layers.map((layer) => ({
        name: layer.name,
        start: layer.start,
        count: layer.count,
      }));
    }
    segments.push(segment);
  }
  return segments;
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const { file, prefix } of SOURCES) {
    const src = JSON.parse(readFileSync(join(SRC_DIR, file), "utf8"));
    const segments = sliceSource(src);
    segments.forEach((seg, i) => {
      // Self-validation (this is the "test" for offline tooling).
      const decoded = Buffer.from(seg.framesBase64, "base64");
      if (decoded.length !== seg.activeCount * seg.frameCount) {
        throw new Error(`assert: bad byte count for ${prefix}-${i}`);
      }
      if (seg.cells.length !== src.cells.length) {
        throw new Error(`assert: cells changed for ${prefix}-${i}`);
      }
      if (Array.isArray(src.layers)) {
        if (
          JSON.stringify(seg.layers) !==
          JSON.stringify(
            src.layers.map((l) => ({
              name: l.name,
              start: l.start,
              count: l.count,
            })),
          )
        ) {
          throw new Error(`assert: layers changed for ${prefix}-${i}`);
        }
        for (const layer of seg.layers) {
          if (layer.start < 0 || layer.start + layer.count > seg.activeCount) {
            throw new Error(
              `assert: layer range out of bounds for ${prefix}-${i}`,
            );
          }
        }
      }
      const outPath = join(OUT_DIR, `${prefix}-${i}.json`);
      writeFileSync(outPath, JSON.stringify(seg));
      const layerInfo = Array.isArray(seg.layers)
        ? `, layers=[${seg.layers.map((l) => l.name).join(",")}]`
        : "";
      console.log(
        `wrote ${prefix}-${i}.json: ${seg.frameCount} frames, ${seg.activeCount} cells, ${decoded.length} bytes${layerInfo}`,
      );
    });
  }
  console.log(`done: ${SOURCES.length * SEGMENTS} segment assets written`);
}

main();
