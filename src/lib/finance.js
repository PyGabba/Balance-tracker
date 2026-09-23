// ─── Algoritmi finanziari puri ───
// Estratti da App.jsx per essere testabili in isolamento (vedi finance.test.js).
// Nessuna dipendenza da React o dallo stato dell'app: solo input → output.

import { fromMinorUnits, minorUnitsOf } from "./money.js";

// ─── Quota personale ("le tue statistiche") ───
// Quanto di una transazione appartiene a una specifica persona, per le
// statistiche personali filtrate sulla persona con cui si è loggati
// (persona-login). Un'uscita SENZA splits è interamente di chi ha
// pagato — nessun altro ne è responsabile, stessa convenzione del
// vecchio formato splitPagante in calcolaDebitiMatrix; CON splits, conta
// solo la propria quota%, indipendentemente da chi ha pagato fisicamente
// (l'anticipo viene comunque saldato tramite i debiti). Un'entrata
// appartiene interamente a chi è intestata — non è mai divisa. saldo e
// trasferimento non sono mai "personali": sono movimenti tra
// conti/persone, non reddito o spesa proprio.
export function quotaPersonale(t, personaId, valutaBase = "EUR") {
  if (t.tipo === "uscita") {
    if (Array.isArray(t.splits) && t.splits.length > 0) {
      const mine = t.splits.find(s => s.personaId === personaId);
      if (!mine) return 0;
      const totalQ = t.splits.reduce((s, sp) => s + (sp.quota || 0), 0);
      if (totalQ <= 0) return 0;
      const importoMinor = minorUnitsOf(t, "importo", valutaBase);
      return fromMinorUnits(Math.round(importoMinor * (mine.quota / totalQ)), valutaBase);
    }
    return t.pagatoDa === personaId ? t.importo : 0;
  }
  if (t.tipo === "entrata") {
    return t.intestataA === personaId ? t.importo : 0;
  }
  return 0;
}

// Matrice debiti della casa: da transazioni (uscite con split + saldi) a lista
// di debiti minimizzata con matching greedy creditori/debitori.
// Bilanci accumulati in unità minori intere (MOD-016), non float grezzi —
// una casa con molte transazioni è esattamente il caso in cui l'errore in
// virgola mobile si accumulerebbe prima dell'arrotondamento finale.
export function calcolaDebitiMatrix(transazioni, persone, valutaBase = "EUR") {
  const balancesMinor = {};
  for (const t of transazioni) {
    const importoMinor = minorUnitsOf(t, "importo", valutaBase);
    if (t.tipo === "saldo") {
      if (!t.pagatoDa || !t.ricevutoDa) continue;
      // Trip settlements are record-only: the underlying trip expenses never
      // entered the household ledger, so counting them here would create a
      // spurious opposite debt in the household matrix
      if (t.categoria === "saldo_viaggio") continue;
      // Payment reduces debt: add in reverse direction so netting cancels it out
      const key = `${t.ricevutoDa}->${t.pagatoDa}`;
      balancesMinor[key] = (balancesMinor[key] || 0) + importoMinor;
      continue;
    }
    if (t.tipo !== "uscita" || !t.pagatoDa) continue;
    const payer = t.pagatoDa;
    let shares = [];

    if (t.splits && Array.isArray(t.splits) && t.splits.length > 0) {
      shares = t.splits;
    } else if (t.splitPagante != null) {
      // Old format backward compat
      const other = persone.find(p => p.id !== payer);
      if (other) shares = [{ personaId: payer, quota: t.splitPagante }, { personaId: other.id, quota: 100 - t.splitPagante }];
    }
    if (!shares.length) continue;
    const totalQ = shares.reduce((s, sh) => s + (sh.quota || 0), 0);
    if (totalQ === 0) continue;
    for (const sh of shares) {
      if (sh.personaId === payer) continue;
      const owedMinor = Math.round(importoMinor * (sh.quota / totalQ));
      const key = `${sh.personaId}->${payer}`;
      balancesMinor[key] = (balancesMinor[key] || 0) + owedMinor;
    }
  }
  // Convert directional pair balances → per-person net balance
  const netPerPersonMinor = {};
  for (const [key, amountMinor] of Object.entries(balancesMinor)) {
    const [da, a] = key.split("->");
    netPerPersonMinor[da] = (netPerPersonMinor[da] || 0) - amountMinor; // owes → negative
    netPerPersonMinor[a]  = (netPerPersonMinor[a]  || 0) + amountMinor; // owed → positive
  }

  // Greedy creditor/debtor matching — minimises number of transactions
  const creditors = [], debtors = [];
  for (const [id, balMinor] of Object.entries(netPerPersonMinor)) {
    if (balMinor >  1) creditors.push({ id, balMinor });
    if (balMinor < -1) debtors.push({ id, balMinor: -balMinor });
  }
  creditors.sort((a, b) => b.balMinor - a.balMinor);
  debtors.sort((a, b) => b.balMinor - a.balMinor);

  const debiti = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const payMinor = Math.min(debtors[i].balMinor, creditors[j].balMinor);
    debiti.push({ da: debtors[i].id, a: creditors[j].id, importo: fromMinorUnits(payMinor, valutaBase) });
    debtors[i].balMinor   -= payMinor;
    creditors[j].balMinor -= payMinor;
    if (debtors[i].balMinor   < 1) i++;
    if (creditors[j].balMinor < 1) j++;
  }
  return debiti;
}

