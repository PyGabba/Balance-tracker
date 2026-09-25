// ─── Portfolio domain logic (MOD-013 / MOD-018) ───
// computePortfolioValue (current value + invested) lives in lib/finance.js
// already. This module adds the per-ticker holdings breakdown (realized
// P&L, average cost, open vs. closed positions) that used to be
// recalculated inline inside PortfolioView.jsx — a second, drifting copy
// of the same average-cost accounting rules used by calcolaValorePortfolio.
// Pure: no React state, no API calls.

export { calcolaValorePortfolio as computePortfolioValue } from "../lib/finance.js";

import { fromMinorUnits, minorUnitsOf } from "../lib/money.js";

// Trades are processed chronologically: a sell reduces cost basis by
// qty × average cost, and realizes qty × (sell price − average cost) as
// P&L. Overselling is clamped to the held quantity. Fully closed positions
// (quantity back to zero via a sell) are returned separately with their
// realized P&L.
export function computeHoldingsBreakdown(positions) {
  const holdings = [];
  const closedHoldings = [];
  const tickerMap = {};
  const sorted = [...positions].sort((a, b) =>
    (a.dataAcquisto || "").localeCompare(b.dataAcquisto || "") ||
    (a.createdAt || "").localeCompare(b.createdAt || "")
  );
  for (const p of sorted) {
    if (!tickerMap[p.ticker]) {
      tickerMap[p.ticker] = { ticker: p.ticker, nome: p.nome || p.ticker, quantita: 0, costoTotale: 0, realizzato: 0, trades: [] };
    }
    const h = tickerMap[p.ticker];
    // MOD-016 contract phase: prezzoAcquistoMinorUnits, when set, is the
    // authoritative price — see minorUnitsOf in lib/money.js.
    const prezzo = fromMinorUnits(minorUnitsOf(p, "prezzoAcquisto"));
    if (p.tipo === "sell") {
      const avg = h.quantita > 0.0001 ? h.costoTotale / h.quantita : 0;
      const sellQ = Math.min(p.quantita, h.quantita); // guard against overselling
      h.realizzato += sellQ * (prezzo - avg);
      h.costoTotale -= sellQ * avg;
      h.quantita -= sellQ;
      if (h.quantita < 0.0001) { h.quantita = 0; h.costoTotale = 0; }
    } else {
      h.quantita += p.quantita;
      h.costoTotale += p.quantita * prezzo;
    }
    h.trades.push(p);
  }
  for (const k of Object.keys(tickerMap)) {
    const h = tickerMap[k];
    if (h.quantita > 0.0001) {
      h.prezzoMedio = h.costoTotale / h.quantita;
      holdings.push(h);
    } else if (h.trades.some(t => t.tipo === "sell")) {
      h.ultimaData = h.trades[h.trades.length - 1]?.dataAcquisto || "";
      closedHoldings.push(h);
    }
  }
  closedHoldings.sort((a, b) => (b.ultimaData || "").localeCompare(a.ultimaData || ""));
  const totalRealizzato = [...holdings, ...closedHoldings].reduce((s, h) => s + h.realizzato, 0);
  return { holdings, closedHoldings, totalRealizzato };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

// Weekly portfolio value series + a short forward projection.
//
// No historical price feed exists (fetchQuotes only returns *current*
// quotes), so past weekly values are an estimate: at each week we take the
// real cost basis held as of that date (from computeHoldingsBreakdown on
// the trades up to that date) and scale it by the portfolio's overall gain
// ratio (currentValue / currentCost), interpolated linearly from 1.0 at the
// first trade to the real ratio today. This reproduces the exact current
// total exactly at the last point while giving earlier weeks a plausible
// trajectory instead of a flat cost-basis line.
//
// The prediction segment compounds that same overall gain rate forward
// (constant weekly rate implied by the gain since inception) — "based on
// the gain" per the product ask, not a separate forecasting model.
export function computeValueHistory(positions, currentPriceByTicker = {}, { predictWeeks = 6, now = new Date() } = {}) {
  const trades = positions.filter(p => p.dataAcquisto);
  if (!trades.length) return { history: [], prediction: [] };

  const firstDate = trades.reduce((min, p) => p.dataAcquisto < min ? p.dataAcquisto : min, trades[0].dataAcquisto);
  const start = new Date(firstDate);
  const nowTime = now.getTime();
  if (isNaN(start.getTime()) || start.getTime() >= nowTime) return { history: [], prediction: [] };

  const totalWeeks = Math.max(1, Math.ceil((nowTime - start.getTime()) / WEEK_MS));

  const { holdings: currentHoldings } = computeHoldingsBreakdown(trades);
  const currentInvested = currentHoldings.reduce((s, h) => s + h.costoTotale, 0);
  const currentValue = currentHoldings.reduce((sum, h) => {
    const prezzo = currentPriceByTicker[h.ticker];
    return sum + (prezzo > 0 ? h.quantita * prezzo : h.costoTotale);
  }, 0);
  const overallRatio = currentInvested > 0 && currentValue > 0 ? currentValue / currentInvested : 1;

  const history = [];
  for (let w = 0; w <= totalWeeks; w++) {
    const bucketTime = Math.min(start.getTime() + w * WEEK_MS, nowTime);
    const bucketDate = new Date(bucketTime).toISOString().slice(0, 10);
    const tradesUpTo = trades.filter(p => p.dataAcquisto <= bucketDate);
    const { holdings } = computeHoldingsBreakdown(tradesUpTo);
    const invested = holdings.reduce((s, h) => s + h.costoTotale, 0);
    const f = w / totalWeeks;
    const ratio = 1 + f * (overallRatio - 1);
    const value = w === totalWeeks ? currentValue : invested * ratio;
    history.push({ date: bucketDate, invested, value });
    if (bucketTime >= nowTime) break;
  }

  const weeklyRate = currentInvested > 0 && currentValue > 0
    ? Math.pow(currentValue / currentInvested, 1 / totalWeeks) - 1
    : 0;
  const lastValue = history[history.length - 1]?.value ?? 0;
  const prediction = [];
  for (let k = 1; k <= predictWeeks; k++) {
    const date = new Date(nowTime + k * WEEK_MS).toISOString().slice(0, 10);
    prediction.push({ date, value: lastValue * Math.pow(1 + weeklyRate, k) });
  }

  return { history, prediction };
}
