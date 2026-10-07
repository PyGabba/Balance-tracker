// ─── First-run checklist (pure) ───
// A brand-new household lands on an empty dashboard. This decides whether to
// show the "get started" card and which steps are already done, from the data
// itself — no flag to keep in sync, so it also behaves for households that
// were set up on another device.
//
// The card is for the FIRST run only: once there's an expense it's gone, and
// a household that already has expenses (an existing user after this ships)
// never sees it. Accounts and goals stay optional — they're offered, not
// required.

export const DEFAULT_ACCOUNTS = [
  { key: "bank", icona: "bank" },
  { key: "cash", icona: "cash" },
  { key: "card", icona: "card" },
];

export function onboardingSteps({ transazioni = [], conti = [], goals = [], dismissed = false } = {}) {
  const hasExpense = transazioni.some(t => t.tipo === "uscita" && !t.deletedAt);
  const steps = [
    { id: "expense", done: hasExpense, optional: false },
    { id: "accounts", done: conti.length > 0, optional: true },
    { id: "goal", done: goals.length > 0, optional: true },
  ];
  return { show: !dismissed && !hasExpense, steps };
}

const norm = (s) => String(s || "").trim().toLowerCase();

// A default-account chip counts as already added when an account with the
// same icon or the same (translated) name exists, so tapping it twice — or
// adding "Contanti" by hand first — never creates a duplicate.
export function missingDefaultAccounts(conti, names) {
  return DEFAULT_ACCOUNTS.filter(d => !conti.some(c => c.icona === d.icona || norm(c.nome) === norm(names[d.key])));
}

const KEY = (householdId) => `finanza:onboardingDismissed:${householdId}`;

export function isOnboardingDismissed(householdId, storage = globalThis.localStorage) {
  if (!householdId) return false;
  try { return storage?.getItem(KEY(householdId)) === "1"; } catch { return false; }
}

export function dismissOnboarding(householdId, storage = globalThis.localStorage) {
  if (!householdId) return;
  try { storage?.setItem(KEY(householdId), "1"); } catch { /* private mode: it just reappears next visit */ }
}
