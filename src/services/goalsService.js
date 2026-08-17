// ─── Savings-goal domain logic (MOD-013) ───
// Pure: decides which goals auto-contribute from an incoming transaction
// and by how much. No API calls — callers persist each contribution via
// updateGoal and merge the result into UI state.

import { roundAmount, sumAmounts } from "../lib/money.js";

export function computeAutoContributions(goals, transazione) {
  if (transazione.tipo !== "entrata" || !goals?.length) return [];
  const contributions = [];
  for (const g of goals) {
    if (!g.autoAdd || (g.contributionType !== "percent" && g.contributionType !== "fixed")) continue;
    const curr = g.currentAmount || 0;
    if (g.targetAmount > 0 && curr >= g.targetAmount) continue; // goal reached: stop auto-saving
    let contribution = g.contributionType === "percent"
      ? transazione.importo * (g.contributionValue / 100)
      : g.contributionValue;
    contribution = roundAmount(contribution); // never overshoot the target
    if (g.targetAmount > 0) contribution = Math.min(contribution, g.targetAmount - curr);
    if (contribution <= 0) continue;
    contributions.push({
      goalId: g.id,
      contribution,
      newAmount: sumAmounts([curr, contribution]),
    });
  }
  return contributions;
}
