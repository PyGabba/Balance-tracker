import { MongoClient, ObjectId } from "mongodb";
import { createHmac, createHash, randomUUID } from "crypto";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import { decideIdempotencyClaim, settlementTransactionKey, DEFAULT_HOUSEHOLD_ROLE } from "./validation.js";
import { logger, recordJobRun } from "./logger.js";
import { roundAmount, toMinorUnits, fromMinorUnits, minorUnitsOf } from "../src/lib/money.js";
dotenv.config();

// ─── Shared server infrastructure ───
// DB connection/collections, auth/session/RBAC, rate limiters, lockout,
// idempotency, capability tokens, multi-currency, background jobs, and the
// multi-document transaction helper — everything server/index.js and the
// domain route modules under server/routes/ both depend on. Split out of
// the former single server/index.js monolith; every route handler's logic
// below is unchanged, only which file it lives in.

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || "pygabba@gmail.com"; // deve corrispondere al "Single Sender" verificato su SendGrid

async function sendEmail(to, subject, text) {
  if (!SENDGRID_API_KEY) throw new Error("Servizio email non configurato (manca SENDGRID_API_KEY)");
  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: { "Authorization": `Bearer ${SENDGRID_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: FROM_EMAIL },
      subject,
      content: [{ type: "text/plain", value: text }],
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`SendGrid HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
}

async function sendLockoutAlert(ip, deviceId) {
  try {
    await sendEmail(FROM_EMAIL, "⚠️ Balance Tracker: accesso bloccato",
      `10 tentativi di PIN errati rilevati.\nIP: ${ip}\nDevice ID: ${deviceId || "sconosciuto"}\nAccount bloccato per 10 minuti.\n\n${new Date().toISOString()}`);
  } catch (e) { console.error("Invio alert lockout fallito:", e.message); }
}

async function sendPinResetCode(toEmail, code, householdNome) {
  await sendEmail(toEmail, "Codice per reimpostare il PIN",
    `Ciao,\n\nHai richiesto di reimpostare il PIN per il gruppo "${householdNome}".\n\nIl tuo codice è: ${code}\n\nScade tra 15 minuti. Se non hai richiesto tu questo codice, ignora questa email: il tuo PIN resta invariato.`);
}

// Verifica all'avvio se l'invio email è davvero configurato e funzionante:
// una chiamata leggera all'API di SendGrid che valida la chiave senza
// spedire nulla, così un problema si vede subito nei log di boot invece di
// scoprirlo solo quando un utente prova il reset.
async function verifyEmailSetup() {
  if (!SENDGRID_API_KEY) {
    console.warn("⚠️  SENDGRID_API_KEY non impostata: invio email (reset PIN, alert lockout) DISABILITATO.");
    return;
  }
  try {
    const res = await fetch("https://api.sendgrid.com/v3/user/account", {
      headers: { "Authorization": `Bearer ${SENDGRID_API_KEY}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} — ${body.slice(0, 200)}`);
    }
    console.log(`✓ Servizio email (SendGrid) configurato correttamente. Mittente: ${FROM_EMAIL}`);
  } catch (e) {
    console.error(`⚠️  Servizio email configurato ma NON funzionante: ${e.message}`);
    console.error("   Cause comuni: API key errata o revocata, oppure FROM_EMAIL non è un mittente verificato su SendGrid (serve la Single Sender Verification).");
  }
}

// ─── Lockout by IP and device ID — persisted in MongoDB, survives restarts ───
const MAX_FAILS = 10;
const LOCK_MINUTES = 10;

let locksCol;  // set in connectDB

async function checkLock(key) {
  const rec = await locksCol.findOne({ key });
  if (!rec) return null;
  if (rec.lockedUntil && rec.lockedUntil > new Date()) return rec; // still locked
  if (rec.lockedUntil) { await locksCol.deleteOne({ key }); return null; } // expired
  return rec; // has count but not yet locked
}

async function recordFail(key) {
  const lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60 * 1000);
  const result = await locksCol.findOneAndUpdate(
    { key },
    { $inc: { count: 1 }, $setOnInsert: { key, createdAt: new Date() } },
    { upsert: true, returnDocument: "after" }
  );
  if (result.count >= MAX_FAILS) {
    await locksCol.updateOne({ key }, { $set: { lockedUntil } });
    return true;
  }
  return false;
}

async function clearLock(key) { await locksCol.deleteOne({ key }); }

if (process.env.NODE_ENV === "production" && !process.env.JWT_SECRET) {
  console.error("FATAL: JWT_SECRET non impostato in produzione. Il server non può avviarsi con il secret di default.");
  process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-in-production";
const TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60;

let activeTokensCol; // set in connectDB

// personaId (MOD-025 Stage 1) is optional — omitted entirely (not even
// null) when absent, so a token issued without persona-login is
// byte-for-byte the same shape it's always been.
function signToken(householdId, personaId = null) {
  const jti = randomUUID();
  const payload = personaId ? { householdId, personaId, jti } : { householdId, jti };
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: "90d" });
  return { token, jti };
}
async function storeToken(jti, householdId, personaId = null) {
  const doc = { jti, householdId, createdAt: new Date() };
  if (personaId) doc.personaId = personaId; // omitted (not null) for household-only sessions, mirroring signToken's payload shape
  await activeTokensCol.insertOne(doc);
}
async function revokeToken(jti) {
  await activeTokensCol.deleteOne({ jti });
}
async function revokeAllTokens(householdId, session) {
  await activeTokensCol.deleteMany({ householdId }, session ? { session } : undefined);
}
// Kills every session issued for this persona (credential removed/changed) —
// without this, a stolen or ex-member session survives on its own JWT
// expiry (up to 90 days) instead of dying the moment the credential does.
async function revokeTokensForPersona(householdId, personaId) {
  await activeTokensCol.deleteMany({ householdId, personaId });
}
function pinLookupKey(pin) {
  return createHmac("sha256", JWT_SECRET).update(pin).digest("hex");
}
async function hashPin(pin) { return bcrypt.hash(pin, 10); }

