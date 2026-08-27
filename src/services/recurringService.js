// ─── Recurring-transaction domain logic (MOD-013) ───
// Pure: decides which templates are due and what their next occurrence
// looks like. No API calls, no React state — callers persist the result
// (create the occurrence, update the template) and merge it into UI state.

import { calcolaProssimaData } from "../features/transactions/helpers.js";

export function findDueRecurring(transazioni, oggi = new Date().toISOString().slice(0, 10)) {
  return transazioni.filter(t =>
    t.ricorrenza?.frequenza && t.ricorrenza?.prossimaData && t.ricorrenza.prossimaData <= oggi
  );
}

// Builds the new occurrence transaction and the template's advanced
// ricorrenza for one due template. The occurrence is a plain transaction —
// no ricorrenza field, so it never re-triggers itself.
export function buildRecurringOccurrence(template, generaId) {
  const { ricorrenza } = template;
  const newProssimaData = calcolaProssimaData(ricorrenza.prossimaData, ricorrenza.frequenza);
  const nuovaTx = { ...template, id: generaId(), data: ricorrenza.prossimaData };
  delete nuovaTx._id;
  delete nuovaTx.ricorrenza;
  if (ricorrenza.variabile) nuovaTx.daVerificare = true;
  const updatedRicorrenza = { frequenza: ricorrenza.frequenza, prossimaData: newProssimaData, variabile: ricorrenza.variabile };
  return { nuovaTx, updatedRicorrenza };
}

// ─── Recurring-manager helpers (Manage recurring transactions) ───

// All templates (transactions still carrying a live ricorrenza), soonest
// next-occurrence first — the order the manager list should render in.
export function listRecurringTemplates(transazioni) {
  return transazioni
    .filter(t => t.ricorrenza?.frequenza && t.ricorrenza?.prossimaData)
    .sort((a, b) => a.ricorrenza.prossimaData.localeCompare(b.ricorrenza.prossimaData));
}

// "Skip" a template's next occurrence: advances prossimaData by one
// frequency step WITHOUT creating a transaction for it — for months you
// paid it another way, or want to silently push it out. Returns just the
// updated ricorrenza the caller should persist (a partial update).
export function skipNextOccurrence(template) {
  const { ricorrenza } = template;
  return { ...ricorrenza, prossimaData: calcolaProssimaData(ricorrenza.prossimaData, ricorrenza.frequenza) };
}
