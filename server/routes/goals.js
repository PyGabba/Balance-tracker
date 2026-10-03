import express from "express";
import { ObjectId } from "mongodb";
import { toMinorUnits } from "../../src/lib/money.js";
import { ValidationError, validatePositiveNumber, validateNonNegativeNumber, validateEnum, GOAL_CONTRIBUTION_TYPES } from "../validation.js";
import {
  sendError, requireHousehold, requireRole, writeLimiter, db,
  idempotencyKeyFrom, claimIdempotencyKey, handleIdempotencyClaim, finalizeIdempotencyKey,
  isHouseholdAccount, sanitizeText,
} from "../shared.js";

const router = express.Router();


// Savings Goals
router.get("/api/goals", requireHousehold, async (req, res) => {
  try {
    const col = db.collection("goals");
    const docs = await col.find({ householdId: req.householdId }).sort({ createdAt: -1 }).toArray();
    res.json(docs.map(d => { const id = d._id.toString(); delete d._id; delete d.householdId; return { id, ...d }; }));
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

router.post("/api/goals", writeLimiter, requireHousehold, requireRole("member"), async (req, res) => {
  try {
    const idemKey = idempotencyKeyFrom(req);
    const claim = await claimIdempotencyKey(req.householdId, idemKey);
    if (handleIdempotencyClaim(claim, res)) return;

    const b = req.body;
    if (!b.nome || !b.targetAmount) return sendError(res, 400, "MISSING_FIELDS", "Campi obbligatori: nome, targetAmount");
    // MOD-009: contoId must actually belong to this household, not just be a well-formed ObjectId.
    if (b.contoId && !(await isHouseholdAccount(b.contoId, req.householdId))) {
      return sendError(res, 400, "UNKNOWN_ACCOUNT", "Conto non valido", { contoId: b.contoId });
    }
    const valutaBase = req.household.valutaBase || "EUR";
    let targetAmount, currentAmount, contributionType, contributionValue;
    try {
      targetAmount = validatePositiveNumber(b.targetAmount, "targetAmount");
      currentAmount = b.currentAmount !== undefined ? validateNonNegativeNumber(b.currentAmount, "currentAmount") : 0;
      contributionType = validateEnum(b.contributionType || "manual", GOAL_CONTRIBUTION_TYPES, "contributionType");
      contributionValue = contributionType !== "manual" && b.contributionValue !== undefined
        ? validateNonNegativeNumber(b.contributionValue, "contributionValue")
        : 0;
    } catch (ve) {
      if (ve instanceof ValidationError) return sendError(res, 400, ve.code, ve.message, ve.fields);
      throw ve;
    }
    const doc = {
      householdId: req.householdId,
      nome: sanitizeText(b.nome, 100),
      targetAmount,
      targetAmountMinorUnits: toMinorUnits(targetAmount, valutaBase), // MOD-016
      targetDate: b.targetDate || null,
      currentAmount,
      currentAmountMinorUnits: toMinorUnits(currentAmount, valutaBase), // MOD-016
      contributionType,
      contributionValue,
      autoAdd: b.autoAdd === true,
      contoId: b.contoId || null,
      createdAt: new Date(),
    };
    const result = await db.collection("goals").insertOne(doc);
    const id = result.insertedId.toString();
    delete doc.householdId;
    const responseBody = { id, ...doc };
    await finalizeIdempotencyKey(req.householdId, idemKey, 201, responseBody);
    res.status(201).json(responseBody);
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

router.put("/api/goals/:id", writeLimiter, requireHousehold, requireRole("member"), async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return sendError(res, 400, "INVALID_ID", "ID non valido");
    const b = req.body;
    // MOD-009: same ownership check as create — a PUT can just as easily
    // try to attach the goal to someone else's account.
    if (b.contoId !== undefined && b.contoId && !(await isHouseholdAccount(b.contoId, req.householdId))) {
      return sendError(res, 400, "UNKNOWN_ACCOUNT", "Conto non valido", { contoId: b.contoId });
    }
    const update = {};
    try {
      if (b.nome !== undefined) update.nome = sanitizeText(b.nome, 100);
      if (b.targetAmount !== undefined) {
        update.targetAmount = validatePositiveNumber(b.targetAmount, "targetAmount");
        update.targetAmountMinorUnits = toMinorUnits(update.targetAmount, req.household.valutaBase || "EUR"); // MOD-016
      }
      if (b.targetDate !== undefined) update.targetDate = b.targetDate;
      if (b.currentAmount !== undefined) {
        update.currentAmount = validateNonNegativeNumber(b.currentAmount, "currentAmount");
        update.currentAmountMinorUnits = toMinorUnits(update.currentAmount, req.household.valutaBase || "EUR"); // MOD-016
      }
      if (b.contributionType !== undefined) update.contributionType = validateEnum(b.contributionType, GOAL_CONTRIBUTION_TYPES, "contributionType");
      if (b.contributionValue !== undefined) update.contributionValue = validateNonNegativeNumber(b.contributionValue, "contributionValue");
    } catch (ve) {
      if (ve instanceof ValidationError) return sendError(res, 400, ve.code, ve.message, ve.fields);
      throw ve;
    }
    if (b.autoAdd !== undefined) update.autoAdd = b.autoAdd === true;
    if (b.contoId !== undefined) update.contoId = b.contoId || null;
    if (Object.keys(update).length === 0) return sendError(res, 400, "NO_FIELDS_TO_UPDATE", "Nessun campo da aggiornare");
    update.updatedAt = new Date();
    await db.collection("goals").updateOne({ _id: new ObjectId(req.params.id), householdId: req.householdId }, { $set: update });
    res.json({ ok: true });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

router.delete("/api/goals/:id", requireHousehold, requireRole("member"), async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return sendError(res, 400, "INVALID_ID", "ID non valido");
    const r = await db.collection("goals").deleteOne({ _id: new ObjectId(req.params.id), householdId: req.householdId });
    if (r.deletedCount === 0) return sendError(res, 404, "NOT_FOUND", "Non trovato");
    res.json({ deleted: true });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

export default router;