// ─── Persona credentials (MOD-025 Stage 1) ───
// A persona's password hash lives in persone[].auth.passwordHash — never
// meant to leave the server. req.household.persone (and every other
// internal in-memory copy) stays RAW/unsanitized on purpose: the
// PUT .../ruolo endpoint reads persone, patches one field, and writes the
// whole array back — if that read were sanitized, the write would
// silently erase every enrolled persona's credential the next time
// ANYONE changed ANY persona's role. Sanitization happens only at the
// point a response is actually serialized, via this helper, applied
// per-response-site rather than at the source, specifically to keep the
// read and write paths from sharing a value that's wrong for one of them.
function sanitizePersonaForClient(p) {
  if (!p || typeof p !== "object") return p;
  const { auth, ...rest } = p;
  // email is intentionally surfaced (not just a boolean) — the settings UI
  // needs to show it back so whoever enrolled it can see/remember what to
  // log in with; it's the same visibility level hasCredential already has
  // (any PIN holder can already see who has a password set at all).
  return { ...rest, hasCredential: !!(auth && auth.method), credentialEmail: auth?.email || null };
}
function sanitizePersone(persone) {
  return (persone || []).map(sanitizePersonaForClient);
}

// Yahoo Finance disabled

function clientIp(req) {
  // Use Express-computed req.ip (respects trust proxy: 1, takes rightmost untrusted hop).
  // Never read X-Forwarded-For[0] directly — it is client-controlled and trivially spoofed.
  return req.ip || req.socket?.remoteAddress || "unknown";
}
const MONGO_URI = process.env.MONGODB_URI || "mongodb://localhost:27017";
const DB_NAME = process.env.DB_NAME || "finanza_tracker";
const IS_PROD = process.env.NODE_ENV === "production";
const COOKIE_OPTS = {
  httpOnly: true,
  secure: IS_PROD,      // localhost dev doesn't use HTTPS
  sameSite: "strict",   // safe: prod requests come via Vercel proxy (same-origin); local is same-site
  maxAge: TOKEN_TTL_SECONDS * 1000,
  path: "/",
};

