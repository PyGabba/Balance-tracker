// ─── Transaction-specific helpers (MOD-012) ───

// Reconstructs a split array for a transaction that predates the current
// splits format (older docs only stored splitPagante, a 2-person percent).
export function initialSplits(t, persone) {
  if (t.splits) return t.splits;
  if (t.splitPagante != null) {
    const payer = t.pagatoDa || persone[0]?.id;
    const otherId = persone.find(p => p.id !== payer)?.id || persone[1]?.id;
    return [
      { personaId: payer, quota: t.splitPagante },
      { personaId: otherId, quota: 100 - t.splitPagante },
    ];
  }
  if (t.pagatoDa) return [{ personaId: t.pagatoDa, quota: 100 }];
  return [];
}

export function calcolaProssimaData(data, frequenza) {
  const d = new Date(data + "T12:00:00");
  if (frequenza === "settimanale") d.setDate(d.getDate() + 7);
  else if (frequenza === "mensile") d.setMonth(d.getMonth() + 1);
  else if (frequenza === "trimestrale") d.setMonth(d.getMonth() + 3);
  else if (frequenza === "annuale") d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

// Fallback list shown before the live rates table loads (or if offline) — the
// real option list is the keys of GET /api/exchange-rates, ~160 currencies.
export const VALUTE_FALLBACK = ["EUR", "USD", "GBP", "CHF", "JPY", "CAD", "AUD", "CNY", "SEK", "NOK", "PLN"];
export const RICORRENZA_IDS = ["no", "settimanale", "mensile", "trimestrale", "annuale"];
