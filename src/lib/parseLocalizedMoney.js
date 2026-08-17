// ─── Locale-aware money parsing (MOD-017) ───
// OCR receipt text (and any other "user typed/scanned a number" input) can
// use either decimal convention — "1.234,56" (Italian: dot = thousands,
// comma = decimal) or "1,234.56" (English: comma = thousands, dot =
// decimal) — and a naive `str.replace(",", ".")` (the old ReceiptScanner
// implementation) silently mangles the Italian case: "1.234,56" becomes
// "1.234.56", and parseFloat stops at the second dot, returning 1.234 —
// eleven times too small, with no error raised anywhere.
//
// The rule this function applies: with both separators present, whichever
// one appears LAST is the decimal separator; the other must divide the
// remaining digits into a valid thousands grouping (first group 1-3
// digits, every other group exactly 3) or the input is rejected as
// ambiguous rather than guessed — this is exactly why "1.234.56" (two
// dots, last group only 2 digits — not a valid grouping under either
// reading) is invalid rather than silently becoming 1234.56 or 1.23456.
// With only one separator, 1-2 trailing digits reads as a decimal part,
// exactly 3 reads as a thousands-only integer (money is essentially never
// quoted to 3 decimal places) — locale-invariant, no locale hint needed
// for any pattern that actually shows up on a receipt.
//
// Returns a finite number (negative allowed — a refund line), or null —
// NEVER a plausible but wrong number. Doesn't round to a currency's
// minor-unit precision; pair with lib/money.js's roundAmount for that.

const CURRENCY_SYMBOLS = /[€$£¥]/g;
const CURRENCY_CODES = /\b(EUR|USD|GBP|CHF|JPY)\b/gi;

function stripNoise(raw) {
  return String(raw)
    .replace(CURRENCY_SYMBOLS, "")
    .replace(CURRENCY_CODES, "")
    .trim()
    // OCR commonly smudges a single separator into a doubled one
    // ("12,,50", "1..234") — collapse runs of the SAME separator. A run
    // mixing "," and "." is left alone so the grouping checks below can
    // reject it as genuine ambiguity instead of silently guessing.
    .replace(/,{2,}/g, ",")
    .replace(/\.{2,}/g, ".")
    .replace(/\s+/g, "");
}

// groups = digit strings between separators in order, e.g.
// "1.234.567" -> ["1", "234", "567"]. Valid thousands grouping: first
// group 1-3 digits, every subsequent group exactly 3.
function isValidGrouping(groups) {
  if (groups.length === 0 || groups.some(g => g === "")) return false;
  if (!/^\d{1,3}$/.test(groups[0])) return false;
  return groups.slice(1).every(g => /^\d{3}$/.test(g));
}

export function parseLocalizedMoney(raw) {
  if (raw == null) return null;
  const s = stripNoise(raw);
  if (!s) return null;

  const negative = s.startsWith("-");
  const body = negative ? s.slice(1) : s;
  if (!/^[\d.,]+$/.test(body) || !/\d/.test(body)) return null; // stray letters/symbols survived stripping, or no digits at all

  const commaCount = (body.match(/,/g) || []).length;
  const dotCount = (body.match(/\./g) || []).length;

  let integerPart, decimalPart;

  if (commaCount > 0 && dotCount > 0) {
    const lastComma = body.lastIndexOf(",");
    const lastDot = body.lastIndexOf(".");
    const decimalIsComma = lastComma > lastDot;
    // Exactly one instance of whichever separator is the decimal one —
    // "1,234,56" (comma last, but two commas) isn't a valid single decimal.
    if ((decimalIsComma ? commaCount : dotCount) !== 1) return null;
    const decimalIdx = decimalIsComma ? lastComma : lastDot;
    const intRaw = body.slice(0, decimalIdx);
    decimalPart = body.slice(decimalIdx + 1);
    if (!/^\d{1,2}$/.test(decimalPart)) return null; // money decimals are 0-2 digits
    const groups = intRaw.split(decimalIsComma ? "." : ",");
    if (!isValidGrouping(groups)) return null;
    integerPart = groups.join("");
  } else if (commaCount === 1 || dotCount === 1) {
    const sep = commaCount === 1 ? "," : ".";
    const [intRaw, frac] = body.split(sep);
    if (intRaw === "") return null;
    if (/^\d{3}$/.test(frac) && intRaw.length <= 3) {
      // e.g. "1,234" with nothing else — thousands-only integer, no decimal.
      integerPart = intRaw + frac;
      decimalPart = "";
    } else if (/^\d{1,2}$/.test(frac)) {
      integerPart = intRaw;
      decimalPart = frac;
    } else {
      return null;
    }
  } else if (commaCount === 0 && dotCount === 0) {
    integerPart = body;
    decimalPart = "";
  } else {
    // 2+ of the same separator, none of the other — valid only as a full
    // multi-group thousands split ("1.234.567"); anything else (the plan's
    // own "1.234.56" example) is ambiguous, not guessable.
    const groups = body.split(commaCount > 0 ? "," : ".");
    if (!isValidGrouping(groups)) return null;
    integerPart = groups.join("");
    decimalPart = "";
  }

  const n = parseFloat(decimalPart ? `${integerPart}.${decimalPart}` : integerPart);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}
