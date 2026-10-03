import express from "express";
import rateLimit from "express-rate-limit";
import { ObjectId } from "mongodb";
import {
  validateTransactionInput, ValidationError, decodeTransactionsCursor,
  encodeTransactionsCursor, TRANSACTION_TYPES, isPlainId,
} from "../validation.js";
import {
  sendError, requireHousehold, requireRole, writeLimiter, db, transactionsCol,
  sanitizeText, idempotencyKeyFrom, claimIdempotencyKey, handleIdempotencyClaim,
  finalizeIdempotencyKey, applyValutaTransazione, ConversionUnavailableError,
  generaRicorrentiDovute,
} from "../shared.js";

const router = express.Router();


// MOD-006: cursor pagination (see GET /api/transactions) means each request
// is now a bounded, cheap query instead of one unbounded dump, so a more
// generous limit is appropriate here than it was for the old single-shot
// endpoint — a full-history drain for an active household can take several
// requests in quick succession, and that's now the *normal* case, not abuse.
const exportLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true, legacyHeaders: false,
  message: { error: { code: "RATE_LIMITED", message: "Troppe richieste, riprova tra un minuto" } },
});

// ─── GET transactions ───
// MOD-006: cursor pagination on (data desc, _id desc) — the same sort the
// app has always used. The cursor encodes exactly where the previous page
// stopped (date + id, not just an offset), so pages stay stable and gap-
// free even with many transactions sharing the same date, and even if
// transactions are inserted/deleted between page requests. Response shape
// is { transactions, nextCursor, hasMore } rather than a bare array; the
// only caller (src/api.js fetchTransactions) drains every page to build
// its full local cache, so callers elsewhere never see a silently-
// truncated history the way the old hardcoded 500-record cap allowed.
const TRANSACTIONS_PAGE_SIZE_DEFAULT = 1000;
const TRANSACTIONS_PAGE_SIZE_MAX = 2000;

