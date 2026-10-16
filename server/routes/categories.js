import express from "express";
import { sendError, requireHousehold, writeLimiter, householdsCol } from "../shared.js";
import { sanitizeCategorie } from "../validation.js";

const router = express.Router();


// ─── Custom Categories ───
// Already loaded in requireHousehold via findHousehold — just return it
router.get("/api/categorie", requireHousehold, (req, res) => {
  res.json({ categorie: req.household.categorieUscita || null });
});

router.put("/api/categorie", requireHousehold, async (req, res) => {
  try {
    const { categorie } = req.body || {};
    if (!Array.isArray(categorie) || categorie.length === 0)
      return sendError(res, 400, "INVALID_CATEGORIES", "categorie deve essere un array non vuoto");
    if (categorie.length > 100)
      return sendError(res, 400, "TOO_MANY_CATEGORIES", "Massimo 100 categorie");
    // Sanitize: known keys only; per-category monthly budget allowed here
    // (the expenses categories are what budgets are set against).
    const sanitized = sanitizeCategorie(categorie, { allowBudget: true, allowStrings: true });
    if (sanitized.length === 0)
      return sendError(res, 400, "NO_VALID_CATEGORIES", "Nessuna categoria valida");
    await householdsCol.updateOne(
      { householdId: req.householdId },
      { $set: { categorieUscita: sanitized, updatedAt: new Date() } }
    );
    res.json({ ok: true });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

// ─── Trip categories (sincronizzate sulla casa, come categorieUscita) ───
router.get("/api/trip-categories", requireHousehold, async (req, res) => {
  res.json({ categorie: req.household.tripCategories || null });
});

router.put("/api/trip-categories", writeLimiter, requireHousehold, async (req, res) => {
  try {
    const { categorie } = req.body || {};
    if (!Array.isArray(categorie) || categorie.length === 0)
      return sendError(res, 400, "INVALID_CATEGORIES", "categorie deve essere un array non vuoto");
    if (categorie.length > 100)
      return sendError(res, 400, "TOO_MANY_CATEGORIES", "Massimo 100 categorie");
    const sanitized = sanitizeCategorie(categorie);
    if (sanitized.length === 0)
      return sendError(res, 400, "NO_VALID_CATEGORIES", "Nessuna categoria valida");
    await householdsCol.updateOne(
      { householdId: req.householdId },
      { $set: { tripCategories: sanitized, updatedAt: new Date() } }
    );
    res.json({ ok: true });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

export default router;
