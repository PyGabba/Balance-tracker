import express from "express";
import rateLimit from "express-rate-limit";
import jwt from "jsonwebtoken";
import { randomBytes } from "crypto";
import { ObjectId } from "mongodb";
import { buildTripExpense, ValidationError } from "../validation.js";
import { logger, recordTripEmbeddingStats } from "../logger.js";
import {
  sendError, requireHousehold, requireRole, writeLimiter, tripsCol, householdsCol,
  sanitizeText, idempotencyKeyFrom, claimIdempotencyKey, handleIdempotencyClaim,
  finalizeIdempotencyKey, calcolaSettleViaggioServer, insertSettlementLegs,
  audit, clientIp, hashCapabilityToken, findByCapabilityToken, JWT_SECRET,
} from "../shared.js";

const router = express.Router();


// ─── Trips API ───
router.get("/api/trips", requireHousehold, async (req, res) => {
  try {
    const trips = await tripsCol.find({ householdId: req.householdId }).sort({ startDate: -1 }).toArray();
    for (const t of trips) recordTripEmbeddingStats(t); // MOD-019: cheap — trips are already in hand, no extra query
    res.json(trips.map(t => { const id = t._id.toString(); delete t._id; delete t.householdId; return { id, ...t }; }));
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

router.post("/api/trips", writeLimiter, requireHousehold, requireRole("member"), async (req, res) => {
  try {
    const idemKey = idempotencyKeyFrom(req);
    const claim = await claimIdempotencyKey(req.householdId, idemKey);
    if (handleIdempotencyClaim(claim, res)) return;

    const t = req.body;
    const doc = {
      householdId: req.householdId,
      nome: sanitizeText(t.nome, 100),
      descrizione: sanitizeText(t.descrizione, 500),
      startDate: t.startDate || null,
      endDate: t.endDate || null,
      partecipanti: sanitizePartecipanti(t.partecipanti),
      expenses: [],
      settled: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    if (!doc.nome) return sendError(res, 400, "MISSING_FIELDS", "Nome richiesto");
    const result = await tripsCol.insertOne(doc);
    delete doc.householdId;
    const responseBody = { id: result.insertedId.toString(), ...doc };
    await finalizeIdempotencyKey(req.householdId, idemKey, 201, responseBody);
    res.json(responseBody);
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

router.put("/api/trips/:id", writeLimiter, requireHousehold, requireRole("member"), async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return sendError(res, 400, "INVALID_ID", "ID non valido");
    const t = req.body;
    const update = {};
    if (t.nome !== undefined) update.nome = sanitizeText(t.nome, 100);
    if (t.descrizione !== undefined) update.descrizione = sanitizeText(t.descrizione, 500);
    if (t.startDate !== undefined) update.startDate = t.startDate;
    if (t.endDate !== undefined) update.endDate = t.endDate;
    if (t.partecipanti !== undefined) update.partecipanti = sanitizePartecipanti(t.partecipanti);
    // `settled` is deliberately NOT settable here — it's a financial
    // invariant (a trip is only settled once real settlement transactions
    // exist), not a plain field. See POST /api/trips/:id/settle, which is
    // the only path that can set it, and never unsets it.
    if (Object.keys(update).length === 0) return sendError(res, 400, "NO_FIELDS_TO_UPDATE", "Nessun campo da aggiornare");
    update.updatedAt = new Date();
    await tripsCol.updateOne({ _id: new ObjectId(req.params.id), householdId: req.householdId }, { $set: update });
    res.json({ ok: true });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

// The only path that can mark a trip settled — computes settlements
// server-side (never trusts client-supplied numbers), atomically claims the
// trip the same way the scheduled auto-close job does (so the two can never
// race each other into double-inserting settlement legs), and only flips
// `settled` once every leg is actually recorded. One-directional: there is
// no "unsettle" — see the comment on PUT /api/trips/:id.
router.post("/api/trips/:id/settle", writeLimiter, requireHousehold, requireRole("member"), async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return sendError(res, 400, "INVALID_ID", "ID non valido");
    const _id = new ObjectId(req.params.id);
    const now = new Date();
    const claimed = await tripsCol.findOneAndUpdate(
      { _id, householdId: req.householdId, settled: false, settlementStatus: { $in: [null, "open"] } },
      { $set: { settlementStatus: "settling", settlingStartedAt: now, updatedAt: now } },
      { returnDocument: "after" }
    );
    if (!claimed) {
      const existing = await tripsCol.findOne({ _id, householdId: req.householdId }, { projection: { settled: 1, settlementStatus: 1 } });
      if (!existing) return sendError(res, 404, "NOT_FOUND", "Viaggio non trovato");
      if (existing.settled) return sendError(res, 400, "TRIP_SETTLED", "Viaggio già chiuso");
      return sendError(res, 409, "TRIP_SETTLEMENT_IN_PROGRESS", "Chiusura viaggio già in corso, riprova tra poco");
    }

    const valutaBase = req.household.valutaBase || "EUR";
    const nameOf = (id) => (claimed.partecipanti || []).find(p => p.id === id)?.nome || id;
    const settlements = calcolaSettleViaggioServer(claimed, valutaBase);
    const allInserted = await insertSettlementLegs(req.params.id, req.householdId, claimed.nome, settlements, valutaBase, nameOf);
    if (!allInserted) {
      // Trip stays in "settling" — safe to retry (already-inserted legs are
      // idempotently skipped), or the auto-close job resumes it once stale.
      return sendError(res, 500, "SETTLEMENT_INCOMPLETE", "Chiusura viaggio non completata, riprova");
    }
    await tripsCol.updateOne({ _id }, { $set: { settled: true, settlementStatus: "settled", updatedAt: new Date() } });
    audit("trip_settled_manual", { householdId: req.householdId, ip: clientIp(req), detail: { tripId: req.params.id } });
    res.json({ ok: true, settlements });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

router.delete("/api/trips/:id", writeLimiter, requireHousehold, requireRole("member"), async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return sendError(res, 400, "INVALID_ID", "ID non valido");
    const r = await tripsCol.deleteOne({ _id: new ObjectId(req.params.id), householdId: req.householdId });
    if (r.deletedCount === 0) return sendError(res, 404, "NOT_FOUND", "Non trovato");
    res.json({ deleted: true });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

// ─── Embedded array size guard (MOD-019, hardened) ───
// Trip expenses are embedded in the trip document — simple and fast for
// the normal case (a real trip's handful-to-low-hundreds of expenses).
// MongoDB's 16MB document limit and $push's document-rewrite cost mean
// that stops being appropriate at scale. Rather than migrate to a
// dedicated trip_expenses collection now (a real schema change, only
// worth it if any household actually approaches these numbers — the
// planned path if so), this is a cheap early-warning/hard-stop so a huge
// array can never silently creep up on the document limit unnoticed.
const TRIP_EXPENSE_WARN_THRESHOLD = 300;
const TRIP_EXPENSE_HARD_LIMIT = 2000;
function warnIfTripExpenseArrayGrowing(trip) {
  recordTripEmbeddingStats(trip, { warnThreshold: TRIP_EXPENSE_WARN_THRESHOLD }); // MOD-019: feeds GET /api/admin/metrics.tripEmbedding
  const count = (trip.expenses || []).length;
  if (count >= TRIP_EXPENSE_WARN_THRESHOLD && count % 100 === 0) {
    logger.warn("trip_expense_array_growing", { tripId: String(trip._id), count });
  }
}
// The hard limit is enforced as part of the SAME atomic operation as the
// push itself, via $expr checking the array's current size at write time —
// not as a separate read-then-decide step beforehand, which two concurrent
// requests both arriving near the limit could each pass before either had
// actually pushed, letting the array creep past the limit anyway.
async function pushTripExpenseIfUnderLimit(tripFilter, expense) {
  return tripsCol.updateOne(
    { ...tripFilter, $expr: { $lt: [{ $size: { $ifNull: ["$expenses", []] } }, TRIP_EXPENSE_HARD_LIMIT] } },
    { $push: { expenses: expense }, $set: { updatedAt: new Date() } }
  );
}

router.post("/api/trips/:id/expenses", writeLimiter, requireHousehold, requireRole("member"), async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return sendError(res, 400, "INVALID_ID", "ID non valido");
    const trip = await tripsCol.findOne({ _id: new ObjectId(req.params.id), householdId: req.householdId });
    if (!trip) return sendError(res, 404, "NOT_FOUND", "Viaggio non trovato");
    if (trip.settled) return sendError(res, 400, "TRIP_SETTLED", "Viaggio già chiuso");

    let expense;
    try {
      expense = buildTripExpense(req.body, trip, req.household.valutaBase || "EUR");
    } catch (ve) {
      if (ve instanceof ValidationError) return sendError(res, 400, ve.code, ve.message, ve.fields);
      throw ve;
    }
    warnIfTripExpenseArrayGrowing(trip);

    const result = await pushTripExpenseIfUnderLimit({ _id: new ObjectId(req.params.id), householdId: req.householdId }, expense);
    if (result.matchedCount === 0) {
      // The trip vanished between the read above and now (very unlikely),
      // or — the real case this guards against — it's at the hard limit,
      // checked atomically as part of this same update rather than before it.
      return sendError(res, 400, "TRIP_TOO_MANY_EXPENSES", "Questo viaggio ha raggiunto il numero massimo di spese registrabili; chiudilo o creane uno nuovo per continuare.", { count: (trip.expenses || []).length });
    }
    res.json(expense);
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

router.delete("/api/trips/:id/expenses/:expenseId", writeLimiter, requireHousehold, requireRole("member"), async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return sendError(res, 400, "INVALID_ID", "ID non valido");
    const trip = await tripsCol.findOne({ _id: new ObjectId(req.params.id), householdId: req.householdId });
    if (!trip) return sendError(res, 404, "NOT_FOUND", "Viaggio non trovato");
    if (trip.settled) return sendError(res, 400, "TRIP_SETTLED", "Viaggio già chiuso");
    
    await tripsCol.updateOne(
      { _id: new ObjectId(req.params.id), householdId: req.householdId },
      { $pull: { expenses: { id: req.params.expenseId } }, $set: { updatedAt: new Date() } }
    );
    res.json({ ok: true });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

// ─── Trip share links: let a guest outside the household join a single trip
// and log their own expenses, without ever handing out the household PIN.
// Token-gated like the widget key — capability URL, revocable, scoped to one trip. ───
router.post("/api/trips/:id/share", writeLimiter, requireHousehold, requireRole("admin"), async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return sendError(res, 400, "INVALID_ID", "ID non valido");
    const shareToken = randomBytes(24).toString("base64url");
    const r = await tripsCol.findOneAndUpdate(
      { _id: new ObjectId(req.params.id), householdId: req.householdId },
      { $set: { shareTokenHash: hashCapabilityToken(shareToken), shareTokenCreatedAt: new Date() }, $unset: { shareToken: "" } },
      { returnDocument: "after" }
    );
    if (!r) return sendError(res, 404, "NOT_FOUND", "Viaggio non trovato");
    audit("trip_share_created", { householdId: req.householdId, ip: clientIp(req) });
    res.json({ token: shareToken, expiresInDays: TRIP_SHARE_TOKEN_TTL_DAYS });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

router.delete("/api/trips/:id/share", writeLimiter, requireHousehold, requireRole("admin"), async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return sendError(res, 400, "INVALID_ID", "ID non valido");
    await tripsCol.updateOne(
      { _id: new ObjectId(req.params.id), householdId: req.householdId },
      { $unset: { shareToken: "", shareTokenHash: "", shareTokenCreatedAt: "" } }
    );
    audit("trip_share_revoked", { householdId: req.householdId, ip: clientIp(req) });
    res.json({ ok: true });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

const tripShareLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, message: { error: { code: "RATE_LIMITED", message: "Troppe richieste, riprova tra un minuto" } } });
const tripShareWriteLimiter = rateLimit({ windowMs: 60 * 1000, max: 15, standardHeaders: true, legacyHeaders: false, message: { error: { code: "RATE_LIMITED", message: "Troppe richieste, riprova tra un minuto" } } });

// MOD-011: trip share links expire — unlike the widget/calendar keys (meant
// to be long-lived "subscribe once" capability URLs by design), a trip is
// an inherently time-bound event, and a forgotten share link circulating
// long after the trip is over is a real residual-risk case with no
// legitimate use. 30 days comfortably covers "still settling up after the
// trip" while not lingering indefinitely.
const TRIP_SHARE_TOKEN_TTL_DAYS = 30;
const TRIP_SHARE_TOKEN_TTL_MS = TRIP_SHARE_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;
async function findTripByShareToken(token) {
  const trip = await findByCapabilityToken(tripsCol, "shareToken", token);
  if (!trip) return null;
  const createdAt = trip.shareTokenCreatedAt ? new Date(trip.shareTokenCreatedAt).getTime() : 0;
  if (!createdAt || Date.now() - createdAt > TRIP_SHARE_TOKEN_TTL_MS) return null; // expired: treated exactly like "not found"
  return trip;
}

// A share-link token proves "this caller may act on this trip" — it does
// NOT say which participant they are. Without a separate per-guest
// identity, any link holder could put any participant's id in `pagatoDa`
// and log expenses "paid by" someone else, corrupting settlement math.
// This token is issued once at join time, scoped to (tripId, personaId),
// and is what the expense endpoint trusts instead of the request body.
function signGuestTripToken(tripId, personaId) {
  return jwt.sign({ tripId, personaId }, JWT_SECRET, { expiresIn: `${TRIP_SHARE_TOKEN_TTL_DAYS}d` });
}
function verifyGuestTripToken(token, tripId) {
  if (!token || typeof token !== "string") return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
    if (payload.tripId !== tripId) return null; // scoped to the trip it was issued for — not reusable across trips
    return payload.personaId;
  } catch { return null; }
}

function stripTripForGuest(trip) {
  const id = trip._id.toString();
  return {
    id, nome: trip.nome, descrizione: trip.descrizione,
    startDate: trip.startDate, endDate: trip.endDate,
    partecipanti: trip.partecipanti, expenses: trip.expenses, settled: trip.settled,
  };
}

router.get("/api/trips/shared/:token", tripShareLimiter, async (req, res) => {
  try {
    const token = req.params.token;
    if (!token || token.length < 20) return sendError(res, 401, "INVALID_TOKEN", "Link non valido");
    const trip = await findTripByShareToken(token);
    if (!trip) return sendError(res, 404, "NOT_FOUND", "Link non valido, scaduto o revocato");
    res.json(stripTripForGuest(trip));
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

router.post("/api/trips/shared/:token/join", tripShareWriteLimiter, async (req, res) => {
  try {
    const token = req.params.token;
    if (!token || token.length < 20) return sendError(res, 401, "INVALID_TOKEN", "Link non valido");
    const trip = await findTripByShareToken(token);
    if (!trip) return sendError(res, 404, "NOT_FOUND", "Link non valido, scaduto o revocato");
    if (trip.settled) return sendError(res, 400, "TRIP_SETTLED", "Viaggio già chiuso");

    const nome = sanitizeText(req.body?.nome, 100);
    if (!nome) return sendError(res, 400, "MISSING_FIELDS", "Nome richiesto");
    const id = nome.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    if (!id) return sendError(res, 400, "INVALID_FIELD", "Nome non valido");

    const tripId = trip._id.toString();
    const esistente = (trip.partecipanti || []).find(p => p.id === id);
    if (esistente) return res.json({ ...esistente, guestToken: signGuestTripToken(tripId, esistente.id) }); // stesso nome già presente: rientra come lo stesso ospite

    const colors = ["#E17055", "#74B9FF", "#55EFC4", "#FDCB6E", "#A29BFE", "#FF7675", "#00CEC9"];
    const nuovo = { id, nome, emoji: "👤", colore: colors[(trip.partecipanti || []).length % colors.length] };
    await tripsCol.updateOne({ _id: trip._id }, { $push: { partecipanti: nuovo }, $set: { updatedAt: new Date() } });
    res.status(201).json({ ...nuovo, guestToken: signGuestTripToken(tripId, nuovo.id) });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

router.post("/api/trips/shared/:token/expenses", tripShareWriteLimiter, async (req, res) => {
  try {
    const token = req.params.token;
    if (!token || token.length < 20) return sendError(res, 401, "INVALID_TOKEN", "Link non valido");
    const trip = await findTripByShareToken(token);
    if (!trip) return sendError(res, 404, "NOT_FOUND", "Link non valido, scaduto o revocato");
    if (trip.settled) return sendError(res, 400, "TRIP_SETTLED", "Viaggio già chiuso");

    // The share token only proves "may access this trip" — it says nothing
    // about WHICH participant is calling. pagatoDa must come from the
    // per-guest token issued at join time, never from the request body,
    // or any link holder could log expenses "paid by" any other
    // participant and manipulate settlement math.
    const guestPersonaId = verifyGuestTripToken(req.body?.guestToken, trip._id.toString());
    if (!guestPersonaId) return sendError(res, 401, "GUEST_IDENTITY_REQUIRED", "Sessione ospite non valida: unisciti nuovamente al viaggio");

    // Guest requests aren't household-authenticated (no req.household), so
    // valutaBase has to be looked up from the trip's owning household —
    // trip expenses are always stored in that household's base currency.
    const owningHousehold = await householdsCol.findOne({ householdId: trip.householdId }, { projection: { valutaBase: 1 } });

    let expense;
    try {
      expense = buildTripExpense({ ...req.body, pagatoDa: guestPersonaId }, trip, owningHousehold?.valutaBase || "EUR");
    } catch (ve) {
      if (ve instanceof ValidationError) {
        // Friendlier message for the one case a guest is actually likely to
        // hit: trying to log an expense before joining the trip.
        const message = ve.code === "UNKNOWN_TRIP_PARTICIPANT"
          ? "Partecipante non valido: unisciti al viaggio prima di aggiungere una spesa"
          : ve.message;
        return sendError(res, 400, ve.code, message, ve.fields);
      }
      throw ve;
    }
    warnIfTripExpenseArrayGrowing(trip);

    const result = await pushTripExpenseIfUnderLimit({ _id: trip._id }, expense);
    if (result.matchedCount === 0) {
      return sendError(res, 400, "TRIP_TOO_MANY_EXPENSES", "Questo viaggio ha raggiunto il numero massimo di spese registrabili.", { count: (trip.expenses || []).length });
    }
    res.status(201).json(expense);
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

function sanitizePartecipanti(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return [];
  if (arr.length > 20) return [];
  return arr.map(p => {
    if (!p || typeof p !== "object") return null;
    return { id: sanitizeText(p.id, 50), nome: sanitizeText(p.nome, 100), emoji: p.emoji || "👤", colore: p.colore || "#888" };
  }).filter(Boolean);
}

export default router;