export let db, mongoClient, transactionsCol, householdsCol, quotesCol, blacklistCol, auditCol, tripsCol, exchangeRatesCol, idempotencyCol;
// `mongoUri`/`dbName` default to the module-level env-derived values (the
// production path) but can be overridden — this is what lets tests point
// the exact same app at a disposable mongodb-memory-server instance instead
// of a real database, without touching process.env or module-level state
// (MOD-014).
async function connectDB(mongoUri = MONGO_URI, dbName = DB_NAME) {
  const client = new MongoClient(mongoUri); await client.connect();
  mongoClient = client;
  db = client.db(dbName);
  transactionsCol = db.collection("transactions");
  householdsCol = db.collection("households");
  locksCol = db.collection("login_locks");
  quotesCol = db.collection("quotes_cache");
  blacklistCol = db.collection("blacklist");
  activeTokensCol = db.collection("active_tokens");
  auditCol = db.collection("audit_log");
  tripsCol = db.collection("trips");
  exchangeRatesCol = db.collection("exchange_rates_cache");
  idempotencyCol = db.collection("idempotency_keys");
  await exchangeRatesCol.createIndex({ base: 1 }, { unique: true });
  // MOD-004: one stored result per (household, idempotency key) — a retried
  // create request replays the original response instead of inserting again.
  await idempotencyCol.createIndex({ householdId: 1, key: 1 }, { unique: true });
  await idempotencyCol.createIndex({ createdAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 }); // 7d: comfortably longer than any realistic retry/reconnect window
  // Matches the pagination sort/cursor exactly (data desc, _id desc — see
  // GET /api/transactions, MOD-006) so a page fetch never falls back to an
  // in-memory sort for transactions sharing the same date.
  await transactionsCol.createIndex({ householdId: 1, data: -1, _id: -1 });
  await transactionsCol.createIndex({ deletedAt: 1 }, { sparse: true });
  // MOD-020: generaRicorrentiDovute() queries this on every periodic tick
  // (RICORRENTI_CHECK_MS) across every household — without an index that's
  // a full collection scan of every transaction that has ever had a
  // ricorrenza field, on every tick, forever.
  await transactionsCol.createIndex({ "ricorrenza.prossimaData": 1 }, { sparse: true });
  // MOD-007: enforces that the SAME recurring occurrence (one parent
  // transaction + one due date) can never be inserted twice, no matter how
  // many server instances or retries race to generate it — see
  // generaRicorrentiDovute below. This is the actual fix; the in-process
  // ricorrentiRunning flag that follows is only an optimization to avoid
  // redundant work within a single instance, not a correctness guarantee.
  await transactionsCol.createIndex({ recurrenceOccurrenceKey: 1 }, { unique: true, sparse: true });
  // MOD-008 (hardened): each trip-settlement transaction gets a
  // deterministic key (tripId:index) inserted with this unique index —
  // what makes it safe to resume a settlement that crashed partway
  // through without risking a duplicate. See chiudiViaggiScaduti below.
  await transactionsCol.createIndex({ settlementKey: 1 }, { unique: true, sparse: true });
  await tripsCol.createIndex({ householdId: 1, startDate: -1 });
  await tripsCol.createIndex({ householdId: 1 });
  // MOD-020/MOD-008: chiudiViaggiScaduti() below scans across every
  // household's trips on every tick looking for unsettled, past-due ones
  // (settlementStatus null/"open") plus any stuck mid-settlement from a
  // previous crash (settlementStatus "settling", stale settlingStartedAt).
  await tripsCol.createIndex({ settled: 1, endDate: 1 });
  await tripsCol.createIndex({ settlementStatus: 1, settlingStartedAt: 1 });
  // MOD-020: every transaction and account read/write filters by
  // householdId; these two collections had no index on it at all.
  await db.collection("accounts").createIndex({ householdId: 1 });
  await db.collection("goals").createIndex({ householdId: 1 });
  await db.collection("positions").createIndex({ householdId: 1 });
  // Live-quote cache docs (ticker, autoPrice, fetchedAt) live in the same
  // collection as manual price overrides but never carry a householdId —
  // that's what separates the two kinds of quotes_cache document.
  await quotesCol.createIndex({ ticker: 1 }, { sparse: true });
  // MOD-011: capability tokens (widget key, calendar key, trip share token)
  // are stored as a SHA-256 hash, never plaintext — see hashCapabilityToken
  // below. The legacy plaintext fields (shareToken/calendarKey/widgetKey)
  // are kept only as a sparse lookup fallback for tokens issued before this
  // change; findByCapabilityToken migrates them to a hash on first use.
  // New indexes are on the hash fields; the old plaintext indexes stay in
  // place until nothing references them anymore.
  await tripsCol.createIndex({ shareToken: 1 }, { unique: true, sparse: true });
  await tripsCol.createIndex({ shareTokenHash: 1 }, { unique: true, sparse: true });
  await householdsCol.createIndex({ calendarKey: 1 }, { unique: true, sparse: true });
  await householdsCol.createIndex({ calendarKeyHash: 1 }, { unique: true, sparse: true });
  await householdsCol.createIndex({ widgetKeyHash: 1 }, { unique: true, sparse: true });
  await auditCol.createIndex({ ts: -1 });
  await auditCol.createIndex({ householdId: 1, ts: -1 });
  await auditCol.createIndex({ ts: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 }); // 90-day retention
  try { await householdsCol.dropIndex("pin_1"); } catch {}
  await householdsCol.createIndex({ pin: 1 }, { unique: true, sparse: true });
  await householdsCol.createIndex({ pinLookup: 1 }, { unique: true, sparse: true });
  await householdsCol.createIndex({ email: 1 }, { unique: true, sparse: true });
  // Multikey index on an embedded array field — MongoDB enforces the
  // uniqueness constraint per indexed VALUE across the whole collection
  // (every household's persone array), not just within one document, so
  // this is what makes "email identifies exactly one persona, globally"
  // an actual guarantee rather than just an app-level convention. sparse:
  // true so the many persone with no auth.email at all don't collide with
  // each other (a non-existent field isn't indexed at all, let alone as a
  // shared "undefined").
  await householdsCol.createIndex({ "persone.auth.email": 1 }, { unique: true, sparse: true });
  await db.collection("pinResets").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await householdsCol.createIndex({ householdId: 1 }, { unique: true });
  try { await locksCol.dropIndex("ip_1"); } catch {}
  await locksCol.createIndex({ key: 1 }, { unique: true });
  await locksCol.createIndex({ lockedUntil: 1 }, { expireAfterSeconds: 0, sparse: true });
  await blacklistCol.createIndex({ key: 1 }, { unique: true });
  await activeTokensCol.createIndex({ jti: 1 }, { unique: true });
  await activeTokensCol.createIndex({ householdId: 1 });
  await activeTokensCol.createIndex({ householdId: 1, personaId: 1 }, { sparse: true });
  await activeTokensCol.createIndex({ createdAt: 1 }, { expireAfterSeconds: TOKEN_TTL_SECONDS });
  // One-time migration: flag all existing households to require a 6-digit PIN change
  await householdsCol.updateMany(
    { requiresPinChange: { $exists: false } },
    { $set: { requiresPinChange: true } }
  );
  logger.info("db_connected", { dbName }); return client;
}

// ─── Input sanitization ───
function sanitizeText(s, maxLen = 500) {
  if (s == null) return "";
  return String(s).trim().slice(0, maxLen);
}

// ─── Persona id/appearance defaults (shared by register and the
// add-persona endpoint below) ───
const DEFAULT_EMOJIS = ["👤", "👩", "👨", "🧑", "👧", "👦"];
const PERSONA_COLORS = ["#6C5CE7", "#E84393", "#0984E3", "#00B894", "#FD79A8", "#FDCB6E"];

