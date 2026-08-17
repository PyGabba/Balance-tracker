import { describe, it, expect } from "vitest";
import { parseReceiptText, initialSplits, calcolaProssimaData } from "./helpers.js";

describe("parseReceiptText — Italian receipts", () => {
  it("extracts the total from a supermarket receipt with an Italian decimal comma", () => {
    const text = [
      "COOP SUPERMERCATO",
      "Via Roma 12, Milano",
      "PANE                2,50",
      "PASTA               1,80",
      "TOTALE              4,30",
      "GRAZIE E ARRIVEDERCI",
    ].join("\n");
    const result = parseReceiptText(text);
    expect(result.importo).toBe(4.3);
    expect(result.categoria).toBe("cibo");
  });

  it("extracts a thousands-grouped Italian total", () => {
    const text = ["ESSELUNGA", "TOTALE € 1.234,56"].join("\n");
    const result = parseReceiptText(text);
    expect(result.importo).toBe(1234.56);
  });

  it("recognizes subtotale as an Italian total keyword", () => {
    const text = ["FARMACIA CENTRALE", "Subtotale: 12,50"].join("\n");
    const result = parseReceiptText(text);
    expect(result.importo).toBe(12.5);
    expect(result.categoria).toBe("salute");
  });
});

describe("parseReceiptText — English receipts", () => {
  it("extracts the total from a US-style receipt with a dot decimal", () => {
    const text = [
      "STARBUCKS COFFEE",
      "Latte              4.50",
      "Muffin             3.25",
      "TOTAL              7.75",
      "THANK YOU",
    ].join("\n");
    const result = parseReceiptText(text);
    expect(result.importo).toBe(7.75);
  });

  it("extracts a comma-thousands English total", () => {
    const text = ["AMAZON.COM", "Amount: $1,234.56"].join("\n");
    const result = parseReceiptText(text);
    expect(result.importo).toBe(1234.56);
    expect(result.categoria).toBe("shopping");
  });
});

describe("parseReceiptText — OCR noise", () => {
  it("still finds the total when OCR doubles a separator", () => {
    const text = ["BAR CENTRALE", "TOTALE 12,,50"].join("\n");
    const result = parseReceiptText(text);
    expect(result.importo).toBe(12.5);
  });

  it("falls back to a bare currency-prefixed number when no total keyword is present", () => {
    const text = ["RISTORANTE DA MARIO", "€ 45,00"].join("\n");
    const result = parseReceiptText(text);
    expect(result.importo).toBe(45);
  });
});

describe("parseReceiptText — malformed / no amount", () => {
  it("never turns an ambiguous double-dot total into a wrong amount", () => {
    const text = ["NEGOZIO", "TOTALE 1.234.56"].join("\n");
    const result = parseReceiptText(text);
    expect(result.importo).toBeNull();
  });

  it("returns null importo when there's no parseable number at all", () => {
    const text = ["JUST SOME TEXT", "NO NUMBERS HERE"].join("\n");
    const result = parseReceiptText(text);
    expect(result.importo).toBeNull();
  });

  it("rejects an out-of-range amount (receipt sanity bound)", () => {
    const text = ["TOTALE 99999,00"].join("\n");
    const result = parseReceiptText(text);
    expect(result.importo).toBeNull();
  });
});

describe("parseReceiptText — description and category", () => {
  it("uses the first line as the description when it's a plausible length", () => {
    const text = ["Bar Centrale Milano", "TOTALE 3,50"].join("\n");
    const result = parseReceiptText(text);
    expect(result.descrizione).toBe("Bar Centrale Milano");
  });

  it("categorizes based on keyword match anywhere in the text", () => {
    const text = ["Q8 STAZIONE DI SERVIZIO", "TOTALE 45,00"].join("\n");
    const result = parseReceiptText(text);
    expect(result.categoria).toBe("trasporti");
  });
});

// Sanity check that the extraction moved here without behavior change on
// the other two pure helpers already living in this file.
describe("existing helpers still work after the parseReceiptText move", () => {
  it("initialSplits", () => {
    expect(initialSplits({ pagatoDa: "g" }, [{ id: "g" }, { id: "l" }])).toEqual([{ personaId: "g", quota: 100 }]);
  });

  it("calcolaProssimaData", () => {
    expect(calcolaProssimaData("2026-01-15", "mensile")).toBe("2026-02-15");
  });
});
