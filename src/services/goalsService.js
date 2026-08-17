// ─── Savings-goal domain logic (MOD-013) ───
// Pure: decides which goals auto-contribute from an incoming transaction
// and by how much. No API calls — callers persist each contribution via
// updateGoal and merge the result into UI state.

import { roundAmount, sumAmounts, fromMinorUnits, minorUnitsOf } from "../lib/money.js";

export function computeAutoContributions(goals, transazione) {
  if (transazione.tipo !== "entrata" || !goals?.length) return [];
  // MOD-016 contract phase: importoMinorUnits, when set, is the
  // authoritative amount — see minorUnitsOf in lib/money.js.
  const importo = fromMinorUnits(minorUnitsOf(transazione));
  const contributions = [];
  for (const g of goals) {
    if (!g.autoAdd || (g.contributionType !== "percent" && g.contributionType !== "fixed")) continue;
    const curr = fromMinorUnits(minorUnitsOf({ ...g, currentAmount: g.currentAmount || 0 }, "currentAmount"));
    const target = g.targetAmount > 0 ? fromMinorUnits(minorUnitsOf(g, "targetAmount")) : 0;
    if (target > 0 && curr >= target) continue; // goal reached: stop auto-saving
    let contribution = g.contributionType === "percent"
      ? importo * (g.contributionValue / 100)
      : g.contributionValue;
    contribution = roundAmount(contribution); // never overshoot the target
    if (target > 0) contribution = Math.min(contribution, target - curr);
    if (contribution <= 0) continue;
    contributions.push({
      goalId: g.id,
      contribution,
      newAmount: sumAmounts([curr, contribution]),
    });
  }
  return contributions;
}