// Slugifies a name into an id, then disambiguates against ids already
// taken in this household (e.g. two participants named "Mario") by
// appending -2, -3, ... — ids are used in URLs (/persone/:id) so they
// must stay unique within the household even when names collide.
function personaIdFromNome(nome, existingIds) {
  const base = nome.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "") || "persona";
  if (!existingIds.has(base)) return base;
  let n = 2;
  while (existingIds.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

// (sanitizeSplits/sanitizeExtraPersone/sanitizeRicorrenza formerly lived
// here — superseded by computeValidSplits/validateSplits/
// validateExtraPersone/validateRicorrenza in ./validation.js, now used
// everywhere any of these are accepted: transactions, widget transactions,
// and trip expenses.)

// ─── Idempotency for write APIs (MOD-004, hardened) ───
// Client sends an `Idempotency-Key` header on create requests (see api.js).
// The first successful request for a given (household, key) pair is
// remembered; a retry with the same key replays the original response
// instead of creating a duplicate entity. Requests without a key proceed
// normally (no idempotency guarantee) so this stays backward-compatible
// with any caller that doesn't send one yet.
//
// The claim itself (not just the final result) is what's made atomic here:
// a request first tries to atomically INSERT a "pending" placeholder,
// relying on the unique (householdId, key) index to let at most one
// concurrent request win that insert. Only the winner proceeds to actually
// create the entity. This closes a real race in the original version,
// where two truly concurrent requests with the same key could both pass a
// "does a result already exist?" check (finding nothing yet), both create
// the entity, and only THEN collide on storing the idempotency record —
// by which point the duplicate entity already existed in the database.
function idempotencyKeyFrom(req) {
  const key = req.headers["idempotency-key"];
  if (typeof key !== "string") return null;
  const trimmed = key.trim();
  if (!trimmed || trimmed.length > 100) return null;
  return trimmed;
}

// If a claim has been "pending" this long, the original attempt almost
// certainly crashed or timed out before finishing — long enough that no
// legitimate request should still be in flight, short enough that a
// genuinely stuck key doesn't block retries for the rest of the 7-day
// idempotency window.
const IDEMPOTENCY_PENDING_STALE_MS = 30 * 1000;

// Returns { claimed: true } if this call may proceed to create the entity,
// or { claimed: false, existing } if it must not — either because another
// request already completed (existing.status/body is the response to
// replay) or because one is still genuinely in flight (existing.status
// === "pending", caller should ask the client to retry shortly).
async function claimIdempotencyKey(householdId, key) {
  if (!key) return { claimed: true, existing: null };
  const now = new Date();
  try {
    await idempotencyCol.insertOne({ householdId, key, status: "pending", body: null, createdAt: now });
    return { claimed: true, existing: null };
  } catch (e) {
    if (e.code !== 11000) throw e;
  }
  const existing = await idempotencyCol.findOne({ householdId, key });
  const decision = decideIdempotencyClaim(existing, now.getTime(), IDEMPOTENCY_PENDING_STALE_MS);
  if (decision.action === "claim") return { claimed: true, existing: null };
  if (decision.action === "replay" || decision.action === "wait") return { claimed: false, existing };
  // "steal": atomically reclaim the stale pending record (matching on its
  // original createdAt so a third racing request can't also win the steal).
  const stolen = await idempotencyCol.findOneAndUpdate(
    { householdId, key, status: "pending", createdAt: decision.createdAt },
    { $set: { createdAt: now } }
  );
  return stolen ? { claimed: true, existing: null } : { claimed: false, existing };
}

async function finalizeIdempotencyKey(householdId, key, status, body) {
  if (!key) return;
  try {
    await idempotencyCol.updateOne({ householdId, key }, { $set: { status, body, completedAt: new Date() } });
  } catch (e) { console.error("idempotency finalize failed:", e.message); }
}

// Shared response handling for a failed claim — used at every call site so
// they don't each re-implement the pending-vs-completed branch. Returns
// true if it already wrote a response (caller should `return` immediately
// without proceeding), false if the caller won the claim and should go on
// to create the entity.
function handleIdempotencyClaim(claim, res) {
  if (claim.claimed) return false;
  if (claim.existing.status === "pending") {
    // 425: another request with this exact key is still being processed —
    // this is transient, not a permanent rejection, and is already in the
    // client's retryable-status set (see outboxLogic.js), so the sync
    // engine will back off and retry rather than giving up on it.
    sendError(res, 425, "DUPLICATE_IN_PROGRESS", "Richiesta identica già in elaborazione, riprova tra poco");
  } else {
    res.status(claim.existing.status).json(claim.existing.body);
  }
  return true;
}

// ─── Capability tokens (MOD-011) ───
// Widget key, calendar key, and trip share tokens are bearer credentials:
// anyone holding the raw value gets the access it grants, no other check.
// They're stored as a SHA-256 hash rather than plaintext — hashing here is
// purely about limiting exposure if the database (or a backup of it) is
// ever read by someone who shouldn't have it; it is NOT a defense against
// guessing, since these are already 192 bits of randomBytes(24) and a fast
// hash is fine (unlike a low-entropy PIN, where a fast hash would be a
// real weakness — see MOD-010's offline PIN verifier for that case).
function hashCapabilityToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

// `field` is the legacy plaintext field name (e.g. "widgetKey"); the hash
// lives in `${field}Hash`. Checks the hash first; falls back to a plaintext
// match for tokens issued before this change existed, and opportunistically
// migrates a plaintext hit to a hash so it isn't stored in the clear any
// longer than necessary.
async function findByCapabilityToken(col, field, token, extraFilter = {}) {
  const hashField = `${field}Hash`;
  const hash = hashCapabilityToken(token);
  let doc = await col.findOne({ [hashField]: hash, ...extraFilter });
  if (doc) return doc;
  doc = await col.findOne({ [field]: token, ...extraFilter });
  if (doc) {
    const idField = col === tripsCol ? { _id: doc._id } : { householdId: doc.householdId };
    await col.updateOne(idField, { $set: { [hashField]: hash }, $unset: { [field]: "" } });
  }
  return doc;
}

// ─── Multi-currency — exchange rates cached 24h per base currency ───
// Any real ISO-4217-shaped code is accepted; the exchange-rate API covers ~160
// currencies, far more than we'd want to hardcode a whitelist for.
function sanitizeValuta(v) {
  if (typeof v !== "string") return null;
  const up = v.toUpperCase().trim();
  return /^[A-Z]{3}$/.test(up) ? up : null;
}
const EXCHANGE_RATE_CACHE_MS = 24 * 60 * 60 * 1000;

// Thrown when a currency conversion can't be completed (rate provider down,
// unsupported currency, malformed response, AND no usable cache to fall
// back on). Callers must surface this to the client instead of proceeding —
// see MOD-005: a missing rate must never silently become 1.
export class ConversionUnavailableError extends Error {}

// Returns { rates, stale }. `stale` is true when we could not refresh from
// the provider and are serving a cache older than EXCHANGE_RATE_CACHE_MS (or
// { rates: null, stale: true } if there's no cache at all to fall back on).
// Never invents a rate — the caller decides what to do with staleness.
async function fetchRatesTable(base) {
  const cached = await exchangeRatesCol.findOne({ base });
  const isFresh = cached && Date.now() - new Date(cached.fetchedAt).getTime() <= EXCHANGE_RATE_CACHE_MS;
  if (isFresh) return { rates: cached.rates, stale: false };
  try {
    const r = await fetch(`https://api.exchangerate-api.com/v4/latest/${base}`, { signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const data = await r.json();
      if (data && data.rates && typeof data.rates === "object") {
        await exchangeRatesCol.updateOne(
          { base },
          { $set: { base, rates: data.rates, fetchedAt: new Date(), source: "exchangerate-api.com" } },
          { upsert: true }
        );
        return { rates: data.rates, stale: false };
      }
    }
  } catch (e) { console.error("exchange rate fetch failed", e); }
  // Provider unreachable or returned something unexpected: fall back to a
  // stale cache rather than inventing a rate. No cache at all → unavailable.
  if (cached?.rates) return { rates: cached.rates, stale: true };
  return { rates: null, stale: true };
}
async function getExchangeRate(from, to) {
  if (from === to) return { rate: 1, stale: false };
  const { rates, stale } = await fetchRatesTable(from);
  const rate = rates ? rates[to] : undefined;
  if (!Number.isFinite(rate)) return { rate: null, stale };
  return { rate, stale };
}
// Converte importo dalla valuta scelta alla valuta base della casa; se
// coincidono o non è specificata, l'importo resta invariato (nessun campo extra).
// Se il tasso non è disponibile, lancia ConversionUnavailableError invece di
// assumere silenziosamente un cambio 1:1 (MOD-005).
async function applyValutaTransazione(doc, importoInput, valutaInput, householdValutaBase) {
  const valuta = sanitizeValuta(valutaInput);
  const base = householdValutaBase || "EUR";
  if (!valuta) throw new ConversionUnavailableError(`Valuta non valida: ${valutaInput}`);
  if (valuta === base) return;
  const { rate, stale } = await getExchangeRate(valuta, base);
  if (rate == null) {
    throw new ConversionUnavailableError(`Cambio non disponibile: ${valuta} → ${base}`);
  }
  doc.valuta = valuta;
  doc.importoOriginale = importoInput;
  doc.importoOriginaleMinorUnits = toMinorUnits(importoInput, valuta); // MOD-016 — original currency's own precision, not base's
  doc.tassoCambio = rate;
  if (stale) doc.tassoCambioObsoleto = true; // explicit stale-rate flag (MOD-005) — surfaced to the client rather than hidden
  doc.importo = roundAmount(importoInput * rate, base);
  doc.importoMinorUnits = toMinorUnits(doc.importo, base); // overrides the pre-conversion value validateTransactionInput set
}

// ─── Recurring transactions — server-side generator ───
function nextRicorrenzaData(dateStr, frequenza) {
  const d = new Date(dateStr + "T12:00:00Z");
  if (frequenza === "settimanale") d.setUTCDate(d.getUTCDate() + 7);
  else if (frequenza === "mensile") d.setUTCMonth(d.getUTCMonth() + 1);
  else if (frequenza === "trimestrale") d.setUTCMonth(d.getUTCMonth() + 3);
  else if (frequenza === "annuale") d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

let ricorrentiRunning = false;
export async function generaRicorrentiDovute() {
  if (ricorrentiRunning || !transactionsCol) return; // in-process optimization only — see index comment above for the real guarantee
  ricorrentiRunning = true;
  const jobStart = Date.now();
  let jobFailed = false, jobError = null;
  try {
    const oggi = new Date().toISOString().slice(0, 10);
    const dovute = await transactionsCol.find({ "ricorrenza.prossimaData": { $lte: oggi }, deletedAt: null }).toArray();
    let generated = 0, skipped = 0, staleEdits = 0, errors = 0;
    for (const t of dovute) {
      // One key per (parent transaction, due date) — the unique index on it
      // is what actually prevents two instances (or a retry) from both
      // inserting this occurrence (MOD-007).
      const occurrenceKey = `${t._id.toString()}:${t.ricorrenza.prossimaData}`;
      const child = { ...t, data: t.ricorrenza.prossimaData, createdAt: new Date(), recurrenceOccurrenceKey: occurrenceKey };
      delete child._id;
      delete child.ricorrenza;
      delete child.updatedAt;
      if (t.ricorrenza.variabile) child.daVerificare = true;
      try {
        await transactionsCol.insertOne(child);
        generated++;
      } catch (err) {
        if (err?.code === 11000) {
          // Another instance (or an earlier, still-in-flight attempt) already
          // generated this exact occurrence. Nothing more to do for the
          // insert — still fall through to advance prossimaData below.
          skipped++;
          logger.info("recurring_occurrence_already_generated", { occurrenceKey });
        } else {
          errors++;
          logger.error("recurring_occurrence_insert_failed", { occurrenceKey, error: err?.message });
          continue; // leave prossimaData untouched so this occurrence is retried on the next tick
        }
      }
      const updatedRicorrenza = {
        frequenza: t.ricorrenza.frequenza,
        prossimaData: nextRicorrenzaData(t.ricorrenza.prossimaData, t.ricorrenza.frequenza),
        variabile: t.ricorrenza.variabile,
      };
      // Optimistic concurrency: only advance prossimaData if it still has
      // the exact value we read it as. If the user edited the recurrence
      // (e.g. changed the due date or frequency) in the moment between our
      // read and this write, this simply won't match — their edit wins,
      // and we don't overwrite it with an advance computed from what's now
      // stale data. The next tick re-reads the current value and decides
      // fresh whether it's still due.
      const advanced = await transactionsCol.updateOne(
        { _id: t._id, "ricorrenza.prossimaData": t.ricorrenza.prossimaData },
        { $set: { ricorrenza: updatedRicorrenza } }
      );
      if (advanced.matchedCount === 0) {
        // Either a genuinely concurrent user edit, or (in the racing-
        // instances case) the other instance's own successful advance
        // already landed first — either way, correctly not double-applied.
        staleEdits++;
        logger.info("recurring_advance_skipped_concurrent_change", { transactionId: t._id.toString() });
      }
    }
    if (dovute.length > 0 || generated > 0) {
      logger.info("recurring_job_completed", { due: dovute.length, generated, skippedDuplicate: skipped, skippedConcurrentEdit: staleEdits, errors, durationMs: Date.now() - jobStart });
    }
    if (errors > 0) jobFailed = true;
  } catch (e) {
    jobFailed = true;
    jobError = e?.message || String(e);
    logger.error("recurring_job_failed", { error: jobError });
  } finally {
    recordJobRun("recurringTransactions", { failed: jobFailed, error: jobError });
    ricorrentiRunning = false;
  }
}

// Checked every 6h so a due recurrence fires the same day even if the server was asleep at midnight
const RICORRENTI_CHECK_MS = 6 * 60 * 60 * 1000;

// ─── Trash — hard-delete transactions soft-deleted more than 30 days ago ───
const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

let trashPurgeRunning = false;
export async function svuotaCestinoScaduto() {
  if (trashPurgeRunning || !transactionsCol) return;
  trashPurgeRunning = true;
  let jobFailed = false, jobError = null;
  try {
    const soglia = new Date(Date.now() - TRASH_RETENTION_MS);
    const r = await transactionsCol.deleteMany({ deletedAt: { $ne: null, $lte: soglia } });
    if (r.deletedCount > 0) logger.info("trash_purge_job_completed", { deleted: r.deletedCount });
  } catch (e) {
    jobFailed = true;
    jobError = e?.message || String(e);
    logger.error("trash_purge_job_failed", { error: jobError });
  } finally {
    recordJobRun("trashPurge", { failed: jobFailed, error: jobError });
    trashPurgeRunning = false;
  }
}

// ─── Trip auto-close — settles + closes trips once their endDate has passed ───
// Balances accumulate in integer minor units (MOD-016), not raw floats —
// a trip with many expenses is exactly the kind of long running sum where
// float drift would otherwise compound before the final rounding.
function calcolaSettleViaggioServer(trip, valutaBase = "EUR") {
  const balancesMinor = {};
  for (const e of trip.expenses || []) {
    if (e.splits && e.splits.length > 0) {
      const totalQ = e.splits.reduce((s, sc) => s + sc.quota, 0);
      const importoMinor = minorUnitsOf(e, "importo", valutaBase); // MOD-016 contract phase
      for (const s of e.splits) {
        if (s.personaId !== e.pagatoDa) {
          const owedMinor = Math.round(importoMinor * (s.quota / totalQ));
          balancesMinor[s.personaId] = (balancesMinor[s.personaId] || 0) - owedMinor;
          balancesMinor[e.pagatoDa] = (balancesMinor[e.pagatoDa] || 0) + owedMinor;
        }
      }
    }
  }
  const creditors = [], debtors = [];
  for (const [id, balMinor] of Object.entries(balancesMinor)) {
    if (balMinor > 1) creditors.push({ id, balMinor });
    if (balMinor < -1) debtors.push({ id, balMinor: -balMinor });
  }
  creditors.sort((a, b) => b.balMinor - a.balMinor);
  debtors.sort((a, b) => b.balMinor - a.balMinor);
  const settlements = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const payMinor = Math.min(debtors[i].balMinor, creditors[j].balMinor);
    if (payMinor > 1) settlements.push({ da: debtors[i].id, a: creditors[j].id, importo: fromMinorUnits(payMinor, valutaBase) });
    debtors[i].balMinor -= payMinor;
    creditors[j].balMinor -= payMinor;
    if (debtors[i].balMinor < 1) i++;
    if (creditors[j].balMinor < 1) j++;
  }
  return settlements;
}

// Inserts each settlement leg as its own "saldo" transaction, keyed
// deterministically (tripId + leg index) so re-running after a partial
// failure/crash just no-ops on legs already inserted instead of duplicating
// them. Shared by the scheduled auto-close job and the on-demand manual
// settle endpoint — both need the exact same idempotent insert behavior.
async function insertSettlementLegs(tripId, householdId, tripNome, settlements, valutaBase, nameOf) {
  const oggi = new Date().toISOString().slice(0, 10);
  let allInserted = true;
  for (let i = 0; i < settlements.length; i++) {
    const s = settlements[i];
    const settlementKey = settlementTransactionKey(tripId, i);
    try {
      // eslint-disable-next-line no-await-in-loop
      await transactionsCol.insertOne({
        householdId,
        tipo: "saldo",
        importo: s.importo,
        importoMinorUnits: toMinorUnits(s.importo, valutaBase), // MOD-016
        categoria: "saldo_viaggio",
        descrizione: `Saldo viaggio: ${tripNome} (${nameOf(s.da)} → ${nameOf(s.a)})`,
        data: oggi,
        pagatoDa: s.da,
        ricevutoDa: s.a,
        settlementKey,
        createdAt: new Date(),
      });
    } catch (err) {
      if (err?.code === 11000) {
        logger.info("trip_settlement_leg_already_inserted", { tripId, settlementKey });
      } else {
        logger.error("trip_settlement_leg_insert_failed", { tripId, settlementKey, error: err?.message });
        allInserted = false;
        break; // stop here — caller decides whether to leave the trip in "settling" for a retry
      }
    }
  }
  return allInserted;
}

let tripAutoCloseRunning = false;
// If a trip has been stuck in "settling" this long, the process that
// claimed it almost certainly crashed mid-way (between marking it settled
// and finishing every settlement transaction) rather than genuinely still
// being in progress — 6h ticks mean this only matters after a real crash.
// Safe to resume: settlement legs are inserted idempotently below via a
// unique key, so resuming can never duplicate a leg that already went in
// before the crash, it only fills in whatever's still missing.
const TRIP_SETTLING_STALE_MS = 10 * 60 * 1000;

export async function chiudiViaggiScaduti() {
  if (tripAutoCloseRunning || !tripsCol) return; // in-process optimization only — see below for the real guarantee
  tripAutoCloseRunning = true;
  const jobStart = Date.now();
  let jobFailed = false, jobError = null;
  try {
    const oggi = new Date().toISOString().slice(0, 10);
    const now = new Date();
    const staleBefore = new Date(now.getTime() - TRIP_SETTLING_STALE_MS);
    // Newly-due trips, PLUS trips stuck mid-settlement from a previous
    // crashed attempt — both get the same atomic-claim-and-resume treatment
    // below, so a crash never leaves a trip permanently stuck (settled:true
    // with missing settlement transactions) or forever skipped.
    const candidateFilter = {
      $or: [
        { settlementStatus: { $in: [null, "open"] }, settled: false, endDate: { $ne: null, $lt: oggi } },
        { settlementStatus: "settling", settlingStartedAt: { $lt: staleBefore } },
      ],
    };
    const candidates = await tripsCol.find(candidateFilter, { projection: { _id: 1, settlementStatus: 1 } }).toArray();
    const resumeCount = candidates.filter(c => c.settlementStatus === "settling").length;
    let closed = 0, errors = 0;
    for (const { _id } of candidates) {
      // MOD-008: atomically claim the trip by transitioning it into
      // "settling" — matching the SAME condition as the query above so two
      // instances can't both claim (or both resume) the same trip. Only
      // the caller whose update actually matched proceeds.
      // eslint-disable-next-line no-await-in-loop
      const claimed = await tripsCol.findOneAndUpdate(
        { _id, ...candidateFilter },
        { $set: { settlementStatus: "settling", settlingStartedAt: now, updatedAt: now } },
        { returnDocument: "after" }
      );
      if (!claimed) continue; // already claimed/resumed by another instance/tick since the query above

      // eslint-disable-next-line no-await-in-loop
      const claimedHousehold = await householdsCol.findOne({ householdId: claimed.householdId }, { projection: { valutaBase: 1 } });
      const claimedValutaBase = claimedHousehold?.valutaBase || "EUR";
      const nameOf = (id) => (claimed.partecipanti || []).find(p => p.id === id)?.nome || id;
      const settlements = calcolaSettleViaggioServer(claimed, claimedValutaBase);
      // Deterministic per-leg key (tripId + index): a crash-and-resume retry
      // recomputes the exact same settlements array from the exact same
      // trip data (locked in "settling" the whole time), so this call is a
      // harmless no-op for any leg already inserted before the crash.
      // eslint-disable-next-line no-await-in-loop
      const allInserted = await insertSettlementLegs(_id.toString(), claimed.householdId, claimed.nome, settlements, claimedValutaBase, nameOf);
      if (!allInserted) errors++; // stay in "settling" — the next tick resumes from wherever this left off
      if (allInserted) {
        // eslint-disable-next-line no-await-in-loop
        await tripsCol.updateOne({ _id }, { $set: { settled: true, settlementStatus: "settled", autoSettled: true, updatedAt: new Date() } });
        closed++;
      }
    }
    if (candidates.length > 0 || closed > 0) {
      logger.info("trip_settlement_job_completed", { candidates: candidates.length, closed, resumedFromCrash: resumeCount, errors, durationMs: Date.now() - jobStart });
    }
    if (errors > 0) jobFailed = true;
  } catch (e) {
    jobFailed = true;
    jobError = e?.message || String(e);
    logger.error("trip_settlement_job_failed", { error: jobError });
  } finally {
    recordJobRun("tripSettlement", { failed: jobFailed, error: jobError });
    tripAutoCloseRunning = false;
  }
}

// ─── Multi-document atomicity (MOD-010-ish) ───
// A handful of writes touch several collections/documents as one logical
// operation (household deletion, an account's references being detached
// across transactions+goals, manual price overrides being replaced
// wholesale) — without a transaction, a crash or network drop midway
// through leaves the database in a state that's neither the old one nor
// the new one (e.g. a household deleted but its transactions still
// present, or account references half-detached). Requires the target
// MongoDB to be a replica set — a single *single-node* replica set is
// enough, this isn't asking for a cluster (`mongod --replSet rs0` +
// one-time `rs.initiate()`; MongoDB Atlas is already one by default). A
// standalone instance rejects `startSession`/transactions outright, which
// surfaces immediately as a 500 on the first delete rather than silently
// falling back to non-atomic behavior.
async function withTransaction(fn) {
  const session = mongoClient.startSession();
  try {
    let result;
    await session.withTransaction(async () => { result = await fn(session); });
    return result;
  } finally {
    await session.endSession();
  }
}

// ─── Audit log ───
function audit(event, { householdId = null, ip = null, deviceId = null, success = true, detail = null } = {}) {
  const doc = { event, householdId, ip, deviceId, success, ts: new Date() };
  if (detail) doc.detail = detail;
  auditCol?.insertOne(doc).catch(() => {}); // fire-and-forget, never block a request
}

// ─── Blacklist helpers ───
async function isBlacklisted(key) {
  const rec = await blacklistCol.findOne({ key });
  return !!rec;
}

// ─── Rate limiters ───

const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120, // #5: 120 writes/min per IP — stops storage flood while allowing normal use
  standardHeaders: true, legacyHeaders: false,
  message: { error: { code: "RATE_LIMITED", message: "Troppe operazioni, riprova tra un minuto" } },
});

