import express from "express";
import rateLimit from "express-rate-limit";
import { randomBytes } from "crypto";
import { ObjectId } from "mongodb";
import { roundAmount, sumAmounts, toMinorUnits } from "../../src/lib/money.js";
import { validateAmount, validateDateStr, computeValidSplits } from "../validation.js";
import {
  sendError, requireHousehold, requireRole, writeLimiter, db, transactionsCol,
  quotesCol, householdsCol, auditCol, hashCapabilityToken, findByCapabilityToken,
  sanitizePersone, sanitizeText, idempotencyKeyFrom, claimIdempotencyKey,
  handleIdempotencyClaim, finalizeIdempotencyKey,
} from "../shared.js";

const router = express.Router();


// Rispecchia le categorie di default del client, usate dal widget quando la
// casa non ha personalizzato le proprie.
const WIDGET_DEFAULT_CATEGORIE = [
  { id: "cibo", nome: "Cibo", emoji: "🍕" },
  { id: "trasporti", nome: "Trasporti", emoji: "🚗" },
  { id: "casa", nome: "Casa", emoji: "🏠" },
  { id: "salute", nome: "Salute", emoji: "💊" },
  { id: "svago", nome: "Svago", emoji: "🎮" },
  { id: "shopping", nome: "Shopping", emoji: "🛍️" },
  { id: "bollette", nome: "Bollette", emoji: "💡" },
  { id: "altro", nome: "Altro", emoji: "📦" },
];

