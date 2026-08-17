// ─── Transaction-specific helpers (MOD-012) ───

import { parseLocalizedMoney } from "../../lib/parseLocalizedMoney.js";

// Reconstructs a split array for a transaction that predates the current
// splits format (older docs only stored splitPagante, a 2-person percent).
export function initialSplits(t, persone) {
  if (t.splits) return t.splits;
  if (t.splitPagante != null) {
    const payer = t.pagatoDa || persone[0]?.id;
    const otherId = persone.find(p => p.id !== payer)?.id || persone[1]?.id;
    return [
      { personaId: payer, quota: t.splitPagante },
      { personaId: otherId, quota: 100 - t.splitPagante },
    ];
  }
  if (t.pagatoDa) return [{ personaId: t.pagatoDa, quota: 100 }];
  return [];
}

export function calcolaProssimaData(data, frequenza) {
  const d = new Date(data + "T12:00:00");
  if (frequenza === "settimanale") d.setDate(d.getDate() + 7);
  else if (frequenza === "mensile") d.setMonth(d.getMonth() + 1);
  else if (frequenza === "trimestrale") d.setMonth(d.getMonth() + 3);
  else if (frequenza === "annuale") d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

// Fallback list shown before the live rates table loads (or if offline) — the
// real option list is the keys of GET /api/exchange-rates, ~160 currencies.
export const VALUTE_FALLBACK = ["EUR", "USD", "GBP", "CHF", "JPY", "CAD", "AUD", "CNY", "SEK", "NOK", "PLN"];
export const RICORRENZA_IDS = ["no", "settimanale", "mensile", "trimestrale", "annuale"];

// ─── Receipt OCR text -> { importo, descrizione, categoria } (MOD-017) ───
// Pure: raw OCR text in, best-guess structured fields out. Extracted from
// ReceiptScanner.jsx so the total/category extraction logic is testable
// against realistic multi-line receipt fixtures without Tesseract or React.
// Amount extraction goes through lib/parseLocalizedMoney.js — never a
// naive comma-to-dot replace — so a locale-mismatched receipt total either
// parses correctly or is rejected, not silently ten-times wrong.
const TOTAL_PATTERNS = [
  /(?:totale|total|amount|sum)[\s:]*[\€\$]?\s*([\d.,]+)/i,
  /(?:€\s*|EUR\s*)\s*([\d.,]+)/i,
  /^[\€\$]?\s*([\d.,]+)\s*$/m,
  /(?:sub\s*total|subtotale)[\s:]*[\€\$]?\s*([\d.,]+)/i,
  /([\d.,]+)\s*[\€\$]\s*$/m,
];

const RECEIPT_CATEGORY_KEYWORDS = {
  cibo: ["panino", "pizza", "caffè", "bar", "ristorante", "supermercato", "coop", "carrefour", "esselunga", "md", "lidl", "conad", "bio", "food", "pasta", "frutta"],
  trasporti: ["benzina", "gasolio", "enel", "energia", "elettrico", "carburante", "q8", "eni", "tamoil", "api", "shell", "totalerg", "bus", "treno", "trenitalia"],
  casa: ["enel", "acea", "vodafone", "tim", "wind", "fastweb", "internet", "luce", "gas", "acqua", "condominio"],
  salute: ["farmacia", "medico", "ospedale", "clinica", "analisi", "laboratorio", "dentista", "visita"],
  svago: ["cinema", "teatro", "concert", "game", "playstation", "xbox", "steam", "netflix", "spotify", "abbonamento"],
  shopping: ["amazon", "ebay", "zalando", "nike", "adidas", "zara", "h&m", "outlet"],
  bollette: ["bolletta", "fattura", "pagamento", "rimborso"],
};

export function parseReceiptText(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const result = { importo: null, descrizione: "", categoria: "" };

  for (const line of [...lines].reverse()) {
    for (const pat of TOTAL_PATTERNS) {
      const match = line.match(pat);
      if (match) {
        const val = parseLocalizedMoney(match[1]);
        if (val != null && val > 0 && val < 10000) {
          result.importo = val;
          break;
        }
      }
    }
    if (result.importo) break;
  }

  if (!result.importo) {
    const moneyMatch = text.match(/[\€\$]\s*([\d.,]{2,})/);
    if (moneyMatch) {
      const val = parseLocalizedMoney(moneyMatch[1]);
      if (val != null && val > 0 && val < 10000) result.importo = val;
    }
  }

  if (lines.length > 0) {
    const firstLine = lines[0];
    if (firstLine.length > 2 && firstLine.length < 50) {
      result.descrizione = firstLine;
    }
  }

  const lowerText = text.toLowerCase();
  for (const [catId, keywords] of Object.entries(RECEIPT_CATEGORY_KEYWORDS)) {
    for (const kw of keywords) {
      if (lowerText.includes(kw)) {
        result.categoria = catId;
        break;
      }
    }
    if (result.categoria) break;
  }

  return result;
}
