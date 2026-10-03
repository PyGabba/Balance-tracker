import express from "express";
import { ObjectId } from "mongodb";
import { toMinorUnits } from "../../src/lib/money.js";
import {
  sendError, requireHousehold, requireRole, writeLimiter, db, transactionsCol,
  idempotencyKeyFrom, claimIdempotencyKey, handleIdempotencyClaim, finalizeIdempotencyKey,
  sanitizeText, withTransaction,
} from "../shared.js";

const router = express.Router();


// ─── Accounts (conti) API ───
router.get("/api/accounts", requireHousehold, async (req, res) => {
  try {
    const docs = await db.collection("accounts").find({ householdId: req.householdId }).sort({ createdAt: 1 }).toArray();
    res.json(docs.map(d => { const id = d._id.toString(); delete d._id; delete d.householdId; return { id, ...d }; }));
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

router.post("/api/accounts", writeLimiter, requireHousehold, requireRole("member"), async (req, res) => {
  try {
    const idemKey = idempotencyKeyFrom(req);
    const claim = await claimIdempotencyKey(req.householdId, idemKey);
    if (handleIdempotencyClaim(claim, res)) return;

    const b = req.body;
    if (!b.nome) return sendError(res, 400, "MISSING_FIELDS", "Campo obbligatorio: nome");
    const saldoIniziale = parseFloat(b.saldoIniziale);
    const doc = {
      householdId: req.householdId,
      nome: sanitizeText(b.nome, 60),
      icona: sanitizeText(b.icona, 8) || "🏦",
      saldoIniziale: Number.isFinite(saldoIniziale) ? saldoIniziale : 0,
      saldoInizialeMinorUnits: toMinorUnits(Number.isFinite(saldoIniziale) ? saldoIniziale : 0, req.household.valutaBase || "EUR"), // MOD-016
      createdAt: new Date(),
    };
    const result = await db.collection("accounts").insertOne(doc);
    const id = result.insertedId.toString();
    delete doc.householdId;
    const responseBody = { id, ...doc };
    await finalizeIdempotencyKey(req.householdId, idemKey, 201, responseBody);
    res.status(201).json(responseBody);
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

router.put("/api/accounts/:id", writeLimiter, requireHousehold, requireRole("member"), async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return sendError(res, 400, "INVALID_ID", "ID non valido");
    const b = req.body;
    const update = {};
    if (b.nome !== undefined) update.nome = sanitizeText(b.nome, 60);
    if (b.icona !== undefined) update.icona = sanitizeText(b.icona, 8) || "🏦";
    if (b.saldoIniziale !== undefined) {
      const v = parseFloat(b.saldoIniziale);
      if (!Number.isFinite(v)) return sendError(res, 400, "INVALID_FIELD", "saldoIniziale non valido");
      update.saldoIniziale = v;
      update.saldoInizialeMinorUnits = toMinorUnits(v, req.household.valutaBase || "EUR"); // MOD-016
    }
    if (Object.keys(update).length === 0) return sendError(res, 400, "NO_FIELDS_TO_UPDATE", "Nessun campo da aggiornare");
    update.updatedAt = new Date();
    await db.collection("accounts").updateOne({ _id: new ObjectId(req.params.id), householdId: req.householdId }, { $set: update });
    res.json({ ok: true });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

router.delete("/api/accounts/:id", writeLimiter, requireHousehold, requireRole("member"), async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return sendError(res, 400, "INVALID_ID", "ID non valido");
    const hid = req.householdId;
    const accId = req.params.id;
    // One transaction: deleting the account but crashing before its
    // references are detached would leave transactions/goals pointing at
    // an account id that no longer exists.
    const deletedCount = await withTransaction(async (session) => {
      const r = await db.collection("accounts").deleteOne({ _id: new ObjectId(accId), householdId: hid }, { session });
      if (r.deletedCount === 0) return 0;
      // Detach the deleted account from its transactions and goals (they stay, unassigned)
      await transactionsCol.updateMany({ householdId: hid, contoId: accId }, { $set: { contoId: null } }, { session });
      await transactionsCol.updateMany({ householdId: hid, contoDa: accId }, { $set: { contoDa: null } }, { session });
      await transactionsCol.updateMany({ householdId: hid, contoA: accId }, { $set: { contoA: null } }, { session });
      await db.collection("goals").updateMany({ householdId: hid, contoId: accId }, { $set: { contoId: null } }, { session });
      return r.deletedCount;
    });
    if (deletedCount === 0) return sendError(res, 404, "NOT_FOUND", "Non trovato");
    res.json({ deleted: true });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

export default router;
