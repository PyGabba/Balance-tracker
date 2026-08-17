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