async function findHousehold(hid) {
  const dbH = await householdsCol.findOne({ householdId: hid });
  if (dbH) return {
    id: dbH.householdId, nome: dbH.nome, persone: dbH.persone,
    categorieUscita: dbH.categorieUscita || null,
    tripCategories: dbH.tripCategories || null,
    requiresPinChange: dbH.requiresPinChange || false,
    email: dbH.email || null,
    valutaBase: dbH.valutaBase || "EUR",
    createdAt: dbH.createdAt || null,
  };
  return null;
}

// Routes allowed even when requiresPinChange is set
const PIN_CHANGE_EXEMPT = ["/api/auth/pin", "/api/auth/logout"];

// ─── Standard error response shape (MOD-022) ───
// { error: { code, message, fields? } } — lets the frontend (or any other
// client, e.g. the widget/shortcuts integrations) distinguish an
// authentication failure from a validation failure from a rate limit
// programmatically instead of pattern-matching free text. Used by every
// route in this file — the message text is unchanged from before this
// migration (still Italian, still human-oriented), only the shape and the
// addition of a stable `code` are new. `fields` is included only where a
// specific field is at fault (mainly validation errors).
function sendError(res, status, code, message, fields = undefined) {
  const body = { error: { code, message } };
  if (fields) body.error.fields = fields;
  return res.status(status).json(body);
}

