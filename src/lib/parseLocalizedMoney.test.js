import { describe, it, expect } from "vitest";
import { parseLocalizedMoney } from "./parseLocalizedMoney.js";

describe("parseLocalizedMoney — basic decimal formats", () => {
  it("parses Italian decimal comma", () => {
    expect(parseLocalizedMoney("1,50")).toBe(1.5);
  });

  it("parses Italian thousands + decimal", () => {
    expect(parseLocalizedMoney("1.234,56")).toBe(1234.56);
  });

  it("rejects a double-dot amount as ambiguous", () => {
    expect(parseLocalizedMoney("1.234.56")).toBeNull();
  });

  it("parses English thousands + decimal", () => {
    expect(parseLocalizedMoney("1,234.56")).toBe(1234.56);
  });

  it("parses a plain English decimal (no thousands separator)", () => {
    expect(parseLocalizedMoney("1234.56")).toBe(1234.56);
  });

  it("parses a plain integer with no separators", () => {
    expect(parseLocalizedMoney("1250")).toBe(1250);
  });
});

describe("parseLocalizedMoney — currency symbols", () => {
  it("strips a leading euro sign with a space", () => {
    expect(parseLocalizedMoney("€ 12,50")).toBe(12.5);
  });

  it("strips a leading dollar sign with no space", () => {
    expect(parseLocalizedMoney("$12.50")).toBe(12.5);
  });

  it("strips a trailing currency code", () => {
    expect(parseLocalizedMoney("12.50 EUR")).toBe(12.5);
  });

  it("strips pound and yen symbols", () => {
    expect(parseLocalizedMoney("£9.99")).toBe(9.99);
    expect(parseLocalizedMoney("¥1000")).toBe(1000);
  });
});

describe("parseLocalizedMoney — thousands-only (no decimal)", () => {
  it("reads a single comma with exactly 3 trailing digits as thousands, not decimal", () => {
    expect(parseLocalizedMoney("1,234")).toBe(1234);
  });

  it("reads a single dot with exactly 3 trailing digits as thousands, not decimal", () => {
    expect(parseLocalizedMoney("1.234")).toBe(1234);
  });

  it("reads a full multi-group thousands split with no decimal", () => {
    expect(parseLocalizedMoney("1.234.567")).toBe(1234567);
    expect(parseLocalizedMoney("1,234,567")).toBe(1234567);
  });
});

describe("parseLocalizedMoney — OCR noise", () => {
  it("collapses a doubled decimal comma", () => {
    expect(parseLocalizedMoney("12,,50")).toBe(12.5);
  });

  it("collapses a doubled thousands dot", () => {
    expect(parseLocalizedMoney("1..234,56")).toBe(1234.56);
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseLocalizedMoney("  12,50  ")).toBe(12.5);
  });

  it("tolerates internal whitespace from OCR spacing artifacts", () => {
    expect(parseLocalizedMoney("1 234,56")).toBe(1234.56);
  });
});

describe("parseLocalizedMoney — malformed input never silently becomes a plausible amount", () => {
  it("rejects null/undefined/empty", () => {
    expect(parseLocalizedMoney(null)).toBeNull();
    expect(parseLocalizedMoney(undefined)).toBeNull();
    expect(parseLocalizedMoney("")).toBeNull();
    expect(parseLocalizedMoney("   ")).toBeNull();
  });

  it("rejects pure letters", () => {
    expect(parseLocalizedMoney("totale")).toBeNull();
  });

  it("rejects letters mixed with digits that don't form a currency+amount pattern", () => {
    expect(parseLocalizedMoney("12ab.50")).toBeNull();
  });

  it("rejects a decimal part longer than 2 digits when no valid thousands reading exists", () => {
    expect(parseLocalizedMoney("12.5678")).toBeNull();
  });

  it("rejects an inconsistent thousands grouping", () => {
    expect(parseLocalizedMoney("1.23.4567")).toBeNull();
    expect(parseLocalizedMoney("12,3,456")).toBeNull();
  });

  it("rejects two decimal-looking separators of different kinds both with 1-2 trailing digits", () => {
    // "12,34.56" — neither reading has a valid thousands grouping for the other separator
    expect(parseLocalizedMoney("12,34.56")).toBeNull();
  });

  it("rejects a lone separator with nothing after it", () => {
    expect(parseLocalizedMoney("12,")).toBeNull();
    expect(parseLocalizedMoney("12.")).toBeNull();
  });

  it("rejects a lone separator with nothing before it", () => {
    expect(parseLocalizedMoney(",50")).toBeNull();
  });
});

describe("parseLocalizedMoney — sign", () => {
  it("preserves a leading minus (e.g. a refund line)", () => {
    expect(parseLocalizedMoney("-12,50")).toBe(-12.5);
  });
});
