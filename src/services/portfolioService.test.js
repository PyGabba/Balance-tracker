import { describe, it, expect } from "vitest";
import { computeHoldingsBreakdown, computeValueSeries } from "./portfolioService.js";

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

describe("computeValueSeries", () => {
  const now = new Date(2026, 2, 1, 12); // 1 Mar 2026, local
  const buy = (date, q = 10, price = 100, ticker = "AAPL") => ({ ticker, tipo: "buy", quantita: q, prezzoAcquisto: price, dataAcquisto: date });
  const snap = (date, valore, investito) => ({ date, valore, investito });

  it("returns empty series with no positions, or a first trade in the future", () => {
    expect(computeValueSeries([], [], {}, { now })).toEqual({ value: [], invested: [], prediction: [], domain: null });
    expect(computeValueSeries([buy("2026-04-01")], [], {}, { now }).value).toEqual([]);
  });

  it("value line = the real snapshots in the window + today's live value (nothing in between is invented)", () => {
    const { value } = computeValueSeries([buy("2026-01-01")], [snap("2026-01-18", 1100, 1000), snap("2026-02-01", 1250, 1000), snap("2026-02-15", 1300, 1000)], { AAPL: 150 }, { now });
    expect(value.map(p => [p.date, p.value])).toEqual([["2026-01-18", 1100], ["2026-02-01", 1250], ["2026-02-15", 1300], ["2026-03-01", 1500]]);
    expect(value.at(-1)).toMatchObject({ live: true, invested: 1000 });
    expect(value[0].invested).toBe(1000);
  });

  it("with no snapshots yet the value line is just today's point — no fabricated trajectory", () => {
    const { value } = computeValueSeries([buy("2026-01-01")], [], { AAPL: 150 }, { now });
    expect(value).toHaveLength(1);
    expect(value[0]).toMatchObject({ date: "2026-03-01", value: 1500, live: true });
  });

  it("a snapshot taken today is replaced by the live value (the latest price wins)", () => {
    const { value } = computeValueSeries([buy("2026-01-01")], [snap("2026-03-01", 1400, 1000)], { AAPL: 150 }, { now });
    expect(value).toHaveLength(1);
    expect(value[0].value).toBe(1500);
  });

  it("invested is an exact step line: flat, then a vertical jump on the trade date", () => {
    const positions = [buy("2026-01-01"), buy("2026-02-01", 5, 100)]; // 1000 then +500
    const { invested } = computeValueSeries(positions, [], { AAPL: 150 }, { now });
    expect(invested).toEqual([
      { date: "2026-01-01", value: 1000 },
      { date: "2026-02-01", value: 1000 }, { date: "2026-02-01", value: 1500 },
      { date: "2026-03-01", value: 1500 },
    ]);
  });

  it("a sale steps the invested line down by the cost removed", () => {
    const positions = [buy("2026-01-01"), { ticker: "AAPL", tipo: "sell", quantita: 4, prezzoAcquisto: 120, dataAcquisto: "2026-02-01" }];
    const { invested } = computeValueSeries(positions, [], { AAPL: 150 }, { now });
    expect(invested.at(-1).value).toBeCloseTo(600);
    expect(invested.some(p => p.date === "2026-02-01" && p.value === 1000)).toBe(true);
  });

  it("'max' starts at the first trade; 'week' and 'month' clamp to 7 / 30 days", () => {
    const positions = [buy("2026-01-01")];
    expect(computeValueSeries(positions, [], {}, { now, range: "max" }).domain).toEqual({ start: "2026-01-01", end: "2026-03-01" });
    expect(computeValueSeries(positions, [], {}, { now, range: "week" }).domain.start).toBe("2026-02-22");
    expect(computeValueSeries(positions, [], {}, { now, range: "month" }).domain.start).toBe("2026-01-30");
  });

  it("a position newer than the window starts the window at its first trade", () => {
    expect(computeValueSeries([buy("2026-02-28")], [], {}, { now, range: "week" }).domain.start).toBe("2026-02-28");
  });

  it("snapshots outside the window are left out of that range", () => {
    const snaps = [snap("2026-01-18", 1100, 1000), snap("2026-02-25", 1450, 1000)];
    const week = computeValueSeries([buy("2026-01-01")], snaps, { AAPL: 150 }, { now, range: "week" }).value;
    expect(week.map(p => p.date)).toEqual(["2026-02-25", "2026-03-01"]);
  });

  it("prices missing for a holding fall back to cost (same rule as the totals)", () => {
    expect(computeValueSeries([buy("2026-01-01")], [], {}, { now }).value[0].value).toBe(1000);
  });

  it("projects forward from today's live value using the overall gain rate", () => {
    const { value, prediction } = computeValueSeries([buy("2026-01-01")], [], { AAPL: 150 }, { now, range: "max" });
    expect(prediction[0].value).toBeGreaterThan(value.at(-1).value);
    expect(prediction.at(-1).value).toBeGreaterThan(prediction[0].value);
    expect(prediction[0].date > "2026-03-01").toBe(true);
  });

  it("a flat portfolio projects flat; one under water projects down", () => {
    expect(computeValueSeries([buy("2026-01-01")], [], { AAPL: 100 }, { now }).prediction.at(-1).value).toBeCloseTo(1000);
    expect(computeValueSeries([buy("2026-01-01")], [], { AAPL: 80 }, { now }).prediction.at(-1).value).toBeLessThan(800);
  });
});