async function requireHousehold(req, res, next) {
  const rawToken = req.cookies?.token;
  if (!rawToken) return sendError(res, 401, "NOT_AUTHENTICATED", "Accesso richiesto");
  let payload;
  try { payload = jwt.verify(rawToken, JWT_SECRET, { algorithms: ["HS256"] }); }
  catch { return sendError(res, 401, "INVALID_TOKEN", "Token non valido"); }
  const { householdId: hid, jti, personaId } = payload;
  if (!jti) return sendError(res, 401, "INVALID_TOKEN", "Token non valido");
  try {
    const [household, active] = await Promise.all([
      findHousehold(hid),
      activeTokensCol.findOne({ jti }),
    ]);
    if (!household || !active) return sendError(res, 401, "SESSION_EXPIRED", "Sessione scaduta, accedi nuovamente");
    // #2: enforce PIN change server-side — token is valid but access is locked until PIN updated
    if (household.requiresPinChange && !PIN_CHANGE_EXEMPT.includes(req.path)) {
      return sendError(res, 403, "PIN_CHANGE_REQUIRED", "Cambio PIN richiesto prima di continuare");
    }
    // MOD-025 Stage 1: personaId is set only for a session that went
    // through persona-login on top of the household PIN.
    req.household = household; req.householdId = hid; req.jti = jti; req.personaId = personaId || null; next();
  } catch (e) { sendError(res, 500, "INTERNAL_ERROR", "Errore autenticazione"); }
}

