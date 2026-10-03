import express from "express";
import { fromMinorUnits, minorUnitsOf } from "../../src/lib/money.js";
import { sendError, requireHousehold, transactionsCol } from "../shared.js";

const router = express.Router();


// ─── N-person debt matrix ───
router.get("/api/stats/debiti", requireHousehold, async (req, res) => {
  try {
    const txs = await transactionsCol.find({
      householdId: req.householdId, tipo: "uscita", pagatoDa: { $ne: null }, deletedAt: null
    }).toArray();

    // Also fetch saldo transactions to account for settlements
    // (trip settlements "saldo_viaggio" are record-only and excluded: their
    // underlying expenses live in the trips collection, not in this ledger)
    const saldi = await transactionsCol.find({
      householdId: req.householdId, tipo: "saldo", pagatoDa: { $ne: null }, ricevutoDa: { $ne: null },
      categoria: { $ne: "saldo_viaggio" }, deletedAt: null
    }).toArray();

    // Per-person net balance
    // MOD-016: accumulate in integer minor units, not raw floats — same
    // reasoning as calcolaDebitiMatrix (src/lib/finance.js) and
    // calcolaSettleViaggioServer above, which this endpoint otherwise
    // duplicates.
    const netPerPersonMinor = {};
    function addAmountMinor(id, deltaMinor) { netPerPersonMinor[id] = (netPerPersonMinor[id] || 0) + deltaMinor; }

    for (const t of txs) {
      const payer = t.pagatoDa;
      let shares = [];
      if (t.splits && Array.isArray(t.splits) && t.splits.length > 0) {
        shares = t.splits;
      } else if (t.splitPagante != null) {
        const other = req.household.persone.find(p => p.id !== payer);
        if (other) shares = [{ personaId: payer, quota: t.splitPagante }, { personaId: other.id, quota: 100 - t.splitPagante }];
      }
      if (!shares.length) continue;
      const totalQ = shares.reduce((s, sh) => s + (sh.quota || 0), 0);
      if (totalQ <= 0) continue;
      const importoMinor = minorUnitsOf(t, "importo", req.household.valutaBase || "EUR"); // MOD-016 contract phase
      for (const sh of shares) {
        if (sh.personaId === payer) continue;
        const owedMinor = Math.round(importoMinor * (sh.quota / totalQ));
        addAmountMinor(payer, +owedMinor);
        addAmountMinor(sh.personaId, -owedMinor);
      }
    }

    // Settlements reduce balances
    for (const s of saldi) {
      const importoMinor = minorUnitsOf(s, "importo", req.household.valutaBase || "EUR"); // MOD-016 contract phase
      addAmountMinor(s.pagatoDa, +importoMinor);
      addAmountMinor(s.ricevutoDa, -importoMinor);
    }

    // Greedy creditor/debtor matching
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
      debiti.push({ da: debtors[i].id, a: creditors[j].id, importo: fromMinorUnits(payMinor, req.household.valutaBase || "EUR") });
      debtors[i].balMinor   -= payMinor;
      creditors[j].balMinor -= payMinor;
      if (debtors[i].balMinor   < 1) i++;
      if (creditors[j].balMinor < 1) j++;
    }
    res.json({ debiti });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

// ─── Stats summary ───
router.get("/api/stats/summary", requireHousehold, async (req, res) => {
  try {
    const match = { householdId: req.householdId, deletedAt: null };
    if (req.query.meseAnno) {
      const [a, m] = req.query.meseAnno.split("-").map(Number);
      match.data = { $gte: new Date(a, m - 1, 1).toISOString().slice(0, 10), $lte: new Date(a, m, 0).toISOString().slice(0, 10) };
    }
    const results = await transactionsCol.aggregate([
      { $match: match },
      { $group: { _id: { tipo: "$tipo", categoria: "$categoria", pagatoDa: "$pagatoDa" }, totale: { $sum: "$importo" }, count: { $sum: 1 } } }
    ]).toArray();
    res.json(results);
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

export default router;
