import { describe, it, expect } from "vitest";
import { targetSize, toGrayscale, stretchContrast, adaptiveThreshold } from "./receiptImage.js";

describe("targetSize", () => {
  it("downscales a 12MP photo to a 2400px long edge, keeping aspect ratio", () => {
    expect(targetSize(4032, 3024)).toEqual({ width: 2400, height: 1800 });
  });
  it("upscales a small image, at most 2x", () => {
    expect(targetSize(800, 400)).toEqual({ width: 1200, height: 600 });
    expect(targetSize(300, 200)).toEqual({ width: 600, height: 400 });
  });
  it("leaves a mid-size image alone", () => {
    expect(targetSize(1500, 2000)).toEqual({ width: 1500, height: 2000 });
  });
});

describe("toGrayscale", () => {
  it("converts RGBA to luma", () => {
    const g = toGrayscale(new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255]));
    expect([...g]).toEqual([255, 0, 76]);
  });
});

describe("stretchContrast", () => {
  it("maps a faded 100..160 range to the full 0..255 range", () => {
    const gray = new Uint8ClampedArray(1000).map((_, i) => 100 + (i % 61));
    const out = stretchContrast(gray);
    expect(Math.min(...out)).toBe(0);
    expect(Math.max(...out)).toBe(255);
  });
  it("leaves a flat image unchanged", () => {
    const gray = new Uint8ClampedArray(100).fill(200);
    expect([...stretchContrast(gray)]).toEqual([...gray]);
  });
});

describe("adaptiveThreshold", () => {
  it("keeps text readable across a shadow gradient", () => {
    // 256x32 receipt lit from the right: paper goes from 40 (shadow) to 230
    // (bright); ink is always half as bright as the paper under it. Any
    // single global cut fails: one that keeps the bright-side ink (115) black
    // also blackens the shadowed paper (40..115).
    const w = 256, h = 32;
    const gray = new Uint8ClampedArray(w * h);
    const ink = (x, y) => y >= 14 && y <= 17 && x % 8 < 3;
    const paper = x => 40 + (190 * x) / (w - 1);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      gray[y * w + x] = ink(x, y) ? paper(x) * 0.5 : paper(x);
    }
    const out = adaptiveThreshold(gray, w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      expect(out[y * w + x]).toBe(ink(x, y) ? 0 : 255);
    }
  });
});
