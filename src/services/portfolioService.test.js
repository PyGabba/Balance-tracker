import { describe, it, expect } from "vitest";
import { computeHoldingsBreakdown, computeValueHistory } from "./portfolioService.js";

describe("computeHoldingsBreakdown", () => {
  it("aggregates buys into a single open holding with average cost", () => {
    const positions = [
      { ticker: "AAPL", tipo: "buy", quantita: 10, prezzoAcquisto: 100, dataAcquisto: "2026-01-01" },
      { ticker: "AAPL", tipo: "buy", quantita: 10, prezzoAcquisto: 200, dataAcquisto: "2026-02-01" },
    ];
    const { holdings, closedHoldings } = computeHoldingsBreakdown(positions);
    expect(holdings).toHaveLength(1);
    expect(holdings[0].quantita).toBe(20);
    expect(holdings[0].prezzoMedio).toBe(150);
    expect(closedHoldings).toEqual([]);
  });

  it("realizes P&L on a partial sell and keeps the position open", () => {
    const positions = [
      { ticker: "AAPL", tipo: "buy", quantita: 10, prezzoAcquisto: 100, dataAcquisto: "2026-01-01" },
      { ticker: "AAPL", tipo: "sell", quantita: 4, prezzoAcquisto: 150, dataAcquisto: "2026-02-01" },
    ];
    const { holdings } = computeHoldingsBreakdown(positions);
    expect(holdings[0].quantita).toBe(6);
    expect(holdings[0].realizzato).toBeCloseTo(200); // 4 * (150 - 100)
  });

  it("moves a fully sold position to closedHoldings", () => {
    const positions = [
      { ticker: "AAPL", tipo: "buy", quantita: 10, prezzoAcquisto: 100, dataAcquisto: "2026-01-01" },
      { ticker: "AAPL", tipo: "sell", quantita: 10, prezzoAcquisto: 150, dataAcquisto: "2026-02-01" },
    ];
    const { holdings, closedHoldings } = computeHoldingsBreakdown(positions);
    expect(holdings).toEqual([]);
    expect(closedHoldings).toHaveLength(1);
    expect(closedHoldings[0].realizzato).toBeCloseTo(500); // 10 * (150 - 100)
  });

  it("clamps overselling to the held quantity", () => {
    const positions = [
      { ticker: "AAPL", tipo: "buy", quantita: 5, prezzoAcquisto: 100, dataAcquisto: "2026-01-01" },
      { ticker: "AAPL", tipo: "sell", quantita: 999, prezzoAcquisto: 150, dataAcquisto: "2026-02-01" },
    ];
    const { holdings, closedHoldings } = computeHoldingsBreakdown(positions);
    expect(holdings).toEqual([]);
    expect(closedHoldings[0].realizzato).toBeCloseTo(250); // clamped to 5 * (150 - 100)
  });

  it("processes out-of-order trades chronologically by dataAcquisto", () => {
    const positions = [
      { ticker: "AAPL", tipo: "sell", quantita: 4, prezzoAcquisto: 150, dataAcquisto: "2026-02-01" },
      { ticker: "AAPL", tipo: "buy", quantita: 10, prezzoAcquisto: 100, dataAcquisto: "2026-01-01" },
    ];
    const { holdings } = computeHoldingsBreakdown(positions);
    expect(holdings[0].quantita).toBe(6);
    expect(holdings[0].realizzato).toBeCloseTo(200);
  });

  it("returns empty results for zero positions, not an error (MOD-018)", () => {
    expect(computeHoldingsBreakdown([])).toEqual({ holdings: [], closedHoldings: [], totalRealizzato: 0 });
  });

  it("never leaves quantity or cost basis negative after repeated overselling (MOD-018)", () => {
    const positions = [
      { ticker: "AAPL", tipo: "buy", quantita: 5, prezzoAcquisto: 100, dataAcquisto: "2026-01-01" },
      { ticker: "AAPL", tipo: "sell", quantita: 999, prezzoAcquisto: 150, dataAcquisto: "2026-02-01" },
      { ticker: "AAPL", tipo: "sell", quantita: 999, prezzoAcquisto: 160, dataAcquisto: "2026-03-01" },
    ];
    const { holdings, closedHoldings } = computeHoldingsBreakdown(positions);
    expect(holdings).toEqual([]);
    // Second oversell finds nothing left to sell — clamped to 0, not negative.
    expect(closedHoldings[0].quantita).toBe(0);
    expect(closedHoldings[0].realizzato).toBeCloseTo(250); // only the first sell realized anything (5 * (150-100))
  });

  it("average cost is unaffected by a partial sell (MOD-018)", () => {
    const positions = [
      { ticker: "AAPL", tipo: "buy", quantita: 10, prezzoAcquisto: 100, dataAcquisto: "2026-01-01" },
      { ticker: "AAPL", tipo: "sell", quantita: 4, prezzoAcquisto: 999, dataAcquisto: "2026-02-01" },
    ];
    const { holdings } = computeHoldingsBreakdown(positions);
    expect(holdings[0].prezzoMedio).toBe(100); // sell price never affects the remaining average cost
  });

  it("identical trade history in a different insertion order produces identical results (determinism, MOD-018)", () => {
    const trades = [
      { ticker: "AAPL", tipo: "buy", quantita: 10, prezzoAcquisto: 100, dataAcquisto: "2026-01-01" },
      { ticker: "AAPL", tipo: "buy", quantita: 5, prezzoAcquisto: 120, dataAcquisto: "2026-02-01" },
      { ticker: "AAPL", tipo: "sell", quantita: 8, prezzoAcquisto: 150, dataAcquisto: "2026-03-01" },
    ];
    const forward = computeHoldingsBreakdown(trades);
    const shuffled = computeHoldingsBreakdown([trades[2], trades[0], trades[1]]);
    expect(shuffled).toEqual(forward);
  });
});