// Saldi dei conti: saldo iniziale + entrate − uscite assegnate + giroconti.
// Accumulato in unità minori intere (MOD-016) per lo stesso motivo di sopra.
// Conti e transazioni sono sempre nella valuta base della casa (nessun campo
// valuta proprio), quindi valutaBase governa la precisione di entrambi.
export function calcolaSaldiConti(conti, transazioni, valutaBase = "EUR") {
  const saldiMinor = {};
  // saldoIniziale is optional (defaults to 0) — minorUnitsOf doesn't
  // itself default a missing decimal field, so that has to happen first.
  for (const c of conti) saldiMinor[c.id] = minorUnitsOf({ ...c, saldoIniziale: c.saldoIniziale || 0 }, "saldoIniziale", valutaBase);
  for (const t of transazioni) {
    const importoMinor = minorUnitsOf(t, "importo", valutaBase);
    if (t.tipo === "trasferimento") {
      if (t.contoDa && saldiMinor[t.contoDa] !== undefined) saldiMinor[t.contoDa] -= importoMinor;
      if (t.contoA && saldiMinor[t.contoA] !== undefined) saldiMinor[t.contoA] += importoMinor;
      continue;
    }
    if (!t.contoId || saldiMinor[t.contoId] === undefined) continue;
    if (t.tipo === "entrata") saldiMinor[t.contoId] += importoMinor;
    else if (t.tipo === "uscita") saldiMinor[t.contoId] -= importoMinor;
  }
  const saldi = {};
  for (const id of Object.keys(saldiMinor)) saldi[id] = fromMinorUnits(saldiMinor[id], valutaBase);
  return saldi;
}

