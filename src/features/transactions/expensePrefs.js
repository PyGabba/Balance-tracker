// ─── Expense-form memory + split summary (pure helpers) ───
// The add-expense form should open ready for the NEXT typical expense: the
// same person usually pays, split the same way. We remember the payer and the
// split of the last expense (per household, in localStorage — a convenience,
// not data) and describe a split in one line so it doesn't need a full editor
// open on every entry. Category is deliberately NOT remembered: a silently
// pre-selected wrong category is worse than an obvious default.

import { t } from "../../lib/i18n.js";
import { splitsTotalOk } from "../../lib/appHelpers.js";

const KEY = (householdId) => `finanza:lastExpense:${householdId}`;
const EPS = 0.05; // same tolerance as the form's split validation

// Drops anything that no longer fits the household (a removed persona, a
// split that doesn't sum to 100) so a stale memory can never produce an
// invalid expense. Returns { pagatoDa?, splits? } — missing keys mean "use
// the default".
export function sanitizeExpensePrefs(prefs, persone) {
  const ids = new Set(persone.map(p => p.id));
  const out = {};
  if (!prefs || typeof prefs !== "object") return out;
  if (ids.has(prefs.pagatoDa)) out.pagatoDa = prefs.pagatoDa;
  if (Array.isArray(prefs.splits) && prefs.splits.length > 0
    && prefs.splits.every(s => s && ids.has(s.personaId) && Number.isFinite(s.quota))
    && new Set(prefs.splits.map(s => s.personaId)).size === prefs.splits.length
    && splitsTotalOk(prefs.splits)) {
    out.splits = prefs.splits.map(s => ({ personaId: s.personaId, quota: s.quota }));
  }
  return out;
}

export function loadExpensePrefs(householdId, persone, storage = globalThis.localStorage) {
  if (!householdId) return {};
  try {
    return sanitizeExpensePrefs(JSON.parse(storage?.getItem(KEY(householdId)) || "null"), persone);
  } catch { return {}; }
}

// `splits` is stored only when it involves household members alone — an
// ad-hoc guest ("extraPersone") is specific to one expense.
export function saveExpensePrefs(householdId, { pagatoDa, splits, extraPersone }, persone, storage = globalThis.localStorage) {
  if (!householdId) return;
  const memberIds = new Set(persone.map(p => p.id));
  const prefs = { pagatoDa };
  if (!(extraPersone?.length) && splits?.every(s => memberIds.has(s.personaId))) prefs.splits = splits;
  try { storage?.setItem(KEY(householdId), JSON.stringify(prefs)); } catch { /* private mode / quota: remembering is optional */ }
}

// One-line description of a split: "everyone equally", "Anna pays all",
// "between Anna, Marco", or the percentages when they're uneven.
export function describeSplit(splits, allPersone, pagatoDa, lang = "it") {
  const active = (splits || []).filter(s => (s.quota || 0) > 0);
  if (active.length === 0) return "";
  const name = (id) => allPersone.find(p => p.id === id)?.nome || id;
  if (active.length === 1) {
    const id = active[0].personaId;
    return id === pagatoDa
      ? t(lang, "form.splitPayerAll").replace("{name}", name(id))
      : t(lang, "form.splitOnly").replace("{name}", name(id));
  }
  const equal = active.every(s => Math.abs(s.quota - active[0].quota) <= EPS);
  if (equal) {
    return active.length === allPersone.length
      ? t(lang, "form.splitAll")
      : t(lang, "form.splitBetween").replace("{names}", active.map(s => name(s.personaId)).join(", "));
  }
  return active.map(s => `${name(s.personaId)} ${Math.round(s.quota * 100) / 100}%`).join(" · ");
}
