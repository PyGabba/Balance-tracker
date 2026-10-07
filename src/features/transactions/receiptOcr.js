// ─── Receipt OCR pipeline (browser only) ───
// photo → preprocessed canvas → Tesseract → parseReceiptText.
// The pure parts live elsewhere and are unit-tested there: pixel
// preprocessing in lib/receiptImage.js, text → fields in ./helpers.js.

import { parseReceiptText } from "./helpers.js";
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

// Returns two canvases: `binary` (adaptive threshold — best for shadowed
// phone photos) and `gray` (contrast-stretched only — the fallback when
// thresholding eats thin or faded glyphs).
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

// How much to trust parseReceiptText's total, by how it was found.
const TIER = { null: 0, fallback: 1, subtotal: 2, payment: 3, total: 4 };

// onProgress(0..1). Resolves to parseReceiptText's result plus `text` (the
// raw OCR output, for debugging/feedback). Throws on OCR failure — callers
// must handle it so the UI doesn't stay stuck on "scanning".
export async function scanReceipt(imageSrc, { onProgress = () => {} } = {}) {
  const { createWorker, OEM, PSM } = await import("tesseract.js");
  onProgress(0.05);
  const images = await preprocess(imageSrc);
  onProgress(0.1);

  let pass = 0;
  const passes = 2;
  const worker = await createWorker(["ita", "eng"], OEM.LSTM_ONLY, {
    ...OCR_PATHS,
    logger: (m) => {
      if (m.status === "recognizing text") onProgress(0.1 + 0.85 * ((pass + m.progress) / passes));
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
    const first = (await worker.recognize(images.binary)).data.text;
    let parsed = parseReceiptText(first);
    let text = first;
    if (TIER[parsed.totalSource] < TIER.payment) {
      // Only a guess (or nothing) for the total: retry on the
      // non-thresholded image, letting Tesseract segment the page itself,
      // and keep whichever pass found the total more reliably.
      pass = 1;
      await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
      const second = (await worker.recognize(images.gray)).data.text;
      const parsed2 = parseReceiptText(second);
      const [best, other] = TIER[parsed2.totalSource] > TIER[parsed.totalSource] ? [parsed2, parsed] : [parsed, parsed2];
      parsed = {
        ...best,
        descrizione: best.descrizione || other.descrizione,
        categoria: best.categoria || other.categoria,
        data: best.data || other.data,
      };
      text = `${first}\n---\n${second}`;
    }
    onProgress(1);
    return { ...parsed, text };
  } finally {
    await worker.terminate();
  }
}
