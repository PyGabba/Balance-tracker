import { describe, it, expect } from "vitest";
import { weekKeyFor, localDateStr, buildSnapshot, needsSnapshot } from "./snapshotService.js";

// Local-time constructors (month is 0-based) so the tests don't depend on the machine's timezone.
const at = (y, m, d, h = 12) => new Date(y, m, d, h);

describe("weekKeyFor — weeks start on Sunday", () => {
  it("a Sunday is its own week key", () => {
    expect(weekKeyFor(at(2026, 9, 4))).toBe("2026-10-04"); // Sunday
  });
  it("Monday through Saturday map to the Sunday before", () => {
    for (const day of [5, 6, 7, 8, 9, 10]) expect(weekKeyFor(at(2026, 9, day))).toBe("2026-10-04");
  });
  it("the next Sunday starts a new week", () => {
    expect(weekKeyFor(at(2026, 9, 11))).toBe("2026-10-11");
  });
  it("crosses month and year boundaries", () => {
    expect(weekKeyFor(at(2026, 0, 1))).toBe("2025-12-28"); // Thursday 1 Jan 2026
    expect(weekKeyFor(at(2026, 2, 2))).toBe("2026-03-01"); // Monday 2 Mar → Sunday 1 Mar
  });
  it("uses the local calendar day even just after midnight", () => {
    expect(weekKeyFor(at(2026, 9, 5, 0))).toBe("2026-10-04"); // 00:00 Monday local
    expect(localDateStr(at(2026, 9, 5, 0))).toBe("2026-10-05");
  });
});

describe("buildSnapshot", () => {
  const positions = [
    { ticker: "VWCE", tipo: "buy", quantita: 10, prezzoAcquisto: 100, dataAcquisto: "2026-01-10" },
    { ticker: "AAPL", tipo: "buy", quantita: 5, prezzoAcquisto: 200, dataAcquisto: "2026-02-10" },
  ];
  const now = at(2026, 9, 7); // Wednesday

  it("records quantity × price for every holding, plus the totals", () => {
    const s = buildSnapshot({ positions, autoPrices: { VWCE: 120, AAPL: 210 }, now });
    expect(s).toEqual({
      weekKey: "2026-10-04", date: "2026-10-07",
      valore: 2250, investito: 2000,
      holdings: [{ ticker: "VWCE", quantita: 10, prezzo: 120 }, { ticker: "AAPL", quantita: 5, prezzo: 210 }],
    });
  });
  it("a manual price overrides the live one, like everywhere else in the app", () => {
    const s = buildSnapshot({ positions, manualPrices: { VWCE: 130 }, autoPrices: { VWCE: 120, AAPL: 210 }, now });
    expect(s.holdings[0].prezzo).toBe(130);
    expect(s.valore).toBe(10 * 130 + 5 * 210);
  });
  it("refuses to record when any holding has no real price (it would be valued at cost)", () => {
    expect(buildSnapshot({ positions, autoPrices: { VWCE: 120 }, now })).toBeNull();
    expect(buildSnapshot({ positions, autoPrices: {}, now })).toBeNull();
  });
  it("closed positions aren't holdings: they need no price and aren't recorded", () => {
    const withClosed = [...positions, { ticker: "OLD", tipo: "buy", quantita: 1, prezzoAcquisto: 50, dataAcquisto: "2026-01-01" }, { ticker: "OLD", tipo: "sell", quantita: 1, prezzoAcquisto: 60, dataAcquisto: "2026-03-01" }];
    const s = buildSnapshot({ positions: withClosed, autoPrices: { VWCE: 120, AAPL: 210 }, now });
    expect(s.holdings.map(h => h.ticker)).toEqual(["VWCE", "AAPL"]);
  });
  it("nothing held → nothing to record", () => {
    expect(buildSnapshot({ positions: [], autoPrices: {}, now })).toBeNull();
  });
  it("rounds the totals to cents", () => {
    const s = buildSnapshot({ positions: [{ ticker: "X", tipo: "buy", quantita: 3, prezzoAcquisto: 10, dataAcquisto: "2026-01-01" }], autoPrices: { X: 3.333333 }, now });
    expect(s.valore).toBe(10);
  });
});

describe("needsSnapshot — the first refresh of the week wins", () => {
  const snaps = [{ weekKey: "2026-09-27" }, { weekKey: "2026-10-04" }];
  it("false when this week already has one, true otherwise", () => {
    expect(needsSnapshot(snaps, "2026-10-04")).toBe(false);
    expect(needsSnapshot(snaps, "2026-10-11")).toBe(true);
    expect(needsSnapshot([], "2026-10-04")).toBe(true);
    expect(needsSnapshot(undefined, "2026-10-04")).toBe(true);
  });
});
