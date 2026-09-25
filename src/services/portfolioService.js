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

// Per-range display window/granularity + how far the projection reaches.
const RANGE_CONFIG = {
  week:  { windowDays: 7,        stepDays: 1, predictDays: 7 },
  month: { windowDays: 30,       stepDays: 2, predictDays: 14 },
  max:   { windowDays: Infinity, stepDays: 7, predictDays: 42 },
};

// Portfolio value series for a given range ("week" | "month" | "max") + a
// short forward projection.
//
// No historical price feed exists (fetchQuotes only returns *current*
// quotes), so past values are an estimate: at each bucket date we take the
// real cost basis held as of that date (from computeHoldingsBreakdown on
// the trades up to that date) and scale it by the portfolio's overall gain
// ratio (currentValue / currentCost), interpolated linearly by elapsed time
// from 1.0 at the first trade to the real ratio today — the gain-rate
// anchor always spans the *whole* trade history, independent of the
// display window, so switching range never changes what "today's value"
// or the projection mean. This reproduces the exact current total exactly
// at the last point while giving earlier buckets a plausible trajectory
// instead of a flat cost-basis line.
//
// The prediction segment compounds that same overall daily gain rate
// forward — "based on the gain" per the product ask, not a separate
// forecasting model.
export function computeValueHistory(positions, currentPriceByTicker = {}, { range = "max", now = new Date() } = {}) {
  const trades = positions.filter(p => p.dataAcquisto);
  if (!trades.length) return { history: [], prediction: [] };

  const firstDate = trades.reduce((min, p) => p.dataAcquisto < min ? p.dataAcquisto : min, trades[0].dataAcquisto);
  const firstTradeTime = new Date(firstDate).getTime();
  const nowTime = now.getTime();
  if (isNaN(firstTradeTime) || firstTradeTime >= nowTime) return { history: [], prediction: [] };

  const cfg = RANGE_CONFIG[range] || RANGE_CONFIG.max;
  const windowStart = Number.isFinite(cfg.windowDays)
    ? Math.max(firstTradeTime, nowTime - cfg.windowDays * DAY_MS)
    : firstTradeTime;
  const stepMs = cfg.stepDays * DAY_MS;
  const totalSpanMs = nowTime - firstTradeTime; // gain-rate anchor: full history, not just the display window

  const { holdings: currentHoldings } = computeHoldingsBreakdown(trades);
  const currentInvested = currentHoldings.reduce((s, h) => s + h.costoTotale, 0);
  const currentValue = currentHoldings.reduce((sum, h) => {
    const prezzo = currentPriceByTicker[h.ticker];
    return sum + (prezzo > 0 ? h.quantita * prezzo : h.costoTotale);
  }, 0);
  const overallRatio = currentInvested > 0 && currentValue > 0 ? currentValue / currentInvested : 1;

  const history = [];
  for (let t = windowStart; ; t += stepMs) {
    const bucketTime = Math.min(t, nowTime);
    const bucketDate = new Date(bucketTime).toISOString().slice(0, 10);
    const tradesUpTo = trades.filter(p => p.dataAcquisto <= bucketDate);
    const { holdings } = computeHoldingsBreakdown(tradesUpTo);
    const invested = holdings.reduce((s, h) => s + h.costoTotale, 0);
    const f = totalSpanMs > 0 ? Math.min(1, Math.max(0, (bucketTime - firstTradeTime) / totalSpanMs)) : 1;
    const ratio = 1 + f * (overallRatio - 1);
    const value = bucketTime >= nowTime ? currentValue : invested * ratio;
    history.push({ date: bucketDate, invested, value });
    if (bucketTime >= nowTime) break;
  }

  const totalDays = Math.max(1, totalSpanMs / DAY_MS);
  const dailyRate = currentInvested > 0 && currentValue > 0
    ? Math.pow(currentValue / currentInvested, 1 / totalDays) - 1
    : 0;
  const lastValue = history[history.length - 1]?.value ?? 0;
  const predictSteps = Math.max(1, Math.ceil(cfg.predictDays / cfg.stepDays));
  const prediction = [];
  for (let k = 1; k <= predictSteps; k++) {
    const days = k * cfg.stepDays;
    const date = new Date(nowTime + days * DAY_MS).toISOString().slice(0, 10);
    prediction.push({ date, value: lastValue * Math.pow(1 + dailyRate, days) });
  }

  return { history, prediction };
}
