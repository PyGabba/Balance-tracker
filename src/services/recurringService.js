// ─── Recurring-transaction domain logic (MOD-013) ───
// Pure: decides which templates are due and what their next occurrence
// looks like. No API calls, no React state — callers persist the result
// (create the occurrence, update the template) and merge it into UI state.
//
// NOTE: findDueRecurring/buildRecurringOccurrence are no longer what
// actually generates occurrences in the app — that used to run client-side
// in App.jsx, but had no protection against two devices (or one device
// reloading twice) both generating the same occurrence, which is how
// duplicate transactions like "Affitto" appearing 3-4 times happened.
// Generation now always goes through the server's dedup-protected job
// (server/index.js: generaRicorrentiDovute, unique index on
// recurrenceOccurrenceKey) via POST /api/recurring/run. These two
// functions are kept because they're still accurate, still tested, and
// mirror the server's own logic — useful for previewing "what would the
// next occurrence look like" without a round-trip — but nothing in the app
// currently calls them to actually create a transaction.

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
