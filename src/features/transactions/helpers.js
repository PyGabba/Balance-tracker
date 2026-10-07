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

// ─── Receipt OCR text -> { importo, descrizione, categoria, data } (MOD-017) ───
// Pure: raw OCR text in, best-guess structured fields out. Extracted from
// ReceiptScanner.jsx so the total/category extraction logic is testable
// against realistic multi-line receipt fixtures without Tesseract or React.
// Amount extraction goes through lib/parseLocalizedMoney.js — never a
// naive comma-to-dot replace — so a locale-mismatched receipt total either
// parses correctly or is rejected, not silently ten-times wrong.
//
// The total is chosen by line role, not "first number that matches": a
// receipt is full of amounts that are NOT the total (VAT, cash tendered,
// change, discounts, loyalty points), and the old bottom-up scan happily
// returned "RESTO EUR 26,60" (the change) for a 23,40 receipt. Each line is
// classified by its keywords — matched on an OCR-normalised copy so
// "T0TALE" still reads as "totale" — and candidates are tried by tier:
//   1. total lines ("totale", "totale complessivo", "total", "amount due"…)
//   2. card/electronic payment lines (they carry exactly the total)
//   3. subtotal lines
//   4. the largest currency-marked amount on a non-excluded line
//   5. the largest decimal-shaped amount on a non-excluded line
// Excluded lines (VAT, change, cash tendered, discounts…) never supply a
// total at any tier.

const MAX_RECEIPT_AMOUNT = 10000;

// Matched as whole words/phrases against normalizeForKeywords(line).
const TOTAL_KEYWORDS = /\b(totale complessivo|totale da pagare|totale euro|totale eur|totale|tot\.? complessivo|da pagare|importo pagato|importo totale|grand total|total due|amount due|balance due|total|tot|importo|amount|sum)\b/;
const STRONG_TOTAL_KEYWORDS = /\b(complessivo|da pagare|importo pagato|grand total|total due|amount due|balance due)\b/;
const SUBTOTAL_KEYWORDS = /\b(subtotale|sub totale|subtotal|sub total|parziale)\b/;
const PAYMENT_KEYWORDS = /\b(pagamento elettronico|pagamento carta|carta di credito|carta|bancomat|pos|card|visa|mastercard|maestro|amex|credit|debit|satispay|apple pay|google pay)\b/;
const EXCLUDED_KEYWORDS = /\b(iva|vat|tax|imposta|imponibile|di cui|resto|change|contante|contanti|cash|sconto|sconti|discount|risparmio|risparmi|punti|points|buono|buoni|reso|tip|mancia|non riscosso|aliquota|netto)\b/;

const CATEGORY_KEYWORDS = {
  cibo: ["supermercato", "ristorante", "trattoria", "osteria", "pizzeria", "pizza", "panino", "paninoteca", "bar", "caffe", "cafe", "coffee", "gelateria", "pasticceria", "panificio", "forno", "macelleria", "pescheria", "alimentari", "frutta", "verdura", "pasta", "coop", "ipercoop", "carrefour", "esselunga", "conad", "lidl", "md", "eurospin", "despar", "spar", "penny", "aldi", "pam", "iper", "famila", "tigre", "bennet", "naturasi", "sushi", "kebab", "mcdonald", "mcdonalds", "burger king", "kfc", "autogrill", "starbucks", "food"],
  trasporti: ["benzina", "gasolio", "diesel", "carburante", "carburanti", "self service", "distributore", "stazione di servizio", "q8", "eni", "esso", "tamoil", "api", "shell", "totalerg", "totalenergies", "autostrade", "autostrada", "pedaggio", "telepass", "parcheggio", "parking", "bus", "treno", "trenitalia", "italo", "metro", "taxi", "uber"],
  casa: ["ikea", "leroy merlin", "brico", "bricoman", "obi", "ferramenta", "mondo convenienza", "condominio", "affitto", "arredamento"],
  salute: ["farmacia", "parafarmacia", "medico", "ospedale", "clinica", "analisi", "laboratorio", "dentista", "visita", "ottica", "ticket sanitario"],
  svago: ["cinema", "teatro", "concerto", "concert", "museo", "game", "playstation", "xbox", "steam", "netflix", "spotify", "palestra"],
  shopping: ["amazon", "ebay", "zalando", "nike", "adidas", "zara", "h&m", "outlet", "decathlon", "mediaworld", "unieuro", "euronics", "sephora", "douglas", "primark"],
  bollette: ["bolletta", "enel", "acea", "a2a", "hera", "iren", "vodafone", "tim", "wind", "windtre", "fastweb", "iliad", "luce", "gas", "acqua", "energia"],
};
const CATEGORY_PATTERNS = Object.fromEntries(Object.entries(CATEGORY_KEYWORDS).map(([cat, kws]) => [
  cat, kws.map(kw => new RegExp(`(?:^|[^a-z0-9&])${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^a-z0-9&])`)),
]));

