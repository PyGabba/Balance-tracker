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

describe("parseReceiptText — real-world receipt structure", () => {
  const oggi = new Date(2026, 9, 7); // 7 ottobre 2026

  it("picks TOTALE COMPLESSIVO over VAT, cash tendered and change on an Italian documento commerciale", () => {
    const text = [
      "DOCUMENTO COMMERCIALE",
      "di vendita o prestazione",
      "ESSELUNGA S.P.A.",
      "VIA FANTOLI 18 MILANO",
      "P.IVA 01255720169",
      "DESCRIZIONE      IVA    PREZZO(€)",
      "LATTE INTERO     4%     1,29",
      "BANANE           4%     2,15",
      "DETERSIVO        22%    4,99",
      "TOTALE COMPLESSIVO      8,43",
      "DI CUI IVA              1,08",
      "CONTANTE               20,00",
      "RESTO                  11,57",
      "12-03-2026 18:42",
      "DOC.N. 0123-0456",
    ].join("\n");
    const r = parseReceiptText(text, { oggi });
    expect(r.importo).toBe(8.43);
    expect(r.descrizione).toBe("ESSELUNGA S.P.A.");
    expect(r.categoria).toBe("cibo");
    expect(r.data).toBe("2026-03-12");
  });

  it("never returns the change (RESTO EUR …) as the total", () => {
    const text = ["BAR SPORT", "CAFFE 1,20", "CORNETTO 1,30", "TOTALE 2,50", "CONTANTI EUR 10,00", "RESTO EUR 7,50"].join("\n");
    expect(parseReceiptText(text, { oggi }).importo).toBe(2.5);
  });

  it("reads an OCR-smudged keyword (T0TALE) and ignores the VAT line below it", () => {
    const text = ["NEGOZIO", "T0TALE 23,40", "IVA 22% 4,22"].join("\n");
    expect(parseReceiptText(text, { oggi }).importo).toBe(23.4);
  });

  it("fixes O/0 lookalikes inside the amount", () => {
    expect(parseReceiptText("TOTALE 1O,5O", { oggi }).importo).toBe(10.5);
  });

  it("uses the electronic payment line when there's no total line", () => {
    const text = ["PIZZERIA DA GINO", "MARGHERITA 7,00", "BIRRA 4,50", "PAGAMENTO ELETTRONICO 11,50", "IVA 10% 1,05"].join("\n");
    const r = parseReceiptText(text, { oggi });
    expect(r.importo).toBe(11.5);
    expect(r.categoria).toBe("cibo");
  });

  it("prefers a strong total phrase over an earlier plain TOTALE", () => {
    const text = ["TOTALE 20,00", "SCONTO 5,00", "TOTALE COMPLESSIVO 15,00"].join("\n");
    expect(parseReceiptText(text, { oggi }).importo).toBe(15);
  });

  it("finds a total whose amount OCR put on the next line", () => {
    expect(parseReceiptText(["SHOP", "TOTALE EURO", "23,40"].join("\n"), { oggi }).importo).toBe(23.4);
  });

  it("does not mistake dates or times for amounts, and accepts a whole-number total", () => {
    const r = parseReceiptText(["NEGOZIO", "12.05.26 10:30", "TOTALE 5"].join("\n"), { oggi });
    expect(r.importo).toBe(5);
    expect(r.data).toBe("2026-05-12");
  });

  it("reports how the total was found, so the OCR pipeline knows when to retry", () => {
    expect(parseReceiptText("SHOP\nTOTALE 5,00", { oggi }).totalSource).toBe("total");
    expect(parseReceiptText("SHOP\nPAGAMENTO CARTA 5,00", { oggi }).totalSource).toBe("payment");
    expect(parseReceiptText("SHOP\nSUBTOTAL 5.00", { oggi }).totalSource).toBe("subtotal");
    expect(parseReceiptText("SHOP\nARTICOLO 5,00", { oggi }).totalSource).toBe("fallback");
    expect(parseReceiptText("SHOP", { oggi }).totalSource).toBeNull();
  });

  it("fallback never takes an excluded line's amount", () => {
    expect(parseReceiptText(["NEGOZIO X", "SCONTO 50,00", "ARTICOLO 30,00"].join("\n"), { oggi }).importo).toBe(30);
  });
});

describe("parseReceiptText — merchant, category and date", () => {
  const oggi = new Date(2026, 9, 7);

  it("skips OCR junk and header boilerplate to find the merchant", () => {
    const text = ["~~~~", "*** 12 ***", "Trattoria Da Luigi", "Via Roma 1", "TOTALE 30,00"].join("\n");
    const r = parseReceiptText(text, { oggi });
    expect(r.descrizione).toBe("Trattoria Da Luigi");
    expect(r.categoria).toBe("cibo");
  });

  it("never uses an item line with a price as the merchant", () => {
    const text = ["S217 TRADER JOE'S #552", "£5 4.49", "COFFEE BEANS 8.99", "TOTAL 15.71"].join("\n");
    expect(parseReceiptText(text, { oggi }).descrizione).toBe("S217 TRADER JOE'S #552");
  });

  it("matches category keywords as whole words (TIMBRO is not TIM, PAGAMENTO is not a bill)", () => {
    const text = ["CARTOLERIA ROSSI", "TIMBRO 12,00", "TOTALE 12,00", "PAGAMENTO CARTA 12,00"].join("\n");
    expect(parseReceiptText(text, { oggi }).categoria).toBe("");
  });

  it("weights the merchant line over incidental item keywords", () => {
    const text = ["FARMACIA SAN MARCO", "CARAMELLE BAR 2,00", "TOTALE 2,00"].join("\n");
    expect(parseReceiptText(text, { oggi }).categoria).toBe("salute");
  });

  it("reads a month-first date only when day-first is impossible", () => {
    expect(parseReceiptText("STORE\n03/15/2026\nTOTAL 9.99", { oggi }).data).toBe("2026-03-15");
    expect(parseReceiptText("NEGOZIO\n03/04/2026\nTOTALE 9,99", { oggi }).data).toBe("2026-04-03");
  });

  it("ignores dates in the future or more than a year old", () => {
    expect(parseReceiptText("NEGOZIO\n15/12/2026\nTOTALE 1,00", { oggi }).data).toBeNull();
    expect(parseReceiptText("NEGOZIO\n01/01/2024\nTOTALE 1,00", { oggi }).data).toBeNull();
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