// Valore del portafoglio con contabilità a costo medio (le vendite riducono il
// costo di qty × prezzo medio); prezzo manuale, poi prezzo live (auto), altrimenti
// costo di carico — stessa priorità di prezzoDi() in PortfolioView.jsx, così
// "investimenti" in Home e "Valore portafoglio" in Portfolio non divergono.
export function calcolaValorePortfolio(positions, manualPrices, autoPrices) {
  const map = {};
  const sorted = [...positions].sort((a, b) =>
    (a.dataAcquisto || "").localeCompare(b.dataAcquisto || "") ||
    (a.createdAt || "").localeCompare(b.createdAt || "")
  );
  for (const p of sorted) {
    if (!map[p.ticker]) map[p.ticker] = { quantita: 0, costoTotale: 0 };
    const h = map[p.ticker];
    // Price read through minorUnitsOf (MOD-016 contract phase) so a trade
    // with a stored prezzoAcquistoMinorUnits companion uses that as the
    // authoritative value rather than reconverting the decimal every time;
    // converted back to decimal since quantita is inherently fractional
    // and cost-per-share isn't itself a whole-cent quantity.
    const prezzo = fromMinorUnits(minorUnitsOf(p, "prezzoAcquisto", p.valuta || "EUR"), p.valuta || "EUR");
    if (p.tipo === "sell") {
      const avg = h.quantita > 0.0001 ? h.costoTotale / h.quantita : 0;
      const q = Math.min(p.quantita, h.quantita);
      h.costoTotale -= q * avg; h.quantita -= q;
      if (h.quantita < 0.0001) { h.quantita = 0; h.costoTotale = 0; }
    } else { h.quantita += p.quantita; h.costoTotale += p.quantita * prezzo; }
  }
  let valore = 0, investito = 0;
  for (const k of Object.keys(map)) {
    const h = map[k];
    if (h.quantita <= 0.0001) continue;
    const prezzo = (manualPrices && manualPrices[k]) || (autoPrices && autoPrices[k]) || 0;
    investito += h.costoTotale;
    valore += prezzo > 0 ? h.quantita * prezzo : h.costoTotale;
  }
  return { valore, investito };
}

