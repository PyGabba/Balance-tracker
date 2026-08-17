import { describe, it, expect } from "vitest";
import { computeAutoContributions } from "./goalsService.js";

describe("computeAutoContributions", () => {
  it("ignores non-entrata transactions", () => {
    const goals = [{ id: "g1", autoAdd: true, contributionType: "fixed", contributionValue: 10, currentAmount: 0, targetAmount: 100 }];
    expect(computeAutoContributions(goals, { tipo: "uscita", importo: 100 })).toEqual([]);
  });

  it("ignores goals without autoAdd", () => {
    const goals = [{ id: "g1", autoAdd: false, contributionType: "fixed", contributionValue: 10, currentAmount: 0, targetAmount: 100 }];
    expect(computeAutoContributions(goals, { tipo: "entrata", importo: 100 })).toEqual([]);
  });

  it("computes a fixed contribution", () => {
    const goals = [{ id: "g1", autoAdd: true, contributionType: "fixed", contributionValue: 15, currentAmount: 0, targetAmount: 100 }];
    expect(computeAutoContributions(goals, { tipo: "entrata", importo: 200 })).toEqual([
      { goalId: "g1", contribution: 15, newAmount: 15 },
    ]);
  });

  it("computes a percent contribution", () => {
    const goals = [{ id: "g1", autoAdd: true, contributionType: "percent", contributionValue: 10, currentAmount: 0, targetAmount: 1000 }];
    expect(computeAutoContributions(goals, { tipo: "entrata", importo: 200 })).toEqual([
      { goalId: "g1", contribution: 20, newAmount: 20 },
    ]);
  });

  it("never overshoots the target", () => {
    const goals = [{ id: "g1", autoAdd: true, contributionType: "fixed", contributionValue: 50, currentAmount: 90, targetAmount: 100 }];
    expect(computeAutoContributions(goals, { tipo: "entrata", importo: 200 })).toEqual([
      { goalId: "g1", contribution: 10, newAmount: 100 },
    ]);
  });

  it("stops contributing once the goal is already reached", () => {
    const goals = [{ id: "g1", autoAdd: true, contributionType: "fixed", contributionValue: 10, currentAmount: 100, targetAmount: 100 }];
    expect(computeAutoContributions(goals, { tipo: "entrata", importo: 200 })).toEqual([]);
  });

  it("handles multiple qualifying goals independently", () => {
    const goals = [
      { id: "g1", autoAdd: true, contributionType: "fixed", contributionValue: 10, currentAmount: 0, targetAmount: 100 },
      { id: "g2", autoAdd: true, contributionType: "percent", contributionValue: 5, currentAmount: 0, targetAmount: 1000 },
      { id: "g3", autoAdd: false, contributionType: "fixed", contributionValue: 10, currentAmount: 0, targetAmount: 100 },
    ];
    const result = computeAutoContributions(goals, { tipo: "entrata", importo: 100 });
    expect(result).toEqual([
      { goalId: "g1", contribution: 10, newAmount: 10 },
      { goalId: "g2", contribution: 5, newAmount: 5 },
    ]);
  });
});
