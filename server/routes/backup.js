import express from "express";
import { toMinorUnits } from "../../src/lib/money.js";
import {
  sendError, requireHousehold, writeLimiter, db, transactionsCol, tripsCol,
  quotesCol, householdsCol, auditCol, withTransaction, sanitizePersone, sanitizeText,
} from "../shared.js";

const router = express.Router();


// ─── Full backup & restore ───
router.get("/api/backup", requireHousehold, async (req, res) => {
  try {
    const hid = req.householdId;
    const strip = (d) => { const id = d._id.toString(); const o = { id, ...d }; delete o._id; delete o.householdId; return o; };
    const [transactions, accounts, goals, trips, positions, priceDocs] = await Promise.all([
      transactionsCol.find({ householdId: hid }).toArray(),
      db.collection("accounts").find({ householdId: hid }).toArray(),
      db.collection("goals").find({ householdId: hid }).toArray(),
      tripsCol.find({ householdId: hid }).toArray(),
      db.collection("positions").find({ householdId: hid }).toArray(),
      quotesCol.find({ householdId: hid, manualPrice: { $exists: true } }).toArray(),
    ]);
    const manualPrices = {};
    for (const d of priceDocs) manualPrices[d.ticker] = d.manualPrice;
    res.json({
      formato: "balance-tracker-backup",
      versione: 1,
      creato: new Date().toISOString(),
      household: { nome: req.household.nome, persone: sanitizePersone(req.household.persone), categorieUscita: req.household.categorieUscita || null },
      transactions: transactions.map(strip),
      accounts: accounts.map(strip),
      goals: goals.map(strip),
      trips: trips.map(strip),
      positions: positions.map(strip),
      manualPrices,
    });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

router.post("/api/backup/restore", writeLimiter, requireHousehold, async (req, res) => {
  try {
    const b = req.body;
    if (!b || b.formato !== "balance-tracker-backup") return sendError(res, 400, "INVALID_BACKUP_FORMAT", "File non riconosciuto come backup");
    const hid = req.householdId;
    const valutaBase = req.household.valutaBase || "EUR";
    const asArray = (x) => Array.isArray(x) ? x : [];
    const clean = (d) => { const o = { ...d }; delete o.id; delete o._id; o.householdId = hid; return o; };
    const counts = { transactions: 0, accounts: 0, goals: 0, trips: 0, positions: 0, manualPrices: 0 };

    // One Mongo transaction for the whole restore: previously each
    // collection was inserted in its own unguarded loop, so a failure
    // partway through (e.g. a bad transaction row after accounts/goals/
    // trips/positions had already committed) left the household with a
    // half-restored backup and no way to tell from the response, which
    // itself never arrived (the request just 500'd). Now either every
    // collection ends up restored or none of them do.
    await withTransaction(async (session) => {
      // 1. Accounts first, building an old→new id map for references
      const contoIdMap = {};
      for (const a of asArray(b.accounts)) {
        const doc = clean(a);
        doc.nome = sanitizeText(String(doc.nome || "Conto"), 60);
        doc.icona = sanitizeText(String(doc.icona || "🏦"), 8);
        doc.saldoIniziale = Number.isFinite(parseFloat(doc.saldoIniziale)) ? parseFloat(doc.saldoIniziale) : 0;
        doc.saldoInizialeMinorUnits = toMinorUnits(doc.saldoIniziale, valutaBase); // MOD-016
        doc.restoredAt = new Date();
        const r = await db.collection("accounts").insertOne(doc, { session });
        if (a.id) contoIdMap[a.id] = r.insertedId.toString();
        counts.accounts++;
      }
      const remap = (oldId) => (oldId && contoIdMap[oldId]) || null;

      // 2. Goals (remapping the linked account)
      for (const g of asArray(b.goals)) {
        const doc = clean(g);
        doc.contoId = remap(doc.contoId);
        if (Number.isFinite(parseFloat(doc.targetAmount))) doc.targetAmountMinorUnits = toMinorUnits(parseFloat(doc.targetAmount), valutaBase); // MOD-016
        if (Number.isFinite(parseFloat(doc.currentAmount))) doc.currentAmountMinorUnits = toMinorUnits(parseFloat(doc.currentAmount), valutaBase); // MOD-016
        doc.restoredAt = new Date();
        await db.collection("goals").insertOne(doc, { session });
        counts.goals++;
      }

      // 3. Trips (expenses are embedded, restored as-is — except the MOD-016
      // companion field, recomputed per expense rather than trusted from a
      // possibly stale/absent backup, same reasoning as transactions below)
      for (const t of asArray(b.trips)) {
        const doc = clean(t);
        if (Array.isArray(doc.expenses)) {
          doc.expenses = doc.expenses.map(e =>
            typeof e.importo === "number" ? { ...e, importoMinorUnits: toMinorUnits(e.importo, valutaBase) } : e
          );
        }
        doc.restoredAt = new Date();
        await tripsCol.insertOne(doc, { session });
        counts.trips++;
      }

      // 4. Positions
      for (const p of asArray(b.positions)) {
        const doc = clean(p);
        if (Number.isFinite(parseFloat(doc.prezzoAcquisto))) doc.prezzoAcquistoMinorUnits = toMinorUnits(parseFloat(doc.prezzoAcquisto), doc.valuta || "EUR"); // MOD-016
        doc.restoredAt = new Date();
        await db.collection("positions").insertOne(doc, { session });
        counts.positions++;
      }

      // 5. Manual prices (upsert, non-destructive)
      if (b.manualPrices && typeof b.manualPrices === "object" && !Array.isArray(b.manualPrices)) {
        const TICKER_RE = /^[A-Z0-9.^=\-]{1,20}$/;
        for (const [rawTicker, rawPrice] of Object.entries(b.manualPrices).slice(0, 200)) {
          const ticker = String(rawTicker).toUpperCase().trim();
          const price = typeof rawPrice === "number" ? rawPrice : parseFloat(rawPrice);
          if (!TICKER_RE.test(ticker) || !Number.isFinite(price) || price < 0) continue;
          await quotesCol.updateOne({ ticker, householdId: hid }, { $set: { ticker, householdId: hid, manualPrice: price, updatedAt: new Date() } }, { upsert: true, session });
          counts.manualPrices++;
        }
      }

      // 6. Transactions (remapping account references)
      const validTipi = ["uscita", "entrata", "saldo", "trasferimento"];
      for (const t of asArray(b.transactions)) {
        const doc = clean(t);
        if (!validTipi.includes(doc.tipo)) continue;
        if (!Number.isFinite(parseFloat(doc.importo))) continue;
        doc.importo = parseFloat(doc.importo);
        doc.importoMinorUnits = toMinorUnits(doc.importo, valutaBase); // MOD-016 — recomputed, not trusted from a possibly stale/absent backup field
        doc.descrizione = sanitizeText(doc.descrizione);
        doc.contoId = remap(doc.contoId);
        doc.contoDa = remap(doc.contoDa);
        doc.contoA = remap(doc.contoA);
        doc.restoredAt = new Date();
        await transactionsCol.insertOne(doc, { session });
        counts.transactions++;
      }

      // 7. Custom categories: restore only if the household has none
      if (b.household?.categorieUscita && !req.household.categorieUscita) {
        await householdsCol.updateOne({ householdId: hid }, { $set: { categorieUscita: b.household.categorieUscita, updatedAt: new Date() } }, { session });
      }

      await auditCol.insertOne({ householdId: hid, action: "backup_restore", counts, at: new Date() }, { session });
    });

    res.json({ ok: true, counts });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore durante il ripristino"); }
});

export default router;
