import express from "express";
import rateLimit from "express-rate-limit";
import { ObjectId } from "mongodb";
import { roundAmount, toMinorUnits } from "../../src/lib/money.js";
import { ValidationError, validatePositiveNumber, validateEnum, POSITION_TIPI, validatePortfolioSnapshot } from "../validation.js";
import {
  sendError, requireHousehold, requireRole, writeLimiter, db, transactionsCol,
  idempotencyKeyFrom, claimIdempotencyKey, handleIdempotencyClaim, finalizeIdempotencyKey,
  isHouseholdAccount, sanitizeText, withTransaction, applyValutaTransazione,
  ConversionUnavailableError, quotesCol,
} from "../shared.js";

const router = express.Router();

const quotesLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5, // #4: 5 quote fetches/min — prevents Yahoo Finance hammering
  standardHeaders: true, legacyHeaders: false,
  message: { error: { code: "RATE_LIMITED", message: "Troppe richieste quotazioni, riprova tra un minuto" } },
});

// ─── Stock Positions ───
// Collection: positions { householdId, ticker, nome, quantita, prezzoAcquisto, dataAcquisto, valuta, note, createdAt }

// Portfolio is available to all authenticated households
function requirePortfolioAccess(req, res, next) {
  next();
}

// ─── Household-ownership guard (MOD-009) ───
// Reusable check for a client-supplied account id that must actually
// belong to the requesting household, not just be well-formed. Transaction
// participants and accounts already get this via validateTransactionInput
// (server/validation.js, MOD-001) — the gap this phase found and closes is
// goals' contoId, which was accepted from the client with no such check at
// all (see below). Trip participants are deliberately NOT checked against
// the household's participant list here: trips have their own, separate
// participant set that legitimately includes guests who joined via a share
// link and were never household members (see buildTripExpense in
// validation.js, which validates against trip.partecipanti instead).

// ─── Position <-> linked transaction (money moved to/from a tracked account) ───
// Buying/selling a position "from" a household account creates a matching
// expense/income transaction (categoria "investimenti") so the account's
// balance (calcolaSaldiConti, client + widget) reflects the cash actually
// leaving/entering it — otherwise a position would inflate net worth with
// no corresponding drop in the funding account. The transaction is a
// system-managed side effect of its position, not an independent user
// record: kept in sync (created/updated/deleted) by the position endpoints
// below and tagged with positionId, never edited on its own.
function positionTransactionFields(position, contoId) {
  const valuta = position.valuta || "EUR";
  const importo = roundAmount(position.quantita * position.prezzoAcquisto, valuta);
  return {
    householdId: position.householdId,
    tipo: position.tipo === "sell" ? "entrata" : "uscita",
    data: position.dataAcquisto,
    categoria: "investimenti",
    descrizione: sanitizeText(`${position.ticker} — portfolio`, 500),
    contoId,
    positionId: position._id.toString(),
    importo,
    importoMinorUnits: toMinorUnits(importo, valuta),
  };
}

// Creates or updates (in place, preserving its id) the transaction linked
// to `position`, converting into the household's base currency first if
// the position's own currency differs (same helper the real transaction
// endpoints use) — throws ConversionUnavailableError if that conversion
// can't be done right now, same as those endpoints. Returns the linked
// transaction's id.
async function upsertPositionTransaction(session, position, contoId, valutaBase) {
  const txDoc = positionTransactionFields(position, contoId);
  if (position.valuta && position.valuta !== valutaBase) {
    await applyValutaTransazione(txDoc, txDoc.importo, position.valuta, valutaBase);
  }
  if (position.linkedTransactionId && ObjectId.isValid(position.linkedTransactionId)) {
    await transactionsCol.updateOne(
      { _id: new ObjectId(position.linkedTransactionId), householdId: position.householdId },
      { $set: txDoc },
      { session }
    );
    return position.linkedTransactionId;
  }
  const txId = new ObjectId();
  await transactionsCol.insertOne({ _id: txId, ...txDoc, createdAt: new Date() }, { session });
  return txId.toString();
}

async function deletePositionTransaction(session, position) {
  if (!position.linkedTransactionId || !ObjectId.isValid(position.linkedTransactionId)) return;
  await transactionsCol.deleteOne({ _id: new ObjectId(position.linkedTransactionId), householdId: position.householdId }, { session });
}

