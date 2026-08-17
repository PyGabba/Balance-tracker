// ─── Money arithmetic (MOD-016) ───
// Binary floating point is a poor native representation for currency
// (0.1 + 0.2 !== 0.3), so every sum/difference in this codebase that
// touches money should go through integer minor units (cents) instead of
// accumulating raw floats and rounding only at the end — that's exactly
// the pattern that lets float drift compound across many additions before
// the final Math.round() papers over it.
//
// Storage/API contract stays a decimal number (e.g. 12.34) — this module
// does not change what's persisted or what a client sends/receives. What
// it DOES do (the MOD-016 "contract phase," scoped deliberately to an
// internal, non-breaking cutover — see minorUnitsOf below): every write
// path now also sets an integer `*MinorUnits` companion field alongside
// the decimal one (server/validation.js, migration 001 backfills existing
// records), and internal financial calculations treat that companion
// field as authoritative when it's present, falling back to converting
// the decimal field only for the legacy documents that predate it. A
// full breaking cutover — dropping the decimal field from the API/DB
// entirely — is a deliberately separate, not-yet-scheduled future step;
// doing it now would require a coordinated frontend+backend deploy and
// break any external widget/Shortcuts integration still parsing `importo`,
// for no benefit this internal cutover doesn't already capture.
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

// ─── MOD-016 contract phase: importoMinorUnits is authoritative ───
// Reads an entity's minor-units companion field if it's set (every
// document written since the *MinorUnits fields were introduced has one —
// see server/validation.js and migration 001), otherwise derives it from
// the decimal field by converting fresh. This is the ONE place that
// decision is made — every internal calculation should read a stored
// amount through this accessor rather than choosing per call site,
// specifically to avoid the divergent-state failure mode where one code
// path trusts a stale/absent companion field and another recomputes from
// decimal, silently producing two different balances from the same
// document. `field` defaults to "importo"/"importoMinorUnits" (the
// transaction/trip-expense shape); pass e.g. "saldoIniziale" for accounts,
// "prezzoAcquisto" for positions, "targetAmount"/"currentAmount" for goals.
export function minorUnitsOf(entity, field = "importo", currency) {
  const minorField = `${field}MinorUnits`;
  const minor = entity?.[minorField];
  if (typeof minor === "number" && Number.isFinite(minor)) return minor;
  return toMinorUnits(entity?.[field], currency);
}
