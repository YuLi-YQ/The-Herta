/**
 * The pixel arithmetic behind the flat art's export from the 3D scene
 * (ADR 0057 §2.14) and the frosted-glass snapshot (§2.13): pure functions
 * over RGBA byte rows, so the layer maths unit-tests in node while the
 * renders themselves need a GPU. Everything here is display-space (the
 * scene's tone-mapped, sRGB-encoded output), which is the space the
 * browser composites the card's layers in.
 */

/** A box as fractions of an image (0–1, top-left origin). */
export interface FractionBox {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** RGBA bytes over a plain ArrayBuffer — what `ImageData` accepts. */
export type RgbaBytes = Uint8ClampedArray<ArrayBuffer>;

/**
 * The WebGPU readback is top-down with rows possibly padded to 256 bytes
 * (three sizes it as (height − 1) × paddedRow + rowBytes); this returns
 * tight rows. A buffer that is already tight is returned as a copy.
 */
export function unpadRows(
  pixels: Uint8Array,
  width: number,
  height: number,
): RgbaBytes {
  const rowBytes = width * 4;
  const paddedRow = Math.ceil(rowBytes / 256) * 256;
  const stride =
    pixels.length >= (height - 1) * paddedRow + rowBytes ? paddedRow : rowBytes;
  const out = new Uint8ClampedArray(new ArrayBuffer(rowBytes * height));
  for (let y = 0; y < height; y += 1) {
    out.set(pixels.subarray(y * stride, y * stride + rowBytes), y * rowBytes);
  }
  return out;
}

/**
 * Box-downsample a PREMULTIPLIED image by an integer factor into a
 * STRAIGHT-alpha one. A render into a transparent target resolves its
 * edges as colour × coverage (the clear is black at alpha 0), so the
 * block's colour is Σ(colour) / Σ(alpha) and its alpha the mean coverage;
 * an opaque image comes through as a plain average.
 */
export function downsampleToStraight(
  premultiplied: Uint8ClampedArray,
  width: number,
  height: number,
  factor: number,
): { pixels: RgbaBytes; width: number; height: number } {
  const w = Math.floor(width / factor);
  const h = Math.floor(height / factor);
  const out = new Uint8ClampedArray(new ArrayBuffer(w * h * 4));
  const n = factor * factor;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let dy = 0; dy < factor; dy += 1) {
        let i = ((y * factor + dy) * width + x * factor) * 4;
        for (let dx = 0; dx < factor; dx += 1) {
          r += premultiplied[i] ?? 0;
          g += premultiplied[i + 1] ?? 0;
          b += premultiplied[i + 2] ?? 0;
          a += premultiplied[i + 3] ?? 0;
          i += 4;
        }
      }
      const o = (y * w + x) * 4;
      if (a > 0) {
        out[o] = Math.round((r / a) * 255);
        out[o + 1] = Math.round((g / a) * 255);
        out[o + 2] = Math.round((b / a) * 255);
      }
      out[o + 3] = Math.round(a / n);
    }
  }
  return { pixels: out, width: w, height: h };
}

/**
 * The shadow layer: how much darker the room is with the device casting
 * than without, as a black layer whose alpha multiplies the card to the
 * same ratio. `layerOpacity` is the CSS opacity the card shows the layer
 * at (`.agent-shadow`), divided out so the composite lands on the ratio.
 * Both inputs are opaque renders of the same framing.
 */
export function shadowLayer(
  withDevice: Uint8ClampedArray,
  withoutDevice: Uint8ClampedArray,
  layerOpacity: number,
): RgbaBytes {
  const out = new Uint8ClampedArray(new ArrayBuffer(withDevice.length));
  for (let i = 0; i < withDevice.length; i += 4) {
    let ratio = 0;
    let lanes = 0;
    for (let c = 0; c < 3; c += 1) {
      const lit = withoutDevice[i + c] ?? 0;
      if (lit === 0) continue;
      ratio += Math.min(1, (withDevice[i + c] ?? 0) / lit);
      lanes += 1;
    }
    const darkening = lanes === 0 ? 0 : 1 - ratio / lanes;
    out[i + 3] = Math.round(Math.min(1, darkening / layerOpacity) * 255);
  }
  return out;
}

/**
 * The lamp layer: what the ring's light adds to the picture — the render
 * with the lamp on minus the render with it off, per channel, floored at
 * zero — as an opaque image (black where the lamp reaches nothing). The
 * LED shader adds it back tinted by the state colour.
 */
export function lampLayer(
  withLamp: Uint8ClampedArray,
  withoutLamp: Uint8ClampedArray,
): RgbaBytes {
  const out = new Uint8ClampedArray(new ArrayBuffer(withLamp.length));
  for (let i = 0; i < withLamp.length; i += 4) {
    for (let c = 0; c < 3; c += 1) {
      out[i + c] = Math.max(
        0,
        (withLamp[i + c] ?? 0) - (withoutLamp[i + c] ?? 0),
      );
    }
    out[i + 3] = 255;
  }
  return out;
}

/**
 * Confine a layer's alpha to a horizontal window: full inside the box's
 * left–right span, fading to nothing over `margin` (a fraction of the
 * width) beyond it. The contact shadow's reach runs 40 cm along the floor,
 * which this camera sees as a band across the whole card; on a flat card
 * the shadow belongs under the device.
 */
export function confineHorizontally(
  pixels: RgbaBytes,
  width: number,
  height: number,
  box: FractionBox,
  margin: number,
): RgbaBytes {
  const out = new Uint8ClampedArray(new ArrayBuffer(pixels.length));
  out.set(pixels);
  const ramp = Math.max(1e-6, margin);
  for (let x = 0; x < width; x += 1) {
    const fx = (x + 0.5) / width;
    const inside = Math.min(
      1,
      Math.max(0, (fx - (box.left - ramp)) / ramp),
      Math.max(0, (box.right + ramp - fx) / ramp),
    );
    const weight = inside * inside * (3 - 2 * inside);
    if (weight >= 1) continue;
    for (let y = 0; y < height; y += 1) {
      const i = (y * width + x) * 4 + 3;
      out[i] = Math.round((out[i] ?? 0) * weight);
    }
  }
  return out;
}

/**
 * The opaque extent of a straight-alpha image as fractions of it, at an
 * alpha threshold (the drag silhouette was measured at 24/255). Null when
 * nothing is opaque. `right`/`bottom` are exclusive edges, so a box of the
 * whole image is 0–1.
 */
export function measureOpaqueBox(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  threshold = 24,
): FractionBox | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if ((pixels[(y * width + x) * 4 + 3] ?? 0) < threshold) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return {
    left: minX / width,
    top: minY / height,
    right: (maxX + 1) / width,
    bottom: (maxY + 1) / height,
  };
}

/** The brightest channel value in an opaque layer — how much the lamp
 *  layer carries at all, for the export's own report. */
export function peakChannel(pixels: Uint8ClampedArray): number {
  let peak = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    for (let c = 0; c < 3; c += 1) {
      const v = pixels[i + c] ?? 0;
      if (v > peak) peak = v;
    }
  }
  return peak;
}

/** The mean of the brightest channel over the pixels with any alpha —
 *  a layer's overall weight, for the export's report (a lamp layer that
 *  lifts the whole device reads as a high mean with a modest peak). */
export function meanChannel(pixels: Uint8ClampedArray): number {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if ((pixels[i + 3] ?? 0) === 0) continue;
    sum += Math.max(pixels[i] ?? 0, pixels[i + 1] ?? 0, pixels[i + 2] ?? 0);
    count += 1;
  }
  return count === 0 ? 0 : sum / count;
}