// ─── Role enforcement (MOD-025 Stage 2) ───
// Zero-risk-to-non-adopters by construction: this only blocks a request
// when req.personaId is set, i.e. only for a session that went through
// persona-login (MOD-025 Stage 1) — a household that has never enrolled
// anyone, or any request made with a plain household-PIN session, is
// unaffected by every requireRole() gate below, exactly as documented in
// MOD-025-DESIGN.md's Stage 2 section. This is the one place that
// "unaffected" guarantee is enforced, so every requireRole call site
// automatically inherits it rather than each one re-deciding it.
const ROLE_RANK = { owner: 3, admin: 2, member: 1, guest: 0 };
function requireRole(minRole) {
  const minRank = ROLE_RANK[minRole];
  return (req, res, next) => {
    if (!req.personaId) return next(); // no attributed identity — permissive, matches every request today
    const persona = (req.household.persone || []).find(p => p.id === req.personaId);
    const ruolo = persona?.ruolo || DEFAULT_HOUSEHOLD_ROLE;
    if ((ROLE_RANK[ruolo] ?? 0) < minRank) {
      return sendError(res, 403, "INSUFFICIENT_ROLE", `Richiede ruolo ${minRole} o superiore`, { required: minRole, actual: ruolo });
    }
    next();
  };
}
async function isHouseholdAccount(id, householdId) {
  if (!id || !ObjectId.isValid(id)) return false;
  const acc = await db.collection("accounts").findOne({ _id: new ObjectId(id), householdId }, { projection: { _id: 1 } });
  return !!acc;
}

export {
  sendError,
  requireHousehold,
  requireRole,
  clientIp,
  pinLookupKey,
  hashPin,
  checkLock,
  recordFail,
  clearLock,
  isBlacklisted,
  audit,
  signToken,
  storeToken,
  revokeToken,
  revokeAllTokens,
  revokeTokensForPersona,
  sendLockoutAlert,
  sendPinResetCode,
  COOKIE_OPTS,
  IS_PROD,
  JWT_SECRET,
  ROLE_RANK,
  writeLimiter,
  withTransaction,
  sanitizeText,
  sanitizePersone,
  personaIdFromNome,
  DEFAULT_EMOJIS,
  PERSONA_COLORS,
  sanitizeValuta,
  fetchRatesTable,
  applyValutaTransazione,
  idempotencyKeyFrom,
  claimIdempotencyKey,
  finalizeIdempotencyKey,
  handleIdempotencyClaim,
  hashCapabilityToken,
  findByCapabilityToken,
  isHouseholdAccount,
  calcolaSettleViaggioServer,
  insertSettlementLegs,
  connectDB,
  verifyEmailSetup,
  RICORRENTI_CHECK_MS,
};
