// ─── Money arithmetic (MOD-016) ───
// Binary floating point is a poor native representation for currency
// (0.1 + 0.2 !== 0.3), so every sum/difference in this codebase that
// touches money should go through integer minor units (cents) instead of
// accumulating raw floats and rounding only at the end — that's exactly
// the pattern that lets float drift compound across many additions before
// the final Math.round() papers over it.
//
// Storage stays a decimal number (e.g. 12.34), same as before this
// module existed — this is the arithmetic layer only, not a change to
// what's persisted (see MOD-016 in the modification plan for the larger,
// not-yet-done storage migration to a true amountMinorUnits field, which
// depends on MOD-026's migration framework).
//
// Every function here is pure: number/string in, number out, no I/O.

// Minor-unit precision (decimal places) per currency. Currencies not
// listed default to 2, which covers every currency this app has ever
// actually needed (EUR/USD/GBP/CHF/...); the zero-decimal currencies are
// listed explicitly since silently treating ¥1000 as ¥10.00 would be a
// real, not theoretical, bug if one of these were ever selected.
const ZERO_DECIMAL_CURRENCIES = new Set(["JPY", "KRW", "VND", "CLP", "ISK", "HUF"]);

export function minorUnitsPrecision(currency) {
  const c = typeof currency === "string" ? currency.toUpperCase() : "";
  return ZERO_DECIMAL_CURRENCIES.has(c) ? 0 : 2;
}

// Converts a decimal amount to an integer number of minor units (cents),
// rounding once at the conversion boundary rather than trusting the input
// to already be exactly representable in binary floating point.
export function toMinorUnits(amount, currency) {
  const precision = minorUnitsPrecision(currency);
  return Math.round(amount * 10 ** precision);
}

// Inverse of toMinorUnits.
export function fromMinorUnits(minorUnits, currency) {
  const precision = minorUnitsPrecision(currency);
  return minorUnits / 10 ** precision;
}

// Rounds a decimal amount to the currency's minor-unit precision by
// round-tripping through an integer instead of the common but fragile
// `Math.round(n * 100) / 100` (which is fine for a single value, but
// doesn't compose — chaining it across a sum still lets intermediate
// float error accumulate; sumAmounts below is what actually avoids that).
export function roundAmount(amount, currency) {
  return fromMinorUnits(toMinorUnits(amount, currency), currency);
}

// Sums a list of decimal amounts by converting each to integer minor
// units first, adding as integers (exact, no float drift regardless of
// how many terms), and converting back once at the end. Prefer this over
// `arr.reduce((s, x) => s + x, 0)` for anything money-shaped.
export function sumAmounts(amounts, currency) {
  const totalMinor = amounts.reduce((s, a) => s + toMinorUnits(a, currency), 0);
  return fromMinorUnits(totalMinor, currency);
}

// a - b, via integer minor units.
export function subtractAmounts(a, b, currency) {
  return fromMinorUnits(toMinorUnits(a, currency) - toMinorUnits(b, currency), currency);
}
