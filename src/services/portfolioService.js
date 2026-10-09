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
const pad2 = (n) => String(n).padStart(2, "0");

// "YYYY-MM-DD" in the viewer's own calendar.
export function localDateStr(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const dayMs = (iso) => new Date(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)).getTime();

// Per-range display window + how far the projection reaches.
const RANGE_CONFIG = {
  week:  { windowDays: 7,        predictDays: 7,  stepDays: 1 },
  month: { windowDays: 30,       predictDays: 14, stepDays: 2 },
  max:   { windowDays: Infinity, predictDays: 42, stepDays: 7 },
};

// The portfolio chart's data. Three honest ingredients:
//
//  - invested: what you actually put in, as a step line rebuilt from the
//    trades themselves (exact — a purchase is a vertical step on its date)
//  - value: the REAL weekly snapshots (quantity × price, recorded the first
//    time prices are refreshed each week — see snapshotService.js) inside the
//    window, ending with today's live mark-to-market value. Nothing between
//    two snapshots is invented: the chart simply joins them, and with fewer
//    than two points it says so instead of faking a trajectory.
//  - prediction: a short projection of the portfolio's overall gain rate
//    (unchanged: "based on the gain", not a separate forecasting model)
//
// `snapshots`: [{ date, valore, investito }]. Returns
// { value, invested, prediction, domain } where every point is
// { date: "YYYY-MM-DD", value } (value points also carry `invested`, and the
// live one `live: true`); `domain` = { start, end } of the plotted window.
export function computeValueSeries(positions, snapshots = [], currentPriceByTicker = {}, { range = "max", now = new Date() } = {}) {
  const empty = { value: [], invested: [], prediction: [], domain: null };
  const trades = positions.filter(p => p.dataAcquisto);
  if (!trades.length) return empty;

  const today = localDateStr(now);
  const firstTrade = trades.reduce((min, p) => p.dataAcquisto < min ? p.dataAcquisto : min, trades[0].dataAcquisto);
  if (isNaN(dayMs(firstTrade)) || firstTrade > today) return empty;

  const cfg = RANGE_CONFIG[range] || RANGE_CONFIG.max;
  const start = Number.isFinite(cfg.windowDays)
    ? [firstTrade, localDateStr(addDays(now, -cfg.windowDays))].reduce((a, b) => (a > b ? a : b))
    : firstTrade;

  const investedAt = (date) => computeHoldingsBreakdown(trades.filter(p => p.dataAcquisto <= date))
    .holdings.reduce((sum, h) => sum + h.costoTotale, 0);

  // Invested as a step line: flat, a vertical jump on each trade date.
  const invested = [{ date: start, value: investedAt(start) }];
  for (const d of [...new Set(trades.map(p => p.dataAcquisto))].sort()) {
    if (d <= start || d > today) continue;
    invested.push({ date: d, value: invested[invested.length - 1].value });
    invested.push({ date: d, value: investedAt(d) });
  }
  const currentInvested = investedAt(today);
  invested.push({ date: today, value: currentInvested });

  const { holdings: currentHoldings } = computeHoldingsBreakdown(trades);
  const currentValue = currentHoldings.reduce((sum, h) => {
    const prezzo = currentPriceByTicker[h.ticker];
    return sum + (prezzo > 0 ? h.quantita * prezzo : h.costoTotale);
  }, 0);

  // Real snapshots inside the window (a snapshot taken today is superseded by
  // the live value), then today.
  const value = [...snapshots]
    .filter(s => s.date >= start && s.date < today && Number.isFinite(s.valore))
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(s => ({ date: s.date, value: s.valore, invested: s.investito }));
  value.push({ date: today, value: currentValue, invested: currentInvested, live: true });

  // Projection: the overall gain rate since the first trade, compounded.
  const totalDays = Math.max(1, (dayMs(today) - dayMs(firstTrade)) / DAY_MS);
  const dailyRate = currentInvested > 0 && currentValue > 0 ? Math.pow(currentValue / currentInvested, 1 / totalDays) - 1 : 0;
  const prediction = [];
  for (let k = 1; k <= Math.max(1, Math.ceil(cfg.predictDays / cfg.stepDays)); k++) {
    const days = k * cfg.stepDays;
    prediction.push({ date: localDateStr(addDays(now, days)), value: currentValue * Math.pow(1 + dailyRate, days) });
  }

  return { value, invested, prediction, domain: { start, end: today } };
}
