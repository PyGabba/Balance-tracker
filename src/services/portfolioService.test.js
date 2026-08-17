import { describe, it, expect } from "vitest";
import { computeHoldingsBreakdown } from "./portfolioService.js";

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
});