router.get("/api/transactions", exportLimiter, requireHousehold, async (req, res) => {
  try {
    const { tipo, categoria, pagatoDa, contoId, meseAnno, from, to, cursor } = req.query;
    const filter = { householdId: req.householdId, deletedAt: null };
    if (tipo) {
      if (typeof tipo !== "string" || !TRANSACTION_TYPES.includes(tipo)) return sendError(res, 400, "INVALID_FIELD", "Tipo non valido");
      filter.tipo = tipo;
    }
    if (categoria) {
      if (typeof categoria !== "string") return sendError(res, 400, "INVALID_FIELD", "Categoria non valida");
      filter.categoria = sanitizeText(categoria, 50);
    }
    if (pagatoDa) {
      if (!isPlainId(pagatoDa)) return sendError(res, 400, "INVALID_FIELD", "pagatoDa non valido");
      filter.pagatoDa = pagatoDa;
    }
    if (meseAnno) {
      if (typeof meseAnno !== "string" || !/^\d{4}-\d{2}$/.test(meseAnno)) return sendError(res, 400, "INVALID_FIELD", "meseAnno non valido");
      const [a, m] = meseAnno.split("-").map(Number);
      filter.data = { $gte: new Date(a, m - 1, 1).toISOString().slice(0, 10), $lte: new Date(a, m, 0).toISOString().slice(0, 10) };
    } else {
      const dataRange = {};
      if (typeof from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(from)) dataRange.$gte = from;
      if (typeof to === "string" && /^\d{4}-\d{2}-\d{2}$/.test(to)) dataRange.$lte = to;
      if (Object.keys(dataRange).length > 0) filter.data = dataRange;
    }

    // Both an account filter and a cursor need their own $or clause; combine
    // via $and rather than two top-level $or keys (which MongoDB — and JS
    // object literals — can't express, the second would just clobber the first).
    const andClauses = [];
    if (contoId) {
      if (!isPlainId(contoId)) return sendError(res, 400, "INVALID_FIELD", "contoId non valido");
      andClauses.push({ $or: [{ contoId }, { contoDa: contoId }, { contoA: contoId }] });
    }
    if (cursor) {
      const decoded = decodeTransactionsCursor(cursor);
      if (!decoded) return sendError(res, 400, "INVALID_CURSOR", "Cursore di paginazione non valido");
      andClauses.push({ $or: [
        { data: { $lt: decoded.data } },
        { data: decoded.data, _id: { $lt: new ObjectId(decoded.id) } },
      ] });
    }
    if (andClauses.length > 0) filter.$and = andClauses;

    let limit = parseInt(req.query.limit) || TRANSACTIONS_PAGE_SIZE_DEFAULT;
    limit = Math.min(Math.max(limit, 1), TRANSACTIONS_PAGE_SIZE_MAX);

    // Fetch one extra row purely to learn whether there's a next page,
    // without a separate count query.
    const docs = await transactionsCol.find(filter).sort({ data: -1, _id: -1 }).limit(limit + 1).toArray();
    const hasMore = docs.length > limit;
    const page = hasMore ? docs.slice(0, limit) : docs;
    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? encodeTransactionsCursor(last.data, last._id.toString()) : null;

    res.json({
      transactions: page.map(d => { const id = d._id.toString(); delete d._id; delete d.householdId; return { id, ...d }; }),
      nextCursor,
      hasMore,
    });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

// ─── POST transaction ───
// Validation flows through the centralized validateTransactionInput
// (MOD-001, MOD-002) so this endpoint, the PUT below, and widget-created
// transactions all reject the same malformed/out-of-household input instead
// of trusting client-provided relationships. Idempotency-Key support
// (MOD-004) means a retried request can't create a duplicate transaction.
router.post("/api/transactions", writeLimiter, requireHousehold, requireRole("member"), async (req, res) => {
  try {
    const idemKey = idempotencyKeyFrom(req);
    const claim = await claimIdempotencyKey(req.householdId, idemKey);
    if (handleIdempotencyClaim(claim, res)) return;

    const b = req.body || {};
    const householdPersonIds = (req.household.persone || []).map(p => p.id);
    const accountDocs = await db.collection("accounts").find({ householdId: req.householdId }, { projection: { _id: 1 } }).toArray();
    const accountIds = new Set(accountDocs.map(a => a._id.toString()));

    let validated;
    try {
      validated = validateTransactionInput(b, { householdPersonIds, accountIds, valutaBase: req.household.valutaBase || "EUR" });
    } catch (ve) {
      if (ve instanceof ValidationError) return res.status(400).json({ error: { code: ve.code, message: ve.message, fields: ve.fields } });
      throw ve;
    }

    const doc = { householdId: req.householdId, ...validated, createdAt: new Date() };
    // Optional client-generated id, echoed back so a future offline queue
    // (MOD-003) can correlate a locally-created transaction with its server
    // copy without guessing.
    if (typeof b.clientId === "string" && b.clientId.trim()) doc.clientId = sanitizeText(b.clientId, 60);

    if (b.valuta) {
      try {
        await applyValutaTransazione(doc, doc.importo, b.valuta, req.household.valutaBase);
      } catch (ce) {
        if (ce instanceof ConversionUnavailableError) {
          return res.status(422).json({ error: { code: "EXCHANGE_RATE_UNAVAILABLE", message: "Cambio valuta non disponibile al momento, riprova più tardi." } });
        }
        throw ce;
      }
    }

    const result = await transactionsCol.insertOne(doc);
    const id = result.insertedId.toString();
    delete doc.householdId;
    const responseBody = { id, ...doc };
    await finalizeIdempotencyKey(req.householdId, idemKey, 201, responseBody);
    res.status(201).json(responseBody);
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

// ─── DELETE transaction (soft delete — moves to trash, purged after 30 days) ───
router.delete("/api/transactions/:id", writeLimiter, requireHousehold, requireRole("member"), async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return sendError(res, 400, "INVALID_ID", "ID non valido");
    const r = await transactionsCol.findOneAndUpdate(
      { _id: new ObjectId(req.params.id), householdId: req.householdId, deletedAt: null },
      { $set: { deletedAt: new Date() } }
    );
    if (!r) return sendError(res, 404, "NOT_FOUND", "Non trovata");
    res.json({ deleted: true, id: req.params.id });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

// ─── Trash (soft-deleted transactions) ───
router.get("/api/transactions/trash", requireHousehold, async (req, res) => {
  try {
    const docs = await transactionsCol.find({ householdId: req.householdId, deletedAt: { $ne: null } })
      .sort({ deletedAt: -1 }).toArray();
    res.json(docs.map(d => { const id = d._id.toString(); delete d._id; delete d.householdId; return { id, ...d }; }));
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

router.post("/api/transactions/:id/restore", writeLimiter, requireHousehold, requireRole("member"), async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return sendError(res, 400, "INVALID_ID", "ID non valido");
    const result = await transactionsCol.findOneAndUpdate(
      { _id: new ObjectId(req.params.id), householdId: req.householdId, deletedAt: { $ne: null } },
      { $unset: { deletedAt: "" } }, { returnDocument: "after" }
    );
    if (!result) return sendError(res, 404, "NOT_FOUND", "Non trovata nel cestino");
    const id = result._id.toString(); delete result._id; delete result.householdId;
    res.json({ id, ...result });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

router.delete("/api/transactions/:id/permanent", writeLimiter, requireHousehold, requireRole("member"), async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return sendError(res, 400, "INVALID_ID", "ID non valido");
    const r = await transactionsCol.deleteOne({ _id: new ObjectId(req.params.id), householdId: req.householdId, deletedAt: { $ne: null } });
    if (r.deletedCount === 0) return sendError(res, 404, "NOT_FOUND", "Non trovata nel cestino");
    res.json({ deleted: true, id: req.params.id });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

router.delete("/api/transactions/trash/empty", writeLimiter, requireHousehold, requireRole("member"), async (req, res) => {
  try {
    const r = await transactionsCol.deleteMany({ householdId: req.householdId, deletedAt: { $ne: null } });
    res.json({ deleted: r.deletedCount });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

// ─── PUT transaction ───
// Same centralized validator as POST, run in partial mode: only fields
// present in the request body are validated/returned, but cross-field rules
// (transfer accounts, split participants) still see the full picture via
// the existing document (MOD-001, MOD-002).
router.put("/api/transactions/:id", writeLimiter, requireHousehold, requireRole("member"), async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return sendError(res, 400, "INVALID_ID", "ID non valido");
    const existing = await transactionsCol.findOne({ _id: new ObjectId(req.params.id), householdId: req.householdId });
    if (!existing) return sendError(res, 404, "NOT_FOUND", "Non trovata");

    const householdPersonIds = (req.household.persone || []).map(p => p.id);
    const accountDocs = await db.collection("accounts").find({ householdId: req.householdId }, { projection: { _id: 1 } }).toArray();
    const accountIds = new Set(accountDocs.map(a => a._id.toString()));

    let update;
    try {
      update = validateTransactionInput(req.body, { householdPersonIds, accountIds, partial: true, existing, valutaBase: req.household.valutaBase || "EUR" });
    } catch (ve) {
      if (ve instanceof ValidationError) return res.status(400).json({ error: { code: ve.code, message: ve.message, fields: ve.fields } });
      throw ve;
    }

    const unset = {};
    if (req.body.valuta !== undefined && update.importo !== undefined) {
      if (req.body.valuta) {
        try {
          await applyValutaTransazione(update, update.importo, req.body.valuta, req.household.valutaBase);
        } catch (ce) {
          if (ce instanceof ConversionUnavailableError) {
            return res.status(422).json({ error: { code: "EXCHANGE_RATE_UNAVAILABLE", message: "Cambio valuta non disponibile al momento, riprova più tardi." } });
          }
          throw ce;
        }
      } else {
        unset.valuta = ""; unset.importoOriginale = ""; unset.importoOriginaleMinorUnits = ""; unset.tassoCambio = ""; unset.tassoCambioObsoleto = "";
      }
    } else if (req.body.valuta === undefined && update.importo !== undefined && existing.valuta) {
      // Amount-only edit of a transaction that currently has foreign-
      // currency metadata (valuta/importoOriginale/tassoCambio). The edit
      // UI (TransactionRow.jsx) always initializes its amount field from
      // importo — the BASE-currency figure — and never exposes valuta at
      // all, so a request shaped exactly like this is what every edit of
      // an FX transaction sends today. Treating the new number as still
      // "the same foreign amount, unconverted" would leave importoOriginale
      // and tassoCambio describing a DIFFERENT amount than the one just
      // saved — an internally contradictory record. The new number was
      // entered directly in the base currency, same as any other
      // transaction, so it stops being an FX record: clear the stale
      // conversion metadata rather than leave it mismatched.
      unset.valuta = ""; unset.importoOriginale = ""; unset.importoOriginaleMinorUnits = ""; unset.tassoCambio = ""; unset.tassoCambioObsoleto = "";
    }
    update.updatedAt = new Date();
    const setOp = { $set: update };
    if (Object.keys(unset).length) setOp.$unset = unset;
    const result = await transactionsCol.findOneAndUpdate(
      { _id: new ObjectId(req.params.id), householdId: req.householdId },
      setOp, { returnDocument: "after" }
    );
    if (!result) return sendError(res, 404, "NOT_FOUND", "Non trovata");
    const id = result._id.toString(); delete result._id; delete result.householdId;
    res.json({ id, ...result });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

// ─── Trigger the recurring-transactions job immediately ───
// The job itself (generaRicorrentiDovute, above) already runs on server
// startup and every RICORRENTI_CHECK_MS, and is safe to call as often as
// you like: an in-process flag (ricorrentiRunning) skips overlapping runs,
// and the unique index on recurrenceOccurrenceKey means a race between two
// calls (or two servers) can insert the SAME occurrence at most once — the
// loser just gets a duplicate-key error it treats as "already generated".
// This endpoint exists so the app can ask for a due "Affitto"-style
// transaction to appear right away on open, instead of waiting up to 6h for
// the next tick — WITHOUT the client generating the occurrence itself
// (that used to happen in App.jsx and had no such protection: two devices,
// or the same device reloading twice in a row, could each create their own
// copy of the same occurrence. Route everything through this one
// dedup-protected path instead.)
router.post("/api/recurring/run", writeLimiter, requireHousehold, async (req, res) => {
  try {
    await generaRicorrentiDovute();
    res.json({ ok: true });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

export default router;