// Lines that are almost never the merchant name, even near the top.
const NOT_MERCHANT = /\b(documento commerciale|scontrino|ricevuta|fattura|vendita|p\.? ?iva|partita iva|c\.? ?f\.?|cod\.? fisc|codice fiscale|via|viale|piazza|piazzale|corso|largo|tel|telefono|fax|www|http|cassa|cassiere|operatore|data|ora|benvenut[io]|welcome|receipt|grazie|thank)\b|@|\d{5,}/;

// Lowercase, strip accents, and undo the commonest OCR letter/digit swaps
// inside words ("T0TALE" → "totale", "IMP0RT0" → "importo") so keyword
// matching survives a smudged print. Only digits glued to letters are
// touched — amounts keep their digits.
function normalizeForKeywords(line) {
  const swaps = { 0: "o", 1: "l", 3: "e", 4: "a", 5: "s", 8: "b" };
  let s = line.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  for (let i = 0; i < 2; i++) { // twice: "t0t4le" has adjacent swaps
    s = s.replace(/([a-z])([013458])|([013458])([a-z])/g, (m, l1, d1, d2, l2) =>
      l1 ? l1 + swaps[d1] : swaps[d2] + l2);
  }
  return s.replace(/\s+/g, " ");
}

// Dates and times look like amounts ("12.05.24", "12.05") — blank them out
// before looking for money on a line.
const DATE_TOKEN = /\b\d{1,4}[/.-]\d{1,2}[/.-]\d{2,4}\b/g;
const TIME_TOKEN = /\b\d{1,2}:\d{2}(?::\d{2})?\b/g;

// Money-shaped tokens: digits with an optional thousands grouping and a
// 1-2 digit decimal part. OCR noise tolerated: a doubled separator ("12,,50")
// and a stray space after the separator ("12, 50").
const MONEY_TOKEN = /-?(?<![\d.,])\d{1,3}(?:[.,\s]\d{3})*(?:[.,]{1,2}\s?\d{1,2})(?![\d])|-?(?<![\d.,])\d+(?:[.,]{1,2}\s?\d{1,2})(?![\d])/g;
// O/o inside a number ("12,5O", "1O,00") is a zero; I/l/| is a one.
function fixDigitLookalikes(line) {
  return line.replace(/(?<=[\d.,])[oO]|[oO](?=[\d.,]\d)/g, "0").replace(/(?<=\d[.,]?)[Il|]|[Il|](?=[.,]?\d)/g, "1");
}

function moneyCandidates(line) {
  const cleaned = fixDigitLookalikes(line).replace(DATE_TOKEN, " ").replace(TIME_TOKEN, " ");
  const out = [];
  for (const m of cleaned.matchAll(MONEY_TOKEN)) {
    const val = parseLocalizedMoney(m[0].replace(/\s/g, ""));
    if (val != null) out.push(val);
  }
  return out;
}

// A whole-number total ("TOTALE 45") is only trusted on a keyword line.
function integerOnKeywordLine(line) {
  const cleaned = fixDigitLookalikes(line).replace(DATE_TOKEN, " ").replace(TIME_TOKEN, " ");
  const m = cleaned.match(/(?:^|[\s:€$])(\d{1,5})\s*(?:€|eur|euro)?\s*$/i);
  return m ? Number(m[1]) : null;
}

const plausible = v => v != null && v > 0 && v < MAX_RECEIPT_AMOUNT;