router.get("/api/positions", requireHousehold, requirePortfolioAccess, async (req, res) => {
  try {
    const col = db.collection("positions");
    const docs = await col.find({ householdId: req.householdId }).sort({ dataAcquisto: -1 }).toArray();
    res.json(docs.map(d => { const id = d._id.toString(); delete d._id; delete d.householdId; return { id, ...d }; }));
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

router.post("/api/positions", writeLimiter, requireHousehold, requireRole("member"), requirePortfolioAccess, async (req, res) => {
  try {
    const idemKey = idempotencyKeyFrom(req);
    const claim = await claimIdempotencyKey(req.householdId, idemKey);
    if (handleIdempotencyClaim(claim, res)) return;

    const b = req.body;
    if (!b.ticker || !b.quantita || !b.prezzoAcquisto) return sendError(res, 400, "MISSING_FIELDS", "Campi obbligatori: ticker, quantita, prezzoAcquisto");
    const ticker = b.ticker.toUpperCase().trim();
    if (!/^[A-Z0-9.^=\-]{1,20}$/.test(ticker)) return sendError(res, 400, "INVALID_TICKER", "Ticker non valido (max 20 caratteri alfanumerici)");
    const valuta = b.valuta || "EUR";
    let quantita, prezzoAcquisto, tipo;
    try {
      quantita = validatePositiveNumber(b.quantita, "quantita"); // share count, not a currency amount — no precision rounding
      // Not validateAmount: that rounds to the currency's minor-unit
      // precision (2dp for EUR), which would silently truncate a
      // deliberately more-precise per-share price (e.g. crypto). Only the
      // finite+positive check is wanted here — same as before, just
      // enforced instead of letting NaN/Infinity through.
      prezzoAcquisto = validatePositiveNumber(b.prezzoAcquisto, "prezzoAcquisto");
      tipo = validateEnum(b.tipo || "buy", POSITION_TIPI, "tipo");
    } catch (ve) {
      if (ve instanceof ValidationError) return sendError(res, 400, ve.code, ve.message, ve.fields);
      throw ve;
    }
    let contoId = null;
    if (b.contoId) {
      if (!(await isHouseholdAccount(b.contoId, req.householdId))) return sendError(res, 400, "UNKNOWN_ACCOUNT", "Conto non valido", { contoId: b.contoId });
      contoId = b.contoId;
    }
    const doc = {
      _id: new ObjectId(),
      householdId: req.householdId,
      ticker,
      nome: sanitizeText(b.nome || ticker, 100),
      quantita,
      prezzoAcquisto,
      prezzoAcquistoMinorUnits: toMinorUnits(prezzoAcquisto, valuta), // MOD-016
      dataAcquisto: b.dataAcquisto || new Date().toISOString().slice(0, 10),
      valuta,
      note: sanitizeText(b.note, 500),
      tipo,
      contoId,
      createdAt: new Date(),
    };
    try {
      if (contoId) {
        await withTransaction(async (session) => {
          doc.linkedTransactionId = await upsertPositionTransaction(session, doc, contoId, req.household.valutaBase || "EUR");
          await db.collection("positions").insertOne(doc, { session });
        });
      } else {
        await db.collection("positions").insertOne(doc);
      }
    } catch (ce) {
      if (ce instanceof ConversionUnavailableError) {
        return res.status(422).json({ error: { code: "EXCHANGE_RATE_UNAVAILABLE", message: "Cambio valuta non disponibile al momento, riprova più tardi." } });
      }
      throw ce;
    }
    const id = doc._id.toString(); delete doc._id; delete doc.householdId;
    const responseBody = { id, ...doc };
    await finalizeIdempotencyKey(req.householdId, idemKey, 201, responseBody);
    res.status(201).json(responseBody);
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

// ─── Manual price overrides (stored in quotes_cache, scoped by householdId) ───
router.get("/api/positions/prices", requireHousehold, async (req, res) => {
  try {
    const docs = await quotesCol.find({ householdId: req.householdId, manualPrice: { $exists: true } }).toArray();
    const manualPrices = {};
    for (const d of docs) manualPrices[d.ticker] = d.manualPrice;
    res.json({ manualPrices });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

const MANUAL_PRICE_TICKER_RE = /^[A-Z0-9.^=\-]{1,20}$/;

// Incremental upsert — only sets/updates the tickers present in the
// request body, never touches any other ticker's existing manual price.
// Previously this deleted every manual price for the household first and
// re-inserted only what was in THIS request's payload, which silently
// wiped out manual prices for any ticker missing from it — e.g. a second
// household member (or the same client, if its initial GET was still in
// flight or had failed) saving a price for one ticker would erase every
// other ticker's manual override with no error shown anywhere. Clearing a
// ticker's override is now DELETE /api/positions/prices/:ticker instead
// of "omit it from the next PUT".
//
// Deliberately NOT wrapped in withTransaction (unlike the old delete-then-
// recreate version, which genuinely needed all-or-nothing semantics to
// avoid a crash wiping every price and restoring none): each ticker is now
// an independent upsert, already atomic on its own — a failure partway
// through a multi-ticker request just leaves whichever tickers were
// already upserted in place, which is a fine, recoverable outcome, not a
// data-loss one. This also means saving a manual price no longer needs
// the target MongoDB to support multi-document transactions (a replica
// set) — plain standalone MongoDB works too, same as every other read/
// write in this route file.
router.put("/api/positions/prices", requireHousehold, requireRole("member"), async (req, res) => {
  try {
    const { manualPrices } = req.body || {};
    if (typeof manualPrices !== "object" || manualPrices === null || Array.isArray(manualPrices))
      return sendError(res, 400, "INVALID_MANUAL_PRICES", "manualPrices deve essere un oggetto");
    const entries = Object.entries(manualPrices);
    if (entries.length > 200)
      return sendError(res, 400, "TOO_MANY_PRICES", "Massimo 200 prezzi manuali per richiesta");
    for (const [rawTicker, rawPrice] of entries) {
      const ticker = String(rawTicker).toUpperCase().trim();
      if (!MANUAL_PRICE_TICKER_RE.test(ticker)) continue; // skip malformed keys
      const price = typeof rawPrice === "number" ? rawPrice : parseFloat(rawPrice);
      if (!Number.isFinite(price) || price < 0) continue; // skip non-numeric or negative
      // eslint-disable-next-line no-await-in-loop
      await quotesCol.updateOne(
        { ticker, householdId: req.householdId },
        { $set: { ticker, householdId: req.householdId, manualPrice: price, updatedAt: new Date() } },
        { upsert: true }
      );
    }
    res.json({ ok: true });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

router.delete("/api/positions/prices/:ticker", requireHousehold, requireRole("member"), async (req, res) => {
  try {
    const ticker = String(req.params.ticker).toUpperCase().trim();
    if (!MANUAL_PRICE_TICKER_RE.test(ticker)) return sendError(res, 400, "INVALID_TICKER", "Ticker non valido");
    await quotesCol.deleteOne({ ticker, householdId: req.householdId, manualPrice: { $exists: true } });
    res.json({ ok: true });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

router.put("/api/positions/:id", writeLimiter, requireHousehold, requireRole("member"), requirePortfolioAccess, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return sendError(res, 400, "INVALID_ID", "ID non valido");
    const existing = await db.collection("positions").findOne({ _id: new ObjectId(req.params.id), householdId: req.householdId });
    if (!existing) return sendError(res, 404, "NOT_FOUND", "Non trovata");

    const b = req.body;
    const update = {};
    try {
      if (b.ticker !== undefined) {
        const ticker = String(b.ticker).toUpperCase().trim();
        if (!/^[A-Z0-9.^=\-]{1,20}$/.test(ticker)) return sendError(res, 400, "INVALID_TICKER", "Ticker non valido (max 20 caratteri alfanumerici)");
        update.ticker = ticker;
      }
      if (b.nome !== undefined) update.nome = sanitizeText(b.nome, 100);
      if (b.quantita !== undefined) update.quantita = validatePositiveNumber(b.quantita, "quantita");
      if (b.prezzoAcquisto !== undefined) {
        update.prezzoAcquisto = validatePositiveNumber(b.prezzoAcquisto, "prezzoAcquisto");
        update.prezzoAcquistoMinorUnits = toMinorUnits(update.prezzoAcquisto, existing.valuta || "EUR"); // MOD-016
      }
      if (b.dataAcquisto !== undefined) update.dataAcquisto = b.dataAcquisto;
      if (b.note !== undefined) update.note = sanitizeText(b.note, 500);
      if (b.tipo !== undefined) update.tipo = validateEnum(b.tipo, POSITION_TIPI, "tipo");
    } catch (ve) {
      if (ve instanceof ValidationError) return sendError(res, 400, ve.code, ve.message, ve.fields);
      throw ve;
    }

    let newContoId = existing.contoId ?? null;
    if (b.contoId !== undefined) {
      if (b.contoId) {
        if (!(await isHouseholdAccount(b.contoId, req.householdId))) return sendError(res, 400, "UNKNOWN_ACCOUNT", "Conto non valido", { contoId: b.contoId });
        newContoId = b.contoId;
      } else {
        newContoId = null;
      }
      update.contoId = newContoId;
    }

    if (Object.keys(update).length === 0) return sendError(res, 400, "NO_FIELDS_TO_UPDATE", "Nessun campo da aggiornare");
    update.updatedAt = new Date();

    // Keep the linked transaction (if any is involved) in sync with
    // whatever changed here — otherwise its amount/date/ticker/account
    // would silently drift from the position it's meant to mirror.
    const linkedFieldsTouched = ["ticker", "quantita", "prezzoAcquisto", "dataAcquisto", "tipo", "contoId"].some(k => update[k] !== undefined);
    try {
      if (linkedFieldsTouched && (newContoId || existing.linkedTransactionId)) {
        const merged = { ...existing, ...update };
        await withTransaction(async (session) => {
          const setOp = { ...update };
          const unsetOp = {};
          if (newContoId) {
            setOp.linkedTransactionId = await upsertPositionTransaction(session, merged, newContoId, req.household.valutaBase || "EUR");
          } else if (existing.linkedTransactionId) {
            await deletePositionTransaction(session, existing);
            unsetOp.linkedTransactionId = "";
          }
          const mongoUpdate = { $set: setOp };
          if (Object.keys(unsetOp).length > 0) mongoUpdate.$unset = unsetOp;
          await db.collection("positions").updateOne({ _id: existing._id, householdId: req.householdId }, mongoUpdate, { session });
        });
      } else {
        await db.collection("positions").updateOne({ _id: existing._id, householdId: req.householdId }, { $set: update });
      }
    } catch (ce) {
      if (ce instanceof ConversionUnavailableError) {
        return res.status(422).json({ error: { code: "EXCHANGE_RATE_UNAVAILABLE", message: "Cambio valuta non disponibile al momento, riprova più tardi." } });
      }
      throw ce;
    }
    res.json({ ok: true });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

router.delete("/api/positions/:id", requireHousehold, requireRole("member"), requirePortfolioAccess, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return sendError(res, 400, "INVALID_ID", "ID non valido");
    const existing = await db.collection("positions").findOne({ _id: new ObjectId(req.params.id), householdId: req.householdId });
    if (!existing) return sendError(res, 404, "NOT_FOUND", "Non trovata");
    if (existing.linkedTransactionId) {
      // Deleting a position that funded itself from an account must also
      // remove the linked transaction — otherwise the account balance
      // stays permanently down by the purchase amount with nothing left
      // to explain why.
      await withTransaction(async (session) => {
        await deletePositionTransaction(session, existing);
        await db.collection("positions").deleteOne({ _id: existing._id, householdId: req.householdId }, { session });
      });
    } else {
      await db.collection("positions").deleteOne({ _id: existing._id, householdId: req.householdId });
    }
    res.json({ deleted: true, id: req.params.id });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

// ─── Live stock/ETF/crypto quotes (Yahoo Finance, best-effort) ───
// Global cache (no householdId — same ticker means same price for everyone)
// with a 24h TTL, per README. A ticker Yahoo can't resolve, or a request
// that fails outright, is simply omitted from the response — the client
// already falls back to the manual price / cost basis for anything missing,
// so a flaky upstream degrades gracefully instead of erroring the request.
const QUOTE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const QUOTE_TICKER_RE = /^[A-Z0-9.^=\-]{1,20}$/;

async function fetchYahooQuoteRaw(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(8000),
    headers: { "User-Agent": "Mozilla/5.0 (compatible; BalanceTracker/1.0)" },
  });
  if (!res.ok) {
    // Swallowed by the caller either way (a flaky quote must never break
    // the request), but log the real status — Yahoo's unofficial endpoint
    // is known to 401/429 server-to-server callers, which reads from the
    // client as an identical "unresolved ticker" to a plain 404.
    console.error(`[quotes] Yahoo ${symbol} -> HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
    return null;
  }
  const data = await res.json();
  const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
  if (price == null) console.error(`[quotes] Yahoo ${symbol} -> 200 OK but no regularMarketPrice: ${JSON.stringify(data?.chart?.error || data).slice(0, 200)}`);
  return typeof price === "number" && Number.isFinite(price) ? price : null;
}

// A bare alphanumeric ticker (no exchange suffix, no crypto/forex/index
// syntax already in it) is ambiguous: this Italian-first app's common
// case is a Borsa Italiana-listed ETF entered by its plain ticker (VWCE,
// not VWCE.MI), but some of those bare tickers *also* happen to be real,
// resolvable US-market symbols for a completely unrelated instrument
// (UST is a Milan-listed Nasdaq-100 tracker here, but also a real US
// Treasury-bond ETF on Yahoo's US market) — silently wrong is worse than
// silently missing, so try .MI first and only fall back to the bare
// ticker if Milan doesn't have it.
async function fetchYahooQuote(ticker) {
  if (/^[A-Z0-9]{1,10}$/.test(ticker)) {
    const milan = await fetchYahooQuoteRaw(`${ticker}.MI`);
    if (milan != null) return milan;
  }
  return await fetchYahooQuoteRaw(ticker);
}

router.get("/api/quotes", quotesLimiter, requireHousehold, async (req, res) => {
  try {
    const tickers = [...new Set(String(req.query.tickers || "").split(",").map(t => t.trim().toUpperCase()).filter(Boolean))]
      .filter(t => QUOTE_TICKER_RE.test(t))
      .slice(0, 30); // generous cap; well past any real portfolio's ticker count
    if (tickers.length === 0) return res.json({ quotes: {} });

    // force=1 skips the cache read and re-fetches every requested ticker —
    // still subject to quotesLimiter, so it can't be used to hammer Yahoo
    // any faster than a normal page load could.
    const force = req.query.force === "1" || req.query.force === "true";
    const now = Date.now();
    const cached = force ? [] : await quotesCol.find({ ticker: { $in: tickers }, householdId: { $exists: false } }).toArray();
    const cacheByTicker = new Map(cached.map(d => [d.ticker, d]));

    const quotes = {};
    const toFetch = [];
    for (const ticker of tickers) {
      const c = cacheByTicker.get(ticker);
      if (c && typeof c.autoPrice === "number" && now - new Date(c.fetchedAt).getTime() < QUOTE_CACHE_TTL_MS) {
        quotes[ticker] = c.autoPrice;
      } else {
        toFetch.push(ticker);
      }
    }

    await Promise.all(toFetch.map(async (ticker) => {
      try {
        const price = await fetchYahooQuote(ticker);
        if (price == null) return;
        quotes[ticker] = price;
        await quotesCol.updateOne(
          { ticker, householdId: { $exists: false } },
          { $set: { ticker, autoPrice: price, fetchedAt: new Date() } },
          { upsert: true }
        );
      } catch (e) {
        // A thrown fetch() (DNS failure, connection refused, our own
        // AbortSignal timeout) never reaches fetchYahooQuoteRaw's status
        // logging — log it here so a fully-unreachable Yahoo doesn't look
        // identical to "no log line at all" in Render's logs.
        console.error(`[quotes] ${ticker} -> fetch threw: ${e?.name || "Error"}: ${e?.message || e}`);
      }
    }));

    res.json({ quotes });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

// ─── Weekly portfolio snapshots ───
// Collection: portfolio_snapshots { householdId, weekKey, date, valore,
// valoreMinorUnits, investito, investitoMinorUnits, holdings: [{ ticker,
// quantita, prezzo }], createdAt }. The chart plots these real points.
// weekKey (the Sunday that starts the week) is unique per household and
// FIRST WINS: the client saves on the first price refresh of each week, a
// later one the same week (or the same refresh sent twice, or from another
// device) is a no-op rather than an overwrite.
router.get("/api/portfolio/snapshots", requireHousehold, requirePortfolioAccess, async (req, res) => {
  try {
    const docs = await db.collection("portfolio_snapshots")
      .find({ householdId: req.householdId }, { projection: { _id: 0, householdId: 0, valoreMinorUnits: 0, investitoMinorUnits: 0 } })
      .sort({ date: 1 }).limit(2000).toArray();
    res.json(docs);
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

router.post("/api/portfolio/snapshots", writeLimiter, requireHousehold, requireRole("member"), requirePortfolioAccess, async (req, res) => {
  try {
    const valuta = req.household.valutaBase || "EUR";
    let snap;
    try { snap = validatePortfolioSnapshot(req.body, { currency: valuta }); }
    catch (ve) {
      if (ve instanceof ValidationError) return sendError(res, 400, ve.code, ve.message, ve.fields);
      throw ve;
    }
    const doc = {
      ...snap,
      valoreMinorUnits: toMinorUnits(snap.valore, valuta), // MOD-016
      investitoMinorUnits: toMinorUnits(snap.investito, valuta),
      createdAt: new Date(),
    };
    const r = await db.collection("portfolio_snapshots").updateOne(
      { householdId: req.householdId, weekKey: snap.weekKey },
      { $setOnInsert: { householdId: req.householdId, ...doc } },
      { upsert: true }
    );
    const created = r.upsertedCount === 1;
    res.status(created ? 201 : 200).json({ created, weekKey: snap.weekKey });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

export default router;
