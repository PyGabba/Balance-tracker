// ─── Receipt OCR pipeline (browser only) ───
// photo → preprocessed canvases → two Tesseract passes → mergeReceiptPasses.
// The pure parts live elsewhere and are unit-tested there: pixel
// preprocessing in lib/receiptImage.js, text → fields in ./helpers.js.

import { mergeReceiptPasses } from "./helpers.js";
import { targetSize, toGrayscale, stretchContrast, adaptiveThreshold } from "../../lib/receiptImage.js";

// Served same-origin by the tesseract-assets plugin in vite.config.js — the
// CSP in vercel.json blocks tesseract.js's default jsdelivr CDN paths.
const OCR_PATHS = {
  workerPath: "/tesseract/worker.min.js",
  corePath: "/tesseract/core",
  langPath: "/tesseract/lang",
  // A blob: worker would need `worker-src blob:` in the CSP; loading the
  // worker script directly from 'self' doesn't.
  workerBlobURL: false,
};

// Through an <img>, not fetch(): the CSP's connect-src 'self' blocks fetching
// a data: URL, while img-src allows it. Browsers apply the EXIF rotation
// phones write (image-orientation: from-image is the default) both when
// decoding and in drawImage — OCR on a sideways receipt reads nothing.
async function loadImage(src) {
  const img = new Image();
  img.src = src;
  await img.decode();
  return img;
}

// Returns two canvases, one per OCR pass: `binary` (adaptive threshold —
// best for shadowed phone photos) and `gray` (contrast-stretched only —
// better on large condensed print, which thresholding can thin out).
export async function preprocess(src) {
  const img = await loadImage(src);
  const { width, height } = targetSize(img.naturalWidth, img.naturalHeight);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, width, height);

  const gray = stretchContrast(toGrayscale(ctx.getImageData(0, 0, width, height).data));
  const toCanvas = (pixels) => {
    const c = document.createElement("canvas");
    c.width = width;
    c.height = height;
    const cctx = c.getContext("2d");
    const img = cctx.createImageData(width, height);
    for (let i = 0, j = 0; i < pixels.length; i++, j += 4) {
      img.data[j] = img.data[j + 1] = img.data[j + 2] = pixels[i];
      img.data[j + 3] = 255;
    }
    cctx.putImageData(img, 0, 0);
    return c;
  };
  return { binary: toCanvas(adaptiveThreshold(gray, width, height)), gray: toCanvas(gray) };
}

// onProgress(0..1). Resolves to mergeReceiptPasses's result plus `text`
// (the raw OCR output of both passes, for debugging/feedback). Throws on OCR
// failure — callers must handle it so the UI doesn't stay stuck on
// "scanning".
export async function scanReceipt(imageSrc, { onProgress = () => {} } = {}) {
  const { createWorker, OEM, PSM } = await import("tesseract.js");
  onProgress(0.05);
  const images = await preprocess(imageSrc);
  onProgress(0.1);

  // Two passes over differently preprocessed images, combined field by
  // field (see mergeReceiptPasses): on real receipt photos each pass alone
  // misread something — a date, the merchant, the TOTALE line — but rarely
  // the same thing.
  const inputs = [images.binary, images.gray];
  let pass = 0;
  const worker = await createWorker(["ita", "eng"], OEM.LSTM_ONLY, {
    ...OCR_PATHS,
    logger: (m) => {
      if (m.status === "recognizing text") onProgress(0.1 + 0.85 * ((pass + m.progress) / inputs.length));
    },
  });
  try {
    // Receipts are one column of lines with mixed font sizes: SINGLE_COLUMN
    // keeps line order top-to-bottom instead of AUTO's block reshuffling,
    // which can tear "TOTALE" away from its amount.
    await worker.setParameters({
      tessedit_pageseg_mode: PSM.SINGLE_COLUMN,
      preserve_interword_spaces: "1",
    });
    const passes = [];
    for (; pass < inputs.length; pass++) {
      const { data } = await worker.recognize(inputs[pass], {}, { text: true, blocks: true });
      const lines = [];
      for (const b of data.blocks || []) for (const p of b.paragraphs) for (const l of p.lines) lines.push({ text: l.text, confidence: l.confidence });
      passes.push({ text: data.text, lines });
    }
    onProgress(1);
    return { ...mergeReceiptPasses(passes), text: passes.map(p => p.text).join("\n---\n") };
  } finally {
    await worker.terminate();
  }
}
