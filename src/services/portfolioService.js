// ─── Portfolio domain logic (MOD-013 / MOD-018) ───
// computePortfolioValue (current value + invested) lives in lib/finance.js
// already. This module adds the per-ticker holdings breakdown (realized
// P&L, average cost, open vs. closed positions) that used to be
// recalculated inline inside PortfolioView.jsx — a second, drifting copy
// of the same average-cost accounting rules used by calcolaValorePortfolio.
// Pure: no React state, no API calls.

export { calcolaValorePortfolio as computePortfolioValue } from "../lib/finance.js";

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
    if (p.tipo === "sell") {
      const avg = h.quantita > 0.0001 ? h.costoTotale / h.quantita : 0;
      const sellQ = Math.min(p.quantita, h.quantita); // guard against overselling
      h.realizzato += sellQ * (p.prezzoAcquisto - avg);
      h.costoTotale -= sellQ * avg;
      h.quantita -= sellQ;
      if (h.quantita < 0.0001) { h.quantita = 0; h.costoTotale = 0; }
    } else {
      h.quantita += p.quantita;
      h.costoTotale += p.quantita * p.prezzoAcquisto;
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
