import { describe, it, expect } from "vitest";
import { onboardingSteps, missingDefaultAccounts, isOnboardingDismissed, dismissOnboarding } from "./onboardingService.js";

const memory = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; };
const names = { bank: "Banca", cash: "Contanti", card: "Carta" };

describe("onboardingSteps", () => {
  it("brand-new household: shown, nothing done", () => {
    const r = onboardingSteps({});
    expect(r.show).toBe(true);
    expect(r.steps.map(s => [s.id, s.done])).toEqual([["expense", false], ["accounts", false], ["goal", false]]);
  });
  it("marks accounts / goals done from the data", () => {
    const r = onboardingSteps({ conti: [{ id: "a" }], goals: [{ id: "g" }] });
    expect(r.steps.filter(s => s.done).map(s => s.id)).toEqual(["accounts", "goal"]);
    expect(r.show).toBe(true); // still no expense
  });
  it("the first expense ends the first run, whatever else is missing", () => {
    const r = onboardingSteps({ transazioni: [{ tipo: "uscita", importo: 5 }] });
    expect(r.show).toBe(false);
    expect(r.steps[0].done).toBe(true);
  });
  it("income, settlements and trashed expenses don't count as the first expense", () => {
    const tx = [{ tipo: "entrata", importo: 100 }, { tipo: "saldo", importo: 5 }, { tipo: "uscita", importo: 9, deletedAt: "x" }];
    expect(onboardingSteps({ transazioni: tx }).show).toBe(true);
  });
  it("dismissed → hidden", () => {
    expect(onboardingSteps({ dismissed: true }).show).toBe(false);
  });
  it("accounts and goals are optional, the expense isn't", () => {
    expect(onboardingSteps({}).steps.map(s => s.optional)).toEqual([false, true, true]);
  });
});

describe("missingDefaultAccounts", () => {
  it("offers all three on a household with no accounts", () => {
    expect(missingDefaultAccounts([], names).map(d => d.key)).toEqual(["bank", "cash", "card"]);
  });
  it("skips ones that exist by icon or by name (case/space-insensitive)", () => {
    const conti = [{ nome: "Intesa", icona: "bank" }, { nome: "  contanti ", icona: "wallet" }];
    expect(missingDefaultAccounts(conti, names).map(d => d.key)).toEqual(["card"]);
  });
});

describe("dismissal memory", () => {
  it("is per household and survives a broken storage", () => {
    const st = memory();
    expect(isOnboardingDismissed("h1", st)).toBe(false);
    dismissOnboarding("h1", st);
    expect(isOnboardingDismissed("h1", st)).toBe(true);
    expect(isOnboardingDismissed("h2", st)).toBe(false);
    expect(isOnboardingDismissed("h1", { getItem() { throw new Error("denied"); } })).toBe(false);
    expect(isOnboardingDismissed(null, st)).toBe(false);
  });
});
