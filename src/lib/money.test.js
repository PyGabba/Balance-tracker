import { describe, it, expect } from "vitest";
import { minorUnitsPrecision, toMinorUnits, fromMinorUnits, roundAmount, sumAmounts, subtractAmounts, minorUnitsOf } from "./money.js";

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

describe("minorUnitsOf (MOD-016 contract phase)", () => {
  it("uses the companion field when present, ignoring the decimal field entirely", () => {
    // Deliberately inconsistent decimal/companion values — proves the
    // companion field wins outright rather than being cross-checked
    // against or averaged with the decimal one.
    expect(minorUnitsOf({ importo: 999, importoMinorUnits: 1234 })).toBe(1234);
  });

  it("derives from the decimal field when no companion field exists (legacy document)", () => {
    expect(minorUnitsOf({ importo: 12.34 })).toBe(1234);
  });

  it("derives from the decimal field when the companion field is explicitly not a number", () => {
    expect(minorUnitsOf({ importo: 12.34, importoMinorUnits: null })).toBe(1234);
    expect(minorUnitsOf({ importo: 12.34, importoMinorUnits: undefined })).toBe(1234);
  });

  it("supports a custom field name for non-transaction entities", () => {
    expect(minorUnitsOf({ saldoIniziale: 100.5, saldoInizialeMinorUnits: 10050 }, "saldoIniziale")).toBe(10050);
    expect(minorUnitsOf({ prezzoAcquisto: 42.5 }, "prezzoAcquisto")).toBe(4250);
  });

  it("respects currency precision when deriving from the decimal field", () => {
    expect(minorUnitsOf({ importo: 1000 }, "importo", "JPY")).toBe(1000);
  });

  // The regression check the migration itself depends on: a legacy
  // document's decimal field, converted through this accessor, must
  // always exactly equal what migration 001 (server/migrations/
  // 001_amount_minor_units.js) would have written as its companion field
  // — both call the same toMinorUnits, but this pins that equivalence
  // explicitly so the two can never quietly drift apart if either is
  // ever edited in isolation.
  it("agrees with what the backfill migration would have written, for realistic amounts", () => {
    const amounts = [0.01, 1, 12.34, 99.99, 1000, 1234.56, 0.1, 0.2, 33.33, 9999.99];
    for (const importo of amounts) {
      expect(minorUnitsOf({ importo })).toBe(toMinorUnits(importo));
    }
  });
});