// ─── Widget iPhone: chiave dedicata + endpoint read-only ───
// La chiave permette a un widget (es. Scriptable) di leggere un riassunto dei
// dati senza login interattivo. È revocabile e dà accesso in sola lettura a
// numeri aggregati, mai a operazioni di scrittura.
router.post("/api/widget-key", writeLimiter, requireHousehold, requireRole("admin"), async (req, res) => {
  try {
    const key = randomBytes(24).toString("base64url");
    // MOD-011: store only the hash — the plaintext key exists only in this
    // response, shown to the person once, never persisted server-side.
    await householdsCol.updateOne({ householdId: req.householdId }, { $set: { widgetKeyHash: hashCapabilityToken(key), widgetKeyCreatedAt: new Date() }, $unset: { widgetKey: "" } });
    await auditCol.insertOne({ householdId: req.householdId, action: "widget_key_created", at: new Date() });
    res.json({ key });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

router.delete("/api/widget-key", writeLimiter, requireHousehold, requireRole("admin"), async (req, res) => {
  try {
    await householdsCol.updateOne({ householdId: req.householdId }, { $unset: { widgetKey: "", widgetKeyHash: "", widgetKeyCreatedAt: "" } });
    await auditCol.insertOne({ householdId: req.householdId, action: "widget_key_revoked", at: new Date() });
    res.json({ ok: true });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

const widgetLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, message: { error: { code: "RATE_LIMITED", message: "Troppe richieste, riprova tra un minuto" } } });
router.get("/api/widget", widgetLimiter, async (req, res) => {
  try {
    const key = req.query.key;
    if (!key || typeof key !== "string" || key.length < 20) return sendError(res, 401, "MISSING_KEY", "Chiave mancante");
    const household = await findByCapabilityToken(householdsCol, "widgetKey", key);
    if (!household) return sendError(res, 401, "INVALID_KEY", "Chiave non valida");
    const hid = household.householdId;

    // MOD-020: this endpoint is meant to be polled frequently (a phone
    // home-screen widget refreshing every so often) and only ever returns
    // small aggregate numbers — it used to compute those by loading the
    // household's ENTIRE transaction history into Node memory on every
    // single call. Account balances and this-month totals are now computed
    // server-side via a single aggregation pipeline instead; the response
    // shape is unchanged, only how it's computed.
    const now = new Date();
    const meseKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const monthStart = `${meseKey}-01`;
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString().slice(0, 10);

    const [accounts, positions, priceDocs, [agg]] = await Promise.all([
      db.collection("accounts").find({ householdId: hid }).toArray(),
      db.collection("positions").find({ householdId: hid }).toArray(),
      quotesCol.find({ householdId: hid, manualPrice: { $exists: true } }).toArray(),
      transactionsCol.aggregate([
        { $match: { householdId: hid, deletedAt: null } },
        {
          $facet: {
            // Net delta per account across ALL history — same rule as
            // before: transfers move money between contoDa/contoA,
            // entrata/uscita move it in/out of contoId. Accounts that no
            // longer exist are filtered out afterward (below), same as
            // the original JS version silently ignored them.
            balances: [
              { $project: { entries: { $switch: {
                branches: [
                  { case: { $eq: ["$tipo", "trasferimento"] }, then: [
                    { conto: "$contoDa", delta: { $multiply: ["$importo", -1] } },
                    { conto: "$contoA", delta: "$importo" },
                  ] },
                  { case: { $eq: ["$tipo", "entrata"] }, then: [{ conto: "$contoId", delta: "$importo" }] },
                  { case: { $eq: ["$tipo", "uscita"] }, then: [{ conto: "$contoId", delta: { $multiply: ["$importo", -1] } }] },
                ],
                default: [],
              } } } },
              { $unwind: "$entries" },
              { $match: { "entries.conto": { $ne: null } } },
              { $group: { _id: "$entries.conto", delta: { $sum: "$entries.delta" } } },
            ],
            monthTotals: [
              { $match: { data: { $gte: monthStart, $lt: monthEnd }, tipo: { $in: ["uscita", "entrata"] } } },
              { $group: { _id: "$tipo", tot: { $sum: "$importo" } } },
            ],
          },
        },
      ]).toArray(),
    ]);

    const deltaByAccount = {};
    for (const b of agg.balances) deltaByAccount[b._id] = b.delta;
    const monthByTipo = {};
    for (const m of agg.monthTotals) monthByTipo[m._id] = m.tot;
    const speseMese = roundAmount(monthByTipo.uscita || 0);
    const entrateMese = roundAmount(monthByTipo.entrata || 0);

    const conti = accounts.map(c => {
      const id = c._id.toString();
      const saldo = (c.saldoIniziale || 0) + (deltaByAccount[id] || 0);
      return { nome: c.nome, icona: c.icona || "🏦", saldo: roundAmount(saldo) };
    });
    const totConti = sumAmounts(conti.map(c => c.saldo));

    // Portfolio a costo medio: prezzo manuale, poi prezzo live (auto,
    // quotes_cache senza householdId — stesso dato che alimenta il pulsante
    // di refresh in Portfolio), altrimenti costo di carico. Stessa priorità
    // di prezzoDi() in PortfolioView.jsx e calcolaValorePortfolio in
    // lib/finance.js, così il widget non mostra un patrimonio diverso.
    const tickers = [...new Set(positions.map(p => p.ticker))];
    const autoPriceDocs = tickers.length > 0
      ? await quotesCol.find({ ticker: { $in: tickers }, householdId: { $exists: false } }).toArray()
      : [];
    const autoPrices = {};
    for (const d of autoPriceDocs) if (typeof d.autoPrice === "number") autoPrices[d.ticker] = d.autoPrice;
    const prices = {};
    for (const d of priceDocs) prices[d.ticker] = d.manualPrice;
    const holdings = {};
    const sorted = [...positions].sort((a, b) => (a.dataAcquisto || "").localeCompare(b.dataAcquisto || ""));
    for (const p of sorted) {
      if (!holdings[p.ticker]) holdings[p.ticker] = { q: 0, c: 0 };
      const h = holdings[p.ticker];
      if (p.tipo === "sell") {
        const avg = h.q > 0.0001 ? h.c / h.q : 0;
        const sq = Math.min(p.quantita, h.q);
        h.c -= sq * avg; h.q -= sq;
        if (h.q < 0.0001) { h.q = 0; h.c = 0; }
      } else { h.q += p.quantita; h.c += p.quantita * p.prezzoAcquisto; }
    }
    let totInvestimenti = 0;
    for (const k of Object.keys(holdings)) {
      const h = holdings[k];
      if (h.q <= 0.0001) continue;
      const prezzo = (prices[k] > 0) ? prices[k] : (autoPrices[k] > 0 ? autoPrices[k] : 0);
      totInvestimenti += prezzo > 0 ? h.q * prezzo : h.c;
    }

    res.json({
      aggiornato: new Date().toISOString(),
      patrimonio: sumAmounts([totConti, totInvestimenti]),
      conti,
      contiCompleti: accounts.map(c => ({ id: c._id.toString(), nome: c.nome, icona: c.icona || "🏦" })),
      persone: sanitizePersone(household.persone),
      categorie: household.categorieUscita || WIDGET_DEFAULT_CATEGORIE,
      investimenti: roundAmount(totInvestimenti),
      speseMese,
      entrateMese,
    });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

// Aggiunta rapida di una transazione dal widget. Stessa chiave dell'endpoint
// di lettura, ma con superficie di scrittura minima e volutamente rigida:
// solo tipo/importo/descrizione/data, categoria fissa lato server, nessun
// accesso a split, persone, conti o eliminazioni.
const widgetWriteLimiter = rateLimit({ windowMs: 60 * 1000, max: 15, standardHeaders: true, legacyHeaders: false, message: { error: { code: "RATE_LIMITED", message: "Troppe richieste, riprova tra un minuto" } } });
router.post("/api/widget/transaction", widgetWriteLimiter, async (req, res) => {
  try {
    const key = req.query.key;
    if (!key || typeof key !== "string" || key.length < 20) return sendError(res, 401, "MISSING_KEY", "Chiave mancante");
    const household = await findByCapabilityToken(householdsCol, "widgetKey", key);
    if (!household) return sendError(res, 401, "INVALID_KEY", "Chiave non valida");
    const hid = household.householdId;
    const persone = household.persone || [];
    const personeIds = new Set(persone.map(p => p.id));

    // Idempotency (MOD-004): same key + household → replay the original
    // result instead of inserting a second transaction on retry.
    const idemKey = idempotencyKeyFrom(req);
    const claim = await claimIdempotencyKey(hid, idemKey);
    if (handleIdempotencyClaim(claim, res)) return;

    const b = req.body || {};
    if (!["uscita", "entrata"].includes(b.tipo)) return sendError(res, 400, "INVALID_TYPE", "Tipo non valido (uscita/entrata)");

    // Amount: same rule as every other transaction entry point (finite,
    // strictly > 0, normalized to cents) — MOD-001/MOD-005.
    let importo;
    try { importo = validateAmount(b.importo); } catch { return sendError(res, 400, "INVALID_AMOUNT", "Importo non valido"); }
    if (importo > 1000000) return sendError(res, 400, "INVALID_AMOUNT", "Importo non valido");

    // Date: same calendar-validity check as the main endpoints; falls back
    // to today rather than hard-failing, since this is a deliberately
    // forgiving, minimal write surface for third-party widgets/shortcuts.
    let data;
    try { data = validateDateStr(b.data); } catch { data = new Date().toISOString().slice(0, 10); }

    // Categoria: solo per uscite, validata contro le categorie reali della casa
    let categoria = b.tipo === "entrata" ? "entrata" : "altro";
    if (b.tipo === "uscita" && b.categoria) {
      const cats = household.categorieUscita || WIDGET_DEFAULT_CATEGORIE;
      const found = cats.find(c => c.id === b.categoria);
      if (found) categoria = found.id;
    }

    // Persona: chi ha pagato (uscita) o a chi è intestata (entrata) — deve
    // esistere davvero nella casa, altrimenti viene ignorata silenziosamente
    let pagatoDa = null, intestataA = null;
    if (b.tipo === "uscita" && b.pagatoDa && personeIds.has(b.pagatoDa)) pagatoDa = b.pagatoDa;
    if (b.tipo === "entrata" && b.intestataA && personeIds.has(b.intestataA)) intestataA = b.intestataA;

    // Split: solo per uscite, solo se pagatoDa è valido. Stessa regola di
    // validità (quote 0-100, partecipanti reali, somma 100 con tolleranza)
    // degli altri endpoint via computeValidSplits — qui una ripartizione
    // invalida viene scartata silenziosamente invece di far fallire l'intera
    // richiesta, coerente con la natura "best effort" di questo endpoint.
    let splits = null;
    if (b.tipo === "uscita" && pagatoDa && Array.isArray(b.splits) && b.splits.length > 0) {
      splits = computeValidSplits(b.splits, personeIds);
    }

    // Conto: deve appartenere davvero alla casa
    let contoId = null;
    if (b.contoId && ObjectId.isValid(b.contoId)) {
      const acc = await db.collection("accounts").findOne({ _id: new ObjectId(b.contoId), householdId: hid });
      if (acc) contoId = b.contoId;
    }

    const doc = {
      householdId: hid,
      tipo: b.tipo,
      importo,
      importoMinorUnits: toMinorUnits(importo, household.valutaBase || "EUR"), // MOD-016
      categoria,
      descrizione: sanitizeText(String(b.descrizione || "Da widget"), 140),
      data,
      pagatoDa, splits, extraPersone: null, intestataA,
      contoId, contoDa: null, contoA: null,
      viaWidget: true,
      createdAt: new Date(),
    };
    await transactionsCol.insertOne(doc);
    await auditCol.insertOne({ householdId: hid, action: "widget_transaction_added", tipo: b.tipo, importo, at: new Date() });
    const responseBody = { ok: true };
    await finalizeIdempotencyKey(hid, idemKey, 201, responseBody);
    res.status(201).json(responseBody);
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

export default router;
