// ─── Algoritmi finanziari puri ───
// Estratti da App.jsx per essere testabili in isolamento (vedi finance.test.js).
// Nessuna dipendenza da React o dallo stato dell'app: solo input → output.

// Matrice debiti della casa: da transazioni (uscite con split + saldi) a lista
// di debiti minimizzata con matching greedy creditori/debitori.
export function calcolaDebitiMatrix(transazioni, persone) {
  const balances = {};
  for (const t of transazioni) {
    if (t.tipo === "saldo") {
      if (!t.pagatoDa || !t.ricevutoDa) continue;
      // Trip settlements are record-only: the underlying trip expenses never
      // entered the household ledger, so counting them here would create a
      // spurious opposite debt in the household matrix
      if (t.categoria === "saldo_viaggio") continue;
      // Payment reduces debt: add in reverse direction so netting cancels it out
      const key = `${t.ricevutoDa}->${t.pagatoDa}`;
      balances[key] = (balances[key] || 0) + t.importo;
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
      const owed = t.importo * (sh.quota / totalQ);
      const key = `${sh.personaId}->${payer}`;
      balances[key] = (balances[key] || 0) + owed;
    }
  }
  // Convert directional pair balances → per-person net balance
  const netPerPerson = {};
  for (const [key, amount] of Object.entries(balances)) {
    const [da, a] = key.split("->");
    netPerPerson[da] = (netPerPerson[da] || 0) - amount; // owes → negative
    netPerPerson[a]  = (netPerPerson[a]  || 0) + amount; // owed → positive
  }

  // Greedy creditor/debtor matching — minimises number of transactions
  const creditors = [], debtors = [];
  for (const [id, bal] of Object.entries(netPerPerson)) {
    if (bal >  0.01) creditors.push({ id, bal });
    if (bal < -0.01) debtors.push({ id, bal: -bal });
  }
  creditors.sort((a, b) => b.bal - a.bal);
  debtors.sort((a, b) => b.bal - a.bal);

  const debiti = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const pay = Math.min(debtors[i].bal, creditors[j].bal);
    debiti.push({ da: debtors[i].id, a: creditors[j].id, importo: Math.round(pay * 100) / 100 });
    debtors[i].bal   -= pay;
    creditors[j].bal -= pay;
    if (debtors[i].bal   < 0.01) i++;
    if (creditors[j].bal < 0.01) j++;
  }
  return debiti;
}

// Saldi dei conti: saldo iniziale + entrate − uscite assegnate + giroconti.
export function calcolaSaldiConti(conti, transazioni) {
  const saldi = {};
  for (const c of conti) saldi[c.id] = c.saldoIniziale || 0;
  for (const t of transazioni) {
    if (t.tipo === "trasferimento") {
      if (t.contoDa && saldi[t.contoDa] !== undefined) saldi[t.contoDa] -= t.importo;
      if (t.contoA && saldi[t.contoA] !== undefined) saldi[t.contoA] += t.importo;
      continue;
    }
    if (!t.contoId || saldi[t.contoId] === undefined) continue;
    if (t.tipo === "entrata") saldi[t.contoId] += t.importo;
    else if (t.tipo === "uscita") saldi[t.contoId] -= t.importo;
  }
  return saldi;
}

// Valore del portafoglio con contabilità a costo medio (le vendite riducono il
// costo di qty × prezzo medio); prezzo manuale, altrimenti costo di carico.
export function calcolaValorePortfolio(positions, manualPrices) {
  const map = {};
  const sorted = [...positions].sort((a, b) =>
    (a.dataAcquisto || "").localeCompare(b.dataAcquisto || "") ||
    (a.createdAt || "").localeCompare(b.createdAt || "")
  );
  for (const p of sorted) {
    if (!map[p.ticker]) map[p.ticker] = { quantita: 0, costoTotale: 0 };
    const h = map[p.ticker];
    if (p.tipo === "sell") {
      const avg = h.quantita > 0.0001 ? h.costoTotale / h.quantita : 0;
      const q = Math.min(p.quantita, h.quantita);
      h.costoTotale -= q * avg; h.quantita -= q;
      if (h.quantita < 0.0001) { h.quantita = 0; h.costoTotale = 0; }
    } else { h.quantita += p.quantita; h.costoTotale += p.quantita * p.prezzoAcquisto; }
  }
  let valore = 0, investito = 0;
  for (const k of Object.keys(map)) {
    const h = map[k];
    if (h.quantita <= 0.0001) continue;
    const prezzo = (manualPrices && manualPrices[k]) || 0;
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
  return n;
}

export function calcolaSettleViaggio(trip) {
  const balances = {};
  for (const e of trip.expenses) {
    if (e.splits && e.splits.length > 0) {
      const totalQ = e.splits.reduce((s, sc) => s + sc.quota, 0);
      for (const s of e.splits) {
        if (s.personaId !== e.pagatoDa) {
          const owed = e.importo * (s.quota / totalQ);
          balances[s.personaId] = (balances[s.personaId] || 0) - owed;
          balances[e.pagatoDa] = (balances[e.pagatoDa] || 0) + owed;
        }
      }
    }
  }
  const creditors = [], debtors = [];
  for (const [id, bal] of Object.entries(balances)) {
    if (bal > 0.01) creditors.push({ id, bal });
    if (bal < -0.01) debtors.push({ id, bal: -bal });
  }
  creditors.sort((a, b) => b.bal - a.bal);
  debtors.sort((a, b) => b.bal - a.bal);
  const settlements = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const pay = Math.min(debtors[i].bal, creditors[j].bal);
    if (pay > 0.01) settlements.push({ da: debtors[i].id, a: creditors[j].id, importo: Math.round(pay * 100) / 100 });
    debtors[i].bal -= pay;
    creditors[j].bal -= pay;
    if (debtors[i].bal < 0.01) i++;
    if (creditors[j].bal < 0.01) j++;
  }
  return settlements;
}