function extractTotal(lines) {
  const rows = lines.map((raw, idx) => {
    const norm = normalizeForKeywords(raw);
    return {
      raw, idx,
      excluded: EXCLUDED_KEYWORDS.test(norm),
      subtotal: SUBTOTAL_KEYWORDS.test(norm),
      total: !SUBTOTAL_KEYWORDS.test(norm) && TOTAL_KEYWORDS.test(norm),
      strong: STRONG_TOTAL_KEYWORDS.test(norm),
      payment: PAYMENT_KEYWORDS.test(norm),
      currency: /[€$£]|\beur\b|\beuro\b/i.test(raw),
      amounts: moneyCandidates(raw),
    };
  });
  // The amount on a keyword line is the right-most one; a total keyword with
  // its amount OCR'd onto the next line is common, so look one line down.
  const lineAmount = (r) => {
    const own = r.amounts.length ? r.amounts[r.amounts.length - 1] : integerOnKeywordLine(r.raw);
    if (plausible(own)) return own;
    const next = rows[r.idx + 1];
    if (next && !next.excluded && next.amounts.length === 1 && /^[^a-z]*$/i.test(next.raw.replace(/eur[o]?/i, ""))) {
      return plausible(next.amounts[0]) ? next.amounts[0] : null;
    }
    return null;
  };
  const paymentAmounts = new Set(rows.filter(r => r.payment && !r.excluded).map(lineAmount).filter(plausible));

  // Tier 1: total lines. Prefer strong phrasing ("complessivo", "amount
  // due"), then a total corroborated by a payment line, then the lowest line.
  const totals = rows.filter(r => r.total && !r.excluded)
    .map(r => ({ r, v: lineAmount(r) }))
    .filter(c => plausible(c.v));
  if (totals.length) {
    const score = c => (c.r.strong ? 4 : 0) + (paymentAmounts.has(c.v) ? 2 : 0) + c.r.idx / 1000;
    return { value: totals.reduce((best, c) => (score(c) > score(best) ? c : best)).v, source: "total" };
  }
  // Tier 2: card/electronic payment line.
  const payments = rows.filter(r => r.payment && !r.excluded).map(lineAmount).filter(plausible);
  if (payments.length) return { value: payments[payments.length - 1], source: "payment" };
  // Tier 3: subtotal lines (bottom-most).
  const subs = rows.filter(r => r.subtotal && !r.excluded).map(lineAmount).filter(plausible);
  if (subs.length) return { value: subs[subs.length - 1], source: "subtotal" };
  // Tier 4/5: largest amount on a non-excluded line, currency-marked first.
  const pool = (filter) => rows.filter(r => !r.excluded && filter(r)).flatMap(r => r.amounts).filter(plausible);
  const marked = pool(r => r.currency);
  if (marked.length) return { value: Math.max(...marked), source: "fallback" };
  const any = pool(() => true);
  return any.length ? { value: Math.max(...any), source: "fallback" } : { value: null, source: null };
}

function extractMerchant(lines) {
  for (const raw of lines.slice(0, 6)) {
    const line = raw.replace(/^[^\p{L}\d]+|[^\p{L}\d.)'&]+$/gu, "").replace(/\s{2,}/g, " ");
    const letters = (line.match(/\p{L}/gu) || []).length;
    if (line.length < 3 || line.length > 40 || letters < 3) continue;
    if (letters / line.replace(/\s/g, "").length < 0.5) continue; // mostly digits/symbols: OCR junk
    if (NOT_MERCHANT.test(normalizeForKeywords(line))) continue;
    if (moneyCandidates(line).length) continue; // an item or total line, not a header
    return line;
  }
  return "";
}

// Category by keyword votes; the merchant line counts triple since "BAR
// CENTRALE" says more than a "bar" somewhere in the item list.
function extractCategory(text, merchant) {
  const body = normalizeForKeywords(text);
  const head = normalizeForKeywords(merchant);
  let best = "", bestScore = 0;
  for (const [cat, patterns] of Object.entries(CATEGORY_PATTERNS)) {
    let score = 0;
    for (const re of patterns) {
      if (head && re.test(head)) score += 3;
      if (re.test(body)) score += 1;
    }
    if (score > bestScore) { best = cat; bestScore = score; }
  }
  return best;
}

// Purchase date → "YYYY-MM-DD", or null. Day-first (Italian) unless only
// month-first is a valid date; never in the future and at most a year old,
// since a receipt being scanned is a recent one.
function extractDate(text, oggi) {
  const today = new Date(oggi.getFullYear(), oggi.getMonth(), oggi.getDate());
  const oldest = new Date(today.getFullYear() - 1, today.getMonth(), today.getDate());
  const valid = (y, m, d) => {
    const dt = new Date(y, m - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
    return dt >= oldest && dt <= today ? dt : null;
  };
  const iso = dt => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
  for (const m of text.matchAll(/\b(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})\b/g)) {
    const dt = valid(+m[1], +m[2], +m[3]);
    if (dt) return iso(dt);
  }
  for (const m of text.matchAll(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})\b/g)) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    const dt = valid(y, +m[2], +m[1]) || valid(y, +m[1], +m[2]);
    if (dt) return iso(dt);
  }
  return null;
}

// `totalSource` says how the total was found — "total" (a total line),
// "payment", "subtotal", "fallback" (largest amount) or null — so the OCR
// pipeline can retry when it only has a guess.
export function parseReceiptText(text, { oggi = new Date() } = {}) {
  const lines = String(text || "").split("\n").map((l) => l.trim()).filter(Boolean);
  const descrizione = extractMerchant(lines);
  const total = extractTotal(lines);
  return {
    importo: total.value,
    totalSource: total.source,
    descrizione,
    categoria: extractCategory(lines.join("\n"), descrizione),
    data: extractDate(lines.join("\n"), oggi),
  };
}
