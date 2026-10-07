// ─── Dashboard summaries (pure) ───
// What the home screen answers at a glance: how much did we spend (and is
// that more or less than usual), what's coming up, how are the goals doing.
// No React, no I/O — HomeView renders what these return.

import { fromMinorUnits, minorUnitsOf } from "../lib/money.js";

const monthKey = (y, m) => `${y}-${String(m + 1).padStart(2, "0")}`;
const dayOf = (data) => Number(String(data).slice(8, 10));

// Spending in the viewed month vs the month before it.
// For the CURRENT month the comparison is like-for-like — spend through
// today's day-of-month against the previous month through the same day —
// otherwise "you've spent 40% less than last month" is just "the month isn't
// over yet". For a past month it's full month vs full month.
// deltaPct is null when there's nothing to compare against (previous period
// had no spending).
export function monthSpendComparison(transazioni, meseVis, oggi = new Date(), valutaBase = "EUR") {
  const key = monthKey(meseVis.getFullYear(), meseVis.getMonth());
  const prevDate = new Date(meseVis.getFullYear(), meseVis.getMonth() - 1, 1);
  const prevKey = monthKey(prevDate.getFullYear(), prevDate.getMonth());
  const isCurrent = key === monthKey(oggi.getFullYear(), oggi.getMonth());
  const throughDay = isCurrent ? oggi.getDate() : null;

  let spentMinor = 0, prevMinor = 0;
  for (const t of transazioni) {
    if (t.tipo !== "uscita" || !t.data || t.deletedAt) continue;
    const k = t.data.slice(0, 7);
    if (k !== key && k !== prevKey) continue;
    const m = minorUnitsOf(t, "importo", valutaBase);
    if (k === key) spentMinor += m;
    else if (throughDay === null || dayOf(t.data) <= throughDay) prevMinor += m;
  }
  const spent = fromMinorUnits(spentMinor, valutaBase);
  const prevSpent = fromMinorUnits(prevMinor, valutaBase);
  return {
    spent,
    prevSpent,
    prevMonth: prevDate.getMonth(),
    samePeriod: isCurrent,
    deltaPct: prevMinor > 0 ? Math.round(((spentMinor - prevMinor) / prevMinor) * 100) : null,
  };
}

const utcDay = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));

// The next occurrence of each active recurring expense that falls within the
// next `horizonDays`, soonest first. A template whose date is already past
// (the server's recurring job hasn't ticked yet) counts as due today.
export function upcomingBills(transazioni, oggiIso, { horizonDays = 30, limit = 3, valutaBase = "EUR" } = {}) {
  const today = utcDay(oggiIso);
  const bills = [];
  for (const t of transazioni) {
    if (t.tipo !== "uscita" || t.deletedAt || !t.ricorrenza?.frequenza || !t.ricorrenza?.prossimaData) continue;
    const days = Math.max(0, Math.round((utcDay(t.ricorrenza.prossimaData) - today) / 86400000));
    if (days > horizonDays) continue;
    bills.push({
      id: t.id,
      descrizione: t.descrizione || "",
      categoria: t.categoria,
      data: days === 0 && t.ricorrenza.prossimaData < oggiIso ? oggiIso : t.ricorrenza.prossimaData,
      days,
      importo: fromMinorUnits(minorUnitsOf(t, "importo", valutaBase), valutaBase),
      variabile: !!t.ricorrenza.variabile,
    });
  }
  bills.sort((a, b) => a.days - b.days || a.data.localeCompare(b.data));
  return { bills: bills.slice(0, limit), total: bills.length };
}

// Overall savings-goal progress. Goals have no deadline, so "on track" here
// means how much of the combined target is saved.
export function goalsOverview(goals) {
  const list = (goals || []).filter(g => g.targetAmount > 0);
  let savedMinor = 0, targetMinor = 0, reached = 0;
  for (const g of list) {
    const target = minorUnitsOf(g, "targetAmount");
    const saved = Math.min(minorUnitsOf({ ...g, currentAmount: g.currentAmount || 0 }, "currentAmount"), target);
    savedMinor += saved;
    targetMinor += target;
    if (saved >= target) reached++;
  }
  return {
    count: list.length,
    reached,
    saved: fromMinorUnits(savedMinor),
    target: fromMinorUnits(targetMinor),
    pct: targetMinor > 0 ? Math.round((savedMinor / targetMinor) * 100) : 0,
  };
}
