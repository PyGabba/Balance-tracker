// ─── Weekly portfolio snapshots (pure) ───
// The portfolio chart used to *reconstruct* past values from today's price
// (there is no price history to read), which is why it could show smooth
// gains that never happened. Instead: the first time prices are refreshed in
// each week (weeks start on Sunday) the real total — every holding's
// quantity × its price at that moment — is saved, and the chart plots those
// real points. This module decides WHEN to save and WHAT to save; storing
// is the server's job (server/routes/positions.js).

import { calcolaValorePortfolio } from "../lib/finance.js";
import { roundAmount } from "../lib/money.js";
import { computeHoldingsBreakdown, localDateStr } from "./portfolioService.js";

export { localDateStr };

// The Sunday that starts the week containing `d` (the most recent Sunday on
// or before it). This is the snapshot's identity: one per week.
export function weekKeyFor(d = new Date()) {
  const sunday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay());
  return localDateStr(sunday);
}

// What a refresh should record, or null when there's nothing trustworthy to
// record: no open holdings, or any holding without a real price (manual or
// live) — it would otherwise be valued at cost and quietly record a number
// that isn't the market value. holdings = the per-ticker detail
// (quantity × price) that makes up the total.
export function buildSnapshot({ positions, manualPrices = {}, autoPrices = {}, now = new Date() }) {
  const { holdings } = computeHoldingsBreakdown(positions);
  if (holdings.length === 0) return null;
  const priceOf = (ticker) => manualPrices[ticker] || autoPrices[ticker] || 0;
  if (holdings.some(h => !(priceOf(h.ticker) > 0))) return null;
  const { valore, investito } = calcolaValorePortfolio(positions, manualPrices, autoPrices);
  return {
    weekKey: weekKeyFor(now),
    date: localDateStr(now),
    valore: roundAmount(valore),
    investito: roundAmount(investito),
    holdings: holdings.map(h => ({ ticker: h.ticker, quantita: h.quantita, prezzo: priceOf(h.ticker) })),
  };
}

// First refresh of the week wins; later ones that week don't add or replace.
export function needsSnapshot(snapshots, weekKey) {
  return !(snapshots || []).some(s => s.weekKey === weekKey);
}
