// Local, read-mostly cache of the last force-fetched live (Yahoo) prices —
// written by PortfolioView after a refresh, read by anything that needs to
// value a portfolio without triggering a network call of its own (e.g.
// HomeView's net-worth card, which must agree with Portfolio's own total).
// Scoped by householdId, same convention as offlineDb.js.
const KEY_PREFIX = "portfolioAutoPrices:";

export function readAutoPrices(householdId) {
  if (!householdId) return {};
  try {
    return JSON.parse(localStorage.getItem(`${KEY_PREFIX}${householdId}`) || "{}");
  } catch { return {}; }
}

export function writeAutoPrices(householdId, prices) {
  if (!householdId) return;
  try {
    localStorage.setItem(`${KEY_PREFIX}${householdId}`, JSON.stringify(prices));
  } catch {}
}
