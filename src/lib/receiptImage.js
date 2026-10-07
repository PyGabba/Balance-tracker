// ─── Receipt photo preprocessing for OCR ───
// Pure pixel functions (typed arrays in, typed arrays out) so they're
// testable without a canvas; receiptOcr.js does the canvas plumbing.
//
// Phone photos of receipts are the hard case for Tesseract: thermal paper is
// low contrast, and a hand or phone shadow makes one side of the receipt much
// darker than the other, so a single global threshold (Tesseract's built-in
// Otsu) wipes out the text on the dark side. Grayscale → contrast stretch →
// local (adaptive) threshold handles both.

// Target size for the long edge: big enough for small receipt print to keep
// ~20px glyphs, small enough that a 12MP photo doesn't take 30s on a phone.
const MAX_EDGE = 2400;
const MIN_EDGE = 1200;

export function targetSize(width, height) {
  const longEdge = Math.max(width, height);
  let scale = 1;
  if (longEdge > MAX_EDGE) scale = MAX_EDGE / longEdge;
  else if (longEdge < MIN_EDGE) scale = Math.min(2, MIN_EDGE / longEdge);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

// RGBA (canvas ImageData.data) → 8-bit luma.
export function toGrayscale(rgba) {
  const gray = new Uint8ClampedArray(rgba.length / 4);
  for (let i = 0, j = 0; j < gray.length; i += 4, j++) {
    gray[j] = (rgba[i] * 299 + rgba[i + 1] * 587 + rgba[i + 2] * 114) / 1000;
  }
  return gray;
}

// Stretch the 1st..99th percentile of intensities to the full 0..255 range,
// so faded thermal print gets real contrast. Percentiles, not min/max, so a
// few specular highlights or a black background corner don't neutralise it.
export function stretchContrast(gray, lowPct = 0.01, highPct = 0.99) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const lowCount = gray.length * lowPct;
  const highCount = gray.length * highPct;
  let lo = 0, hi = 255, acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= lowCount) { lo = v; break; } }
  acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= highCount) { hi = v; break; } }
  const out = new Uint8ClampedArray(gray.length);
  if (hi - lo < 8) { out.set(gray); return out; } // flat image: nothing to stretch
  const k = 255 / (hi - lo);
  for (let i = 0; i < gray.length; i++) out[i] = (gray[i] - lo) * k;
  return out;
}

// Bradley–Roth adaptive threshold: a pixel is ink when it's `t` darker than
// the mean of the window around it. The window follows the lighting, so a
// shadowed half of the receipt is thresholded against its own brightness.
// `minContrast` is an absolute floor on top of the relative test: in a deep
// shadow the paper is so dark that sensor noise alone is "15% darker than
// the mean", and those speckles glued to the words wreck Tesseract's
// segmentation. Real ink is always at least that much darker than its paper.
// Uses an integral image, so cost is O(pixels) regardless of window size.
export function adaptiveThreshold(gray, width, height, { windowFraction = 1 / 16, t = 0.15, minContrast = 12 } = {}) {
  const stride = width + 1;
  const integral = new Float64Array(stride * (height + 1));
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    for (let x = 0; x < width; x++) {
      rowSum += gray[y * width + x];
      integral[(y + 1) * stride + (x + 1)] = integral[y * stride + (x + 1)] + rowSum;
    }
  }
  const half = Math.max(4, Math.round((Math.max(width, height) * windowFraction) / 2));
  const out = new Uint8ClampedArray(gray.length);
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - half), y1 = Math.min(height - 1, y + half);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - half), x1 = Math.min(width - 1, x + half);
      const count = (x1 - x0 + 1) * (y1 - y0 + 1);
      const sum = integral[(y1 + 1) * stride + (x1 + 1)] - integral[y0 * stride + (x1 + 1)]
        - integral[(y1 + 1) * stride + x0] + integral[y0 * stride + x0];
      const v = gray[y * width + x] * count;
      out[y * width + x] = v <= sum * (1 - t) && sum - v >= minContrast * count ? 0 : 255;
    }
  }
  return out;
}
