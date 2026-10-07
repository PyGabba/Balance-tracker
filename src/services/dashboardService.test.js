import { describe, it, expect } from "vitest";
import { monthSpendComparison, upcomingBills, goalsOverview } from "./dashboardService.js";

const u = (importo, data, extra = {}) => ({ tipo: "uscita", importo, categoria: "cibo", data, ...extra });

describe("monthSpendComparison", () => {
  const oggi = new Date(2026, 9, 10); // 10 Oct 2026
  const oct = new Date(2026, 9, 1);

  it("current month compares like-for-like: this month so far vs last month through the same day", () => {
    const tx = [
      u(100, "2026-10-03"), u(50, "2026-10-09"),          // Oct so far: 150
      u(60, "2026-09-02"), u(40, "2026-09-10"),            // Sep through the 10th: 100
      u(900, "2026-09-25"),                                // later in Sep: must NOT count
    ];
    const r = monthSpendComparison(tx, oct, oggi);
    expect(r).toMatchObject({ spent: 150, prevSpent: 100, deltaPct: 50, samePeriod: true, prevMonth: 8 });
  });

  it("a past month compares full month vs full previous month", () => {
    const sep = new Date(2026, 8, 1);
    const tx = [u(200, "2026-09-05"), u(100, "2026-08-31"), u(100, "2026-08-01")];
    const r = monthSpendComparison(tx, sep, oggi);
    expect(r).toMatchObject({ spent: 200, prevSpent: 200, deltaPct: 0, samePeriod: false, prevMonth: 7 });
  });

  it("no previous spending → no percentage (not Infinity)", () => {
    expect(monthSpendComparison([u(80, "2026-10-02")], oct, oggi).deltaPct).toBeNull();
  });

  it("only expenses count; income, settlements and trashed rows don't", () => {
    const tx = [u(10, "2026-10-02"), { tipo: "entrata", importo: 999, data: "2026-10-02" }, { tipo: "saldo", importo: 50, data: "2026-10-02" }, u(70, "2026-10-02", { deletedAt: "x" })];
    expect(monthSpendComparison(tx, oct, oggi).spent).toBe(10);
  });

  it("sums in minor units (no float drift)", () => {
    expect(monthSpendComparison([u(0.1, "2026-10-01"), u(0.2, "2026-10-02")], oct, oggi).spent).toBe(0.3);
  });

  it("works across a year boundary", () => {
    const jan = new Date(2027, 0, 1);
    const r = monthSpendComparison([u(50, "2027-01-04"), u(100, "2026-12-04")], jan, new Date(2027, 0, 15));
    expect(r).toMatchObject({ spent: 50, prevSpent: 100, deltaPct: -50, prevMonth: 11 });
  });
});

describe("upcomingBills", () => {
  const tpl = (importo, prossimaData, extra = {}) => ({ id: `t${prossimaData}${importo}`, tipo: "uscita", importo, categoria: "casa", descrizione: "Bill", data: "2026-01-01", ricorrenza: { frequenza: "mensile", prossimaData }, ...extra });

  it("lists the next bills within the horizon, soonest first, with day counts", () => {
    const { bills, total } = upcomingBills([tpl(800, "2026-10-20"), tpl(10, "2026-10-12"), tpl(5, "2026-12-30")], "2026-10-10");
    expect(bills.map(b => [b.importo, b.days])).toEqual([[10, 2], [800, 10]]);
    expect(total).toBe(2);
  });

  it("an overdue template (job hasn't ticked yet) counts as due today", () => {
    const { bills } = upcomingBills([tpl(30, "2026-10-08")], "2026-10-10");
    expect(bills[0]).toMatchObject({ days: 0, data: "2026-10-10" });
  });

  it("limits the list but reports the full count", () => {
    const many = [1, 2, 3, 4, 5].map(i => tpl(i, `2026-10-${10 + i}`));
    const r = upcomingBills(many, "2026-10-10", { limit: 3 });
    expect(r.bills).toHaveLength(3);
    expect(r.total).toBe(5);
  });

  it("ignores income, trashed and non-recurring rows", () => {
    const tx = [tpl(1, "2026-10-12", { tipo: "entrata" }), tpl(2, "2026-10-12", { deletedAt: "x" }), u(3, "2026-10-12"), tpl(4, "2026-10-12")];
    expect(upcomingBills(tx, "2026-10-10").bills.map(b => b.importo)).toEqual([4]);
  });

  it("carries the variable-amount flag", () => {
    const { bills } = upcomingBills([tpl(60, "2026-10-12", { ricorrenza: { frequenza: "mensile", prossimaData: "2026-10-12", variabile: true } })], "2026-10-10");
    expect(bills[0].variabile).toBe(true);
  });
});

describe("goalsOverview", () => {
  it("combines progress, caps an overfunded goal, counts reached ones", () => {
    const goals = [{ targetAmount: 1000, currentAmount: 500 }, { targetAmount: 200, currentAmount: 250 }, { targetAmount: 800 }];
    expect(goalsOverview(goals)).toEqual({ count: 3, reached: 1, saved: 700, target: 2000, pct: 35 });
  });
  it("no goals / no targets → zeros", () => {
    expect(goalsOverview([])).toEqual({ count: 0, reached: 0, saved: 0, target: 0, pct: 0 });
    expect(goalsOverview(undefined).count).toBe(0);
    expect(goalsOverview([{ nome: "x" }]).count).toBe(0);
  });
});