// Pareggio spese di un viaggio: bilanci per partecipante dalle quote, poi
// matching greedy per minimizzare il numero di pagamenti.
// Ricerca e filtri avanzati sulle transazioni.
// filtri: { query, tipo, categoria, personaId, contoId, minImporto, maxImporto }
// - query: match case/accent-insensitive su descrizione + nome categoria (AND fra parole)
// - personaId: match su pagatoDa, intestataA, ricevutoDa o partecipazione negli splits
// - contoId: match su contoId oppure contoDa/contoA (giroconti)
function normalizza(s) {
  return (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function parseImporto(v) {
  if (v == null || v === "") return null;
  const n = parseFloat(String(v).replace(",", "."));
  return Number.isNaN(n) ? null : n;
}

export function filtraTransazioni(transazioni, filtri = {}, categorie = []) {
  const parole = normalizza(filtri.query || "").trim().split(/\s+/).filter(Boolean);
  const min = parseImporto(filtri.minImporto);
  const max = parseImporto(filtri.maxImporto);

  return transazioni.filter(t => {
    if (filtri.tipo && t.tipo !== filtri.tipo) return false;
    if (filtri.categoria && t.categoria !== filtri.categoria) return false;
    if (filtri.contoId && t.contoId !== filtri.contoId && t.contoDa !== filtri.contoId && t.contoA !== filtri.contoId) return false;
    if (filtri.personaId) {
      const pid = filtri.personaId;
      const inSplits = Array.isArray(t.splits) && t.splits.some(s => s.personaId === pid && (s.quota || 0) > 0);
      if (t.pagatoDa !== pid && t.intestataA !== pid && t.ricevutoDa !== pid && !inSplits) return false;
    }
    if (min != null && t.importo < min) return false;
    if (max != null && t.importo > max) return false;
    if (filtri.dataInizio && t.data < filtri.dataInizio) return false;
    if (filtri.dataFine && t.data > filtri.dataFine) return false;
    if (parole.length > 0) {
      const cat = categorie.find(c => c.id === t.categoria);
      const testo = normalizza(`${t.descrizione || ""} ${cat?.nome || ""} ${t.categoria || ""}`);
      if (!parole.every(p => testo.includes(p))) return false;
    }
    return true;
  });
}

export function contaFiltriAttivi(filtri = {}) {
  let n = 0;
  if (filtri.tipo) n++;
  if (filtri.categoria) n++;
  if (filtri.personaId) n++;
  if (filtri.contoId) n++;
  if (parseImporto(filtri.minImporto) != null) n++;
  if (parseImporto(filtri.maxImporto) != null) n++;
  if (filtri.dataInizio) n++;
  if (filtri.dataFine) n++;
  return n;
}

export function calcolaSettleViaggio(trip, valutaBase = "EUR") {
  const balancesMinor = {};
  for (const e of trip.expenses) {
    if (e.splits && e.splits.length > 0) {
      const totalQ = e.splits.reduce((s, sc) => s + sc.quota, 0);
      const importoMinor = minorUnitsOf(e, "importo", valutaBase);
      for (const s of e.splits) {
        if (s.personaId !== e.pagatoDa) {
          const owedMinor = Math.round(importoMinor * (s.quota / totalQ));
          balancesMinor[s.personaId] = (balancesMinor[s.personaId] || 0) - owedMinor;
          balancesMinor[e.pagatoDa] = (balancesMinor[e.pagatoDa] || 0) + owedMinor;
        }
      }
    }
  }
  const creditors = [], debtors = [];
  for (const [id, balMinor] of Object.entries(balancesMinor)) {
    if (balMinor > 1) creditors.push({ id, balMinor });
    if (balMinor < -1) debtors.push({ id, balMinor: -balMinor });
  }
  creditors.sort((a, b) => b.balMinor - a.balMinor);
  debtors.sort((a, b) => b.balMinor - a.balMinor);
  const settlements = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const payMinor = Math.min(debtors[i].balMinor, creditors[j].balMinor);
    if (payMinor > 1) settlements.push({ da: debtors[i].id, a: creditors[j].id, importo: fromMinorUnits(payMinor, valutaBase) });
    debtors[i].balMinor -= payMinor;
    creditors[j].balMinor -= payMinor;
    if (debtors[i].balMinor < 1) i++;
    if (creditors[j].balMinor < 1) j++;
  }
  return settlements;
}

// Previsione spesa del mese prossimo: media mobile semplice sugli ultimi N
// mesi COMPLETI (il mese in corso è escluso perché parziale — includerlo
// abbasserebbe artificialmente la media). Include anche una ripartizione per
// categoria, calcolata con la stessa media sulle stesse categorie.
export function forecastNextMonthExpenses(transazioni, categorie, oggi = new Date(), months = 3, valutaBase = "EUR") {
  const monthKeys = [];
  for (let i = 1; i <= months; i++) {
    const d = new Date(oggi.getFullYear(), oggi.getMonth() - i, 1);
    monthKeys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }

  const totalsByMonthMinor = {};
  const categoryTotalsByMonthMinor = {};
  for (const key of monthKeys) { totalsByMonthMinor[key] = 0; categoryTotalsByMonthMinor[key] = {}; }

  for (const t of transazioni) {
    if (t.tipo !== "uscita" || !t.data) continue;
    const key = t.data.slice(0, 7);
    if (!(key in totalsByMonthMinor)) continue;
    const importoMinor = minorUnitsOf(t, "importo", valutaBase);
    totalsByMonthMinor[key] += importoMinor;
    const cat = t.categoria || "altro";
    categoryTotalsByMonthMinor[key][cat] = (categoryTotalsByMonthMinor[key][cat] || 0) + importoMinor;
  }

  const monthsWithData = monthKeys.filter(k => totalsByMonthMinor[k] > 0);
  const monthsUsed = monthsWithData.length;
  if (monthsUsed === 0) return { forecast: 0, monthsUsed: 0, perCategory: [] };

  const sumTotalMinor = monthsWithData.reduce((s, k) => s + totalsByMonthMinor[k], 0);
  const forecast = fromMinorUnits(Math.round(sumTotalMinor / monthsUsed), valutaBase);

  const catIds = new Set();
  for (const k of monthsWithData) for (const cid of Object.keys(categoryTotalsByMonthMinor[k])) catIds.add(cid);

  const perCategory = [...catIds].map(id => {
    const sumMinor = monthsWithData.reduce((s, k) => s + (categoryTotalsByMonthMinor[k][id] || 0), 0);
    const valore = fromMinorUnits(Math.round(sumMinor / monthsUsed), valutaBase);
    const cat = categorie.find(c => c.id === id);
    return { id, nome: cat?.nome || id, emoji: cat?.emoji || "📦", colore: cat?.colore || "#888", valore };
  }).filter(c => c.valore > 0).sort((a, b) => b.valore - a.valore);

  return { forecast, monthsUsed, perCategory };
}
