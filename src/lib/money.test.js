import { describe, it, expect } from "vitest";
import { minorUnitsPrecision, toMinorUnits, fromMinorUnits, roundAmount, sumAmounts, subtractAmounts } from "./money.js";

describe("minorUnitsPrecision", () => {
  it("defaults to 2 decimal places", () => {
    expect(minorUnitsPrecision("EUR")).toBe(2);
    expect(minorUnitsPrecision("USD")).toBe(2);
    expect(minorUnitsPrecision(undefined)).toBe(2);
    expect(minorUnitsPrecision("")).toBe(2);
  });

  it("is 0 for zero-decimal currencies", () => {
    expect(minorUnitsPrecision("JPY")).toBe(0);
    expect(minorUnitsPrecision("jpy")).toBe(0); // case-insensitive
  });
});

describe("toMinorUnits / fromMinorUnits", () => {
  it("round-trips a 2-decimal amount", () => {
    expect(toMinorUnits(12.34, "EUR")).toBe(1234);
    expect(fromMinorUnits(1234, "EUR")).toBe(12.34);
  });

  it("round-trips a zero-decimal currency", () => {
    expect(toMinorUnits(1000, "JPY")).toBe(1000);
    expect(fromMinorUnits(1000, "JPY")).toBe(1000);
  });

  it("rounds instead of truncating float noise", () => {
    expect(toMinorUnits(0.1 + 0.2, "EUR")).toBe(30); // 0.30000000000000004 -> 30 cents, not 29
  });
});

describe("roundAmount", () => {
  it("rounds to 2 decimals for a normal currency", () => {
    expect(roundAmount(12.345, "EUR")).toBe(12.35);
    expect(roundAmount(12.344, "EUR")).toBe(12.34);
  });

  it("rounds to whole units for a zero-decimal currency", () => {
    expect(roundAmount(1234.5, "JPY")).toBe(1235);
  });
});

describe("sumAmounts", () => {
  it("sums without float drift across many terms", () => {
    const terms = Array(10).fill(0.1);
    expect(terms.reduce((s, x) => s + x, 0)).not.toBe(1); // the bug this exists to avoid
    expect(sumAmounts(terms, "EUR")).toBe(1);
  });

  it("sums a mix of positive and negative amounts", () => {
    expect(sumAmounts([100, -33.33, -33.33, -33.34], "EUR")).toBe(0);
  });

  it("returns 0 for an empty list", () => {
    expect(sumAmounts([], "EUR")).toBe(0);
  });
});

describe("subtractAmounts", () => {
  it("subtracts via integer minor units", () => {
    expect(subtractAmounts(10, 0.1, "EUR")).toBe(9.9);
    expect(subtractAmounts(0.3, 0.1, "EUR")).toBe(0.2); // naive 0.3 - 0.1 = 0.19999999999999998
  });
});
