import express from "express";
import { ValidationError, DEFAULT_HOUSEHOLD_ROLE, validateRuolo } from "../validation.js";
import {
  sendError, requireHousehold, requireRole, writeLimiter, householdsCol, db,
  transactionsCol, tripsCol, audit, clientIp, sanitizePersone, personaIdFromNome,
  DEFAULT_EMOJIS, PERSONA_COLORS, sanitizeValuta, fetchRatesTable, sanitizeText,
} from "../shared.js";

const router = express.Router();


// ─── GET household info ───
router.get("/api/household", requireHousehold, (req, res) => {
  res.json({ id: req.household.id, nome: req.household.nome, persone: sanitizePersone(req.household.persone), hasRecoveryEmail: !!req.household.email, valutaBase: req.household.valutaBase || "EUR", createdAt: req.household.createdAt || null });
});

// ─── Base currency ───
// Every base-currency amount in the household (transaction importo, account
// saldoIniziale, goal target/currentAmount, trip expenses) is stored as a
// bare number with NO per-record currency marker — the household's
// valutaBase is the only thing that says what that number means. Changing
// valutaBase after any such record exists would silently reinterpret every
// past amount as the new currency (a EUR balance becomes "the same number
// of JPY") without moving a single unit of value — a real data-corruption
// bug, not a display quirk, so switching is only allowed while the
// household is still empty of financial history. (Positions are exempt:
// each one already carries its own `valuta` field, independent of the
// household's.)
async function householdHasFinancialData(householdId) {
  const [tx, acc, goal, trip] = await Promise.all([
    transactionsCol.findOne({ householdId }, { projection: { _id: 1 } }),
    db.collection("accounts").findOne({ householdId }, { projection: { _id: 1 } }),
    db.collection("goals").findOne({ householdId }, { projection: { _id: 1 } }),
    tripsCol.findOne({ householdId, "expenses.0": { $exists: true } }, { projection: { _id: 1 } }),
  ]);
  return !!(tx || acc || goal || trip);
}
router.put("/api/household/valuta", writeLimiter, requireHousehold, async (req, res) => {
  try {
    const valuta = sanitizeValuta(req.body?.valutaBase);
    if (!valuta) return sendError(res, 400, "INVALID_CURRENCY", "Valuta non supportata");
    if (valuta !== (req.household.valutaBase || "EUR") && await householdHasFinancialData(req.householdId)) {
      return sendError(res, 409, "CURRENCY_LOCKED", "Non è possibile cambiare valuta base: sono già presenti transazioni, conti, obiettivi o spese di viaggio. Cambiare valuta reinterpreterebbe gli importi esistenti senza convertirli.");
    }
    await householdsCol.updateOne({ householdId: req.householdId }, { $set: { valutaBase: valuta, updatedAt: new Date() } });
    res.json({ valutaBase: valuta });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

// ─── Household member roles (MOD-025) ───
// Gated to admin+ (see requireRole's comment) — but only for a session
// that went through persona-login; a plain household-PIN session can
// still call this for any persona, same as everything else, since there's
// no attributed identity to check. Also refuses to demote/remove the
// household's last "owner" regardless of who's asking — a data-integrity
// guard (a household with zero owners is a dead end no one can fix from
// inside the app), not a role check.
router.put("/api/household/persone/:id/ruolo", writeLimiter, requireHousehold, requireRole("admin"), async (req, res) => {
  try {
    let ruolo;
    try { ruolo = validateRuolo(req.body?.ruolo); }
    catch (ve) { if (ve instanceof ValidationError) return sendError(res, 400, ve.code, ve.message, ve.fields); throw ve; }

    const persone = req.household.persone || [];
    const target = persone.find(p => p.id === req.params.id);
    if (!target) return sendError(res, 404, "NOT_FOUND", "Persona non trovata");

    const currentRuolo = target.ruolo || DEFAULT_HOUSEHOLD_ROLE;
    const ownerCount = persone.filter(p => (p.ruolo || DEFAULT_HOUSEHOLD_ROLE) === "owner").length;
    if (currentRuolo === "owner" && ruolo !== "owner" && ownerCount <= 1) {
      return sendError(res, 400, "LAST_OWNER", "La casa deve avere almeno un owner", { personaId: req.params.id });
    }

    const updatedPersone = persone.map(p => p.id === req.params.id ? { ...p, ruolo } : p);
    await householdsCol.updateOne({ householdId: req.householdId }, { $set: { persone: updatedPersone, updatedAt: new Date() } });
    audit("persona_role_changed", { householdId: req.householdId, ip: clientIp(req), detail: { personaId: req.params.id, ruolo } });
    res.json({ persone: sanitizePersone(updatedPersone) }); // updatedPersone (unsanitized) is what got written to the DB — only the response is sanitized
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

// Add a new participant to an already-registered household — the same
// shape POST /api/auth/register accepts per-persona, just against an
// existing household instead of at creation time. Gated admin+ (same
// tier as changing a role, above): adding a member is a household-
// structural change, not a everyday write. Always lands at the
// DEFAULT_HOUSEHOLD_ROLE — this endpoint can't be used to mint another
// owner/admin, that's still PUT .../ruolo's job, kept as a separate step
// so granting elevated access is always its own explicit, auditable act.
router.post("/api/household/persone", writeLimiter, requireHousehold, requireRole("admin"), async (req, res) => {
  try {
    const nome = sanitizeText(req.body?.nome, 100);
    if (!nome) return sendError(res, 400, "MISSING_FIELDS", "Campo obbligatorio: nome");
    const emoji = typeof req.body?.emoji === "string" ? sanitizeText(req.body.emoji, 8) : null;

    const persone = req.household.persone || [];
    const existingIds = new Set(persone.map(p => p.id));
    const id = personaIdFromNome(nome, existingIds);
    const newPersona = {
      id,
      nome,
      emoji: emoji || DEFAULT_EMOJIS[persone.length % DEFAULT_EMOJIS.length],
      colore: PERSONA_COLORS[persone.length % PERSONA_COLORS.length],
      ruolo: DEFAULT_HOUSEHOLD_ROLE,
    };
    const updatedPersone = [...persone, newPersona];
    await householdsCol.updateOne({ householdId: req.householdId }, { $set: { persone: updatedPersone, updatedAt: new Date() } });
    audit("persona_added", { householdId: req.householdId, ip: clientIp(req), detail: { personaId: id } });
    res.status(201).json({ persone: sanitizePersone(updatedPersone) });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

// Removes a participant from the household outright — distinct from
// DELETE .../persona-credential, which only un-enrolls a login and
// leaves the persona itself in place. Owner-only: this is a step above
// admin's ability to add someone or change a role, since it can sever
// someone's access to the household entirely. Existing transactions,
// splits, etc. that reference this persona's id are left untouched
// (same as every other place an id can outlive its owner, e.g. a
// deleted account) — reassigning or scrubbing that history is a
// separate, larger feature, not implied by removing a member.
router.delete("/api/household/persone/:id", writeLimiter, requireHousehold, requireRole("owner"), async (req, res) => {
  try {
    if (req.personaId && req.personaId === req.params.id) {
      return sendError(res, 400, "CANNOT_REMOVE_SELF", "Non puoi rimuovere te stesso dalla casa");
    }
    const persone = req.household.persone || [];
    const target = persone.find(p => p.id === req.params.id);
    if (!target) return sendError(res, 404, "NOT_FOUND", "Persona non trovata");
    if (persone.length <= 1) return sendError(res, 400, "LAST_PERSONA", "La casa deve avere almeno una persona");

    const targetRuolo = target.ruolo || DEFAULT_HOUSEHOLD_ROLE;
    const ownerCount = persone.filter(p => (p.ruolo || DEFAULT_HOUSEHOLD_ROLE) === "owner").length;
    if (targetRuolo === "owner" && ownerCount <= 1) {
      return sendError(res, 400, "LAST_OWNER", "La casa deve avere almeno un owner", { personaId: req.params.id });
    }

    const updatedPersone = persone.filter(p => p.id !== req.params.id);
    await householdsCol.updateOne({ householdId: req.householdId }, { $set: { persone: updatedPersone, updatedAt: new Date() } });
    await clearLock(`persona:${req.householdId}:${req.params.id}`);
    await revokeTokensForPersona(req.householdId, req.params.id); // kill every session this persona was logged into
    audit("persona_removed", { householdId: req.householdId, ip: clientIp(req), detail: { personaId: req.params.id } });
    res.json({ persone: sanitizePersone(updatedPersone) });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

router.get("/api/exchange-rates", requireHousehold, async (req, res) => {
  try {
    const base = req.household.valutaBase || "EUR";
    const { rates, stale } = await fetchRatesTable(base);
    if (!rates) {
      return res.status(503).json({ error: { code: "EXCHANGE_RATE_UNAVAILABLE", message: "Cambio valuta non disponibile al momento, riprova più tardi." } });
    }
    res.json({ base, rates: { ...rates, [base]: 1 }, stale });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

export default router;