describe("computeValueHistory", () => {
  const now = new Date("2026-03-01T00:00:00.000Z"); // 8 weeks after the trade below

  it("returns empty series with no positions", () => {
    expect(computeValueHistory([], {}, { now })).toEqual({ history: [], prediction: [] });
  });

  it("ends the history exactly at today's mark-to-market value", () => {
    const positions = [
      { ticker: "AAPL", tipo: "buy", quantita: 10, prezzoAcquisto: 100, dataAcquisto: "2026-01-01" },
    ];
    const { history } = computeValueHistory(positions, { AAPL: 150 }, { now });
    expect(history[history.length - 1].value).toBeCloseTo(1500);
    expect(history[history.length - 1].date).toBe("2026-03-01");
  });

  it("starts the history at the first trade date", () => {
    const positions = [
      { ticker: "AAPL", tipo: "buy", quantita: 10, prezzoAcquisto: 100, dataAcquisto: "2026-01-01" },
    ];
    const { history } = computeValueHistory(positions, { AAPL: 150 }, { now });
    expect(history[0].date).toBe("2026-01-01");
    expect(history[0].invested).toBeCloseTo(1000);
  });

  it("projects prediction points forward from the last history value using the observed gain rate", () => {
    const positions = [
      { ticker: "AAPL", tipo: "buy", quantita: 10, prezzoAcquisto: 100, dataAcquisto: "2026-01-01" },
    ];
    const { history, prediction } = computeValueHistory(positions, { AAPL: 150 }, { now, predictWeeks: 4 });
    expect(prediction).toHaveLength(4);
    const last = history[history.length - 1].value;
    // Portfolio gained value, so a growth-based projection keeps climbing.
    expect(prediction[0].value).toBeGreaterThan(last);
    expect(prediction[3].value).toBeGreaterThan(prediction[0].value);
  });

  it("does not project growth when there is no gain (flat price)", () => {
    const positions = [
      { ticker: "AAPL", tipo: "buy", quantita: 10, prezzoAcquisto: 100, dataAcquisto: "2026-01-01" },
    ];
    const { prediction } = computeValueHistory(positions, { AAPL: 100 }, { now, predictWeeks: 3 });
    prediction.forEach(p => expect(p.value).toBeCloseTo(1000));
  });
});
