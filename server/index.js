import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { MongoClient, ObjectId } from "mongodb";
import { createHmac, createHash, randomUUID, randomBytes } from "crypto";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import dotenv from "dotenv";
// Yahoo Finance disabled — manual prices only
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import { validateTransactionInput, validateAmount, validateDateStr, computeValidSplits, validateSplits, buildTripExpense, encodeTransactionsCursor, decodeTransactionsCursor, decideIdempotencyClaim, settlementTransactionKey, ValidationError, HOUSEHOLD_ROLES, DEFAULT_HOUSEHOLD_ROLE, validateRuolo, validatePersonaPassword } from "./validation.js";
import { logger, recordRequestMetric, recordJobRun, getMetricsSnapshot, recordTripEmbeddingStats } from "./logger.js";
import { roundAmount, sumAmounts, toMinorUnits, fromMinorUnits, minorUnitsOf } from "../src/lib/money.js";
dotenv.config();

// ─── Email (SendGrid via HTTPS API) ───
// Render (e molti altri host cloud) blocca le porte SMTP in uscita
// (465/587) per prevenire abusi da spam — nodemailer via Gmail SMTP va
// quindi in ETIMEDOUT lì, a prescindere da quanto sia corretta la password.
// SendGrid invia via una normale chiamata HTTPS (porta 443), la stessa
// usata da tutto il resto dell'app: nessun blocco di rete possibile.
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
async function storeToken(jti, householdId) {
  await activeTokensCol.insertOne({ jti, householdId, createdAt: new Date() });
}
async function revokeToken(jti) {
  await activeTokensCol.deleteOne({ jti });
}
async function revokeAllTokens(householdId) {
  await activeTokensCol.deleteMany({ householdId });
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
  return { ...rest, hasCredential: !!(auth && auth.method) };
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

const app = express();
app.set("trust proxy", 1);
const PORT = process.env.PORT || 3001;
const MONGO_URI = process.env.MONGODB_URI || "mongodb://localhost:27017";
const DB_NAME = process.env.DB_NAME || "finanza_tracker";

// ─── Security headers ───
app.use(helmet({ contentSecurityPolicy: false })); // CSP disabled: SPA handles its own

// ─── CORS: restrict to known origins ───
const ALLOWED_ORIGINS = [
  "https://balance-tracker-two.vercel.app",
  "http://localhost:5173",
  "http://localhost:4173",
  "capacitor://localhost",  // Capacitor iOS webview
  "http://localhost",       // Capacitor Android webview
];
// Allow any Vercel preview deploy for this project
const VERCEL_PREVIEW_RE = /^https:\/\/balance-tracker-[a-z0-9-]+-pygabba\.vercel\.app$/;
const CORS_OPTIONS = {
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin) || VERCEL_PREVIEW_RE.test(origin))
      return cb(null, true);
    cb(new Error(`CORS: origin not allowed: ${origin}`));
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  // MOD-004/MOD-003: the offline sync engine sends Idempotency-Key on
  // create requests — same-origin requests (the normal production path via
  // the Vercel proxy) never hit a CORS preflight at all, but any
  // cross-origin path (local dev on a different port, a future separately-
  // hosted client) needs it explicitly allow-listed or the preflight fails
  // and the header gets silently dropped.
  allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key"],
  credentials: true,
  optionsSuccessStatus: 200,
};
app.use(cors(CORS_OPTIONS));
app.options("*", cors(CORS_OPTIONS));
app.use(cookieParser());
app.use(express.json({ limit: "10mb" }));

// ─── Request ID + structured request logging (MOD-023) ───
// Every request gets a correlation id (echoed back as X-Request-Id so a
// person reporting an issue can hand it over, and included in every log
// line for that request) and a structured log entry with method/path/
// status/duration on completion — deliberately NOT the request body or
// query string, since that's exactly where PINs (login), capability
// tokens (widget/calendar — query string), and financial payloads
// (transaction writes) live. sanitizePathForLog additionally redacts the
// one case a token rides in the URL PATH itself rather than the query:
// trip share links.
function sanitizePathForLog(path) {
  return path.replace(/^(\/api\/trips\/shared)\/[^/]+/, "$1/[REDACTED]");
}
app.use((req, res, next) => {
  req.requestId = req.headers["x-request-id"] || randomUUID();
  res.setHeader("X-Request-Id", req.requestId);
  const start = Date.now();
  res.on("finish", () => {
    const durationMs = Date.now() - start;
    const path = sanitizePathForLog(req.path);
    recordRequestMetric(req.method, path, res.statusCode, durationMs);
    const level = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
    logger[level]("http_request", {
      requestId: req.requestId,
      method: req.method,
      path,
      status: res.statusCode,
      durationMs,
      householdId: req.householdId || undefined,
    });
  });
  next();
});

const IS_PROD = process.env.NODE_ENV === "production";
const COOKIE_OPTS = {
  httpOnly: true,
  secure: IS_PROD,      // localhost dev doesn't use HTTPS
  sameSite: "strict",   // safe: prod requests come via Vercel proxy (same-origin); local is same-site
  maxAge: TOKEN_TTL_SECONDS * 1000,
  path: "/",
};

let db, transactionsCol, householdsCol, quotesCol, blacklistCol, auditCol, tripsCol, exchangeRatesCol, idempotencyCol;
// `mongoUri`/`dbName` default to the module-level env-derived values (the
// production path) but can be overridden — this is what lets tests point
// the exact same app at a disposable mongodb-memory-server instance instead
// of a real database, without touching process.env or module-level state
// (MOD-014).
async function connectDB(mongoUri = MONGO_URI, dbName = DB_NAME) {
  const client = new MongoClient(mongoUri); await client.connect();
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
  await db.collection("pinResets").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await householdsCol.createIndex({ householdId: 1 }, { unique: true });
  try { await locksCol.dropIndex("ip_1"); } catch {}
  await locksCol.createIndex({ key: 1 }, { unique: true });
  await locksCol.createIndex({ lockedUntil: 1 }, { expireAfterSeconds: 0, sparse: true });
  await blacklistCol.createIndex({ key: 1 }, { unique: true });
  await activeTokensCol.createIndex({ jti: 1 }, { unique: true });
  await activeTokensCol.createIndex({ householdId: 1 });
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
  doc.importoOriginaleMinorUnits = toMinorUnits(importoInput); // MOD-016
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
function calcolaSettleViaggioServer(trip) {
  const balancesMinor = {};
  for (const e of trip.expenses || []) {
    if (e.splits && e.splits.length > 0) {
      const totalQ = e.splits.reduce((s, sc) => s + sc.quota, 0);
      const importoMinor = minorUnitsOf(e); // MOD-016 contract phase
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
    if (payMinor > 1) settlements.push({ da: debtors[i].id, a: creditors[j].id, importo: fromMinorUnits(payMinor) });
    debtors[i].balMinor -= payMinor;
    creditors[j].balMinor -= payMinor;
    if (debtors[i].balMinor < 1) i++;
    if (creditors[j].balMinor < 1) j++;
  }
  return settlements;
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

      const nameOf = (id) => (claimed.partecipanti || []).find(p => p.id === id)?.nome || id;
      const settlements = calcolaSettleViaggioServer(claimed);
      let allInserted = true;
      for (let i = 0; i < settlements.length; i++) {
        const s = settlements[i];
        // Deterministic per-leg key: a crash-and-resume retry recomputes
        // the exact same settlements array from the exact same trip data
        // (the trip is locked in "settling" the whole time, so nothing
        // about it can change underneath this), so leg i always gets the
        // same key — the unique index is what makes re-inserting it a
        // harmless no-op instead of a duplicate.
        const settlementKey = settlementTransactionKey(_id.toString(), i);
        try {
          // eslint-disable-next-line no-await-in-loop
          await transactionsCol.insertOne({
            householdId: claimed.householdId,
            tipo: "saldo",
            importo: s.importo,
            importoMinorUnits: toMinorUnits(s.importo), // MOD-016
            categoria: "saldo_viaggio",
            descrizione: `Saldo viaggio: ${claimed.nome} (${nameOf(s.da)} → ${nameOf(s.a)})`,
            data: oggi,
            pagatoDa: s.da,
            ricevutoDa: s.a,
            settlementKey,
            createdAt: new Date(),
          });
        } catch (err) {
          if (err?.code === 11000) {
            // Already inserted by an earlier attempt before a crash — this
            // is the resume path working correctly, not an error.
            logger.info("trip_settlement_leg_already_inserted", { tripId: _id.toString(), settlementKey });
          } else {
            errors++;
            logger.error("trip_settlement_leg_insert_failed", { tripId: _id.toString(), settlementKey, error: err?.message });
            allInserted = false;
            break; // stop here, stay in "settling" — the next tick resumes from wherever this left off
          }
        }
      }
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
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30, // secondary ceiling — IP rotation can bypass MongoDB lockout but not this
  standardHeaders: true, legacyHeaders: false,
  message: { error: { code: "RATE_LIMITED", message: "Troppi tentativi di accesso, riprova tra 15 minuti" } },
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true, legacyHeaders: false,
  message: { error: { code: "RATE_LIMITED", message: "Troppi account creati, riprova tra un'ora" } },
});

// MOD-025 Stage 1: outer bound only — a single source hammering the
// endpoint at all, generous like loginLimiter. The real defense is the
// persistent, escalating login_locks lockout inside the handler itself
// (same checkLock/recordFail/clearLock the household PIN uses), keyed
// per-persona so it survives a restart and can't be reset by rotating IPs.
const personaLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true, legacyHeaders: false,
  message: { error: { code: "RATE_LIMITED", message: "Troppi tentativi di accesso, riprova tra 15 minuti" } },
});

const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5, // #8: 5 attempts per 15 min — wrong secret = locked out fast
  standardHeaders: true, legacyHeaders: false,
  message: { error: { code: "RATE_LIMITED", message: "Troppi tentativi admin" } },
});

const quotesLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5, // #4: 5 quote fetches/min — prevents Yahoo Finance hammering
  standardHeaders: true, legacyHeaders: false,
  message: { error: { code: "RATE_LIMITED", message: "Troppe richieste quotazioni, riprova tra un minuto" } },
});

const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120, // #5: 120 writes/min per IP — stops storage flood while allowing normal use
  standardHeaders: true, legacyHeaders: false,
  message: { error: { code: "RATE_LIMITED", message: "Troppe operazioni, riprova tra un minuto" } },
});

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

// ─── Admin middleware ───
function requireAdmin(req, res, next) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return sendError(res, 503, "ADMIN_NOT_CONFIGURED", "Admin non configurato (ADMIN_SECRET mancante)");
  if (req.headers["x-admin-secret"] !== secret) return sendError(res, 401, "ADMIN_UNAUTHORIZED", "Non autorizzato");
  next();
}

// ─── Admin blacklist routes ───
app.get("/api/admin/blacklist", adminLimiter, requireAdmin, async (req, res) => {
  try {
    const docs = await blacklistCol.find({}).sort({ addedAt: -1 }).toArray();
    res.json(docs.map(d => ({ key: d.key, reason: d.reason || "", addedAt: d.addedAt })));
  } catch (e) { sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

app.post("/api/admin/blacklist", adminLimiter, requireAdmin, async (req, res) => {
  try {
    const { key, reason } = req.body || {};
    if (!key || typeof key !== "string") return sendError(res, 400, "MISSING_FIELDS", "key obbligatorio (es. ip:1.2.3.4 o device:uuid)");
    await blacklistCol.updateOne(
      { key },
      { $set: { key, reason: reason || "", addedAt: new Date() } },
      { upsert: true }
    );
    res.status(201).json({ ok: true, key });
  } catch (e) { sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

app.delete("/api/admin/blacklist/:key(*)", adminLimiter, requireAdmin, async (req, res) => {
  try {
    const key = decodeURIComponent(req.params.key);
    const r = await blacklistCol.deleteOne({ key });
    if (r.deletedCount === 0) return sendError(res, 404, "NOT_FOUND", "Non trovato");
    res.json({ ok: true, key });
  } catch (e) { sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

// MOD-023: request counts/latency percentiles/error rates per route, plus
// background-job run/failure counts and a running sync-conflict tally —
// "background-job failures are detectable without reading raw server logs
// manually". Admin-gated like the blacklist routes above; in-memory only
// (resets on restart), which is a deliberate simplicity tradeoff over
// wiring in an external metrics service this project doesn't otherwise need.
app.get("/api/admin/metrics", adminLimiter, requireAdmin, (req, res) => {
  res.json(getMetricsSnapshot());
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
  };
  return null;
}

async function findHouseholdByPin(pin) {
  const lookup = pinLookupKey(pin);
  let dbH = await householdsCol.findOne({ pinLookup: lookup });

  if (!dbH) {
    // Legacy: plain-text pin — migrate on first successful login
    dbH = await householdsCol.findOne({ pin });
    if (dbH) {
      const pinHash = await hashPin(pin);
      await householdsCol.updateOne(
        { _id: dbH._id },
        { $set: { pinHash, pinLookup: lookup }, $unset: { pin: "" } }
      );
    }
  } else if (!await bcrypt.compare(pin, dbH.pinHash)) {
    return null;
  }

  if (!dbH) return null;
  return { householdId: dbH.householdId, nome: dbH.nome, persone: dbH.persone, categorieUscita: dbH.categorieUscita || null, requiresPinChange: dbH.requiresPinChange || false };
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
    // through persona-login on top of the household PIN — absent for
    // every session today, and for any persona that never enrolled a
    // credential. Nothing currently reads it to gate anything (that's
    // Stage 2); it's attached here so it's available when that lands.
    req.household = household; req.householdId = hid; req.jti = jti; req.personaId = personaId || null; next();
  } catch (e) { sendError(res, 500, "INTERNAL_ERROR", "Errore autenticazione"); }
}

app.post("/api/auth/login", loginLimiter, async (req, res) => {
  try {
    const ip = clientIp(req);
    const deviceId = req.body?.deviceId || null;
    const ipKey = `ip:${ip}`;
    // PIN-hash lock: attacker rotating IPs/devices still hits this — same PIN tried 10x = lockout
    const pinKey = req.body?.pin ? `pin:${pinLookupKey(req.body.pin)}` : null;
    const devKey = deviceId ? `device:${deviceId}` : null;

    // Check blacklist first — permanent block
    const [ipBanned, devBanned] = await Promise.all([
      isBlacklisted(ipKey),
      devKey ? isBlacklisted(devKey) : false,
    ]);
    if (ipBanned || devBanned) {
      audit("login_blocked", { ip, deviceId, success: false, detail: "blacklisted" });
      return sendError(res, 403, "ACCESS_BLOCKED", "Accesso permanentemente bloccato");
    }

    // Check all three locks — IP, device, and PIN-hash
    const [ipLock, devLock, pinLock] = await Promise.all([
      checkLock(ipKey),
      devKey ? checkLock(devKey) : null,
      pinKey ? checkLock(pinKey) : null,
    ]);
    const activeLock = (ipLock?.lockedUntil && ipLock) || (devLock?.lockedUntil && devLock) || (pinLock?.lockedUntil && pinLock);
    if (activeLock) {
      const mins = Math.ceil((activeLock.lockedUntil - new Date()) / 60000);
      audit("login_blocked", { ip, deviceId, success: false, detail: `locked ${mins}m` });
      return sendError(res, 429, "RATE_LIMITED", `Accesso bloccato. Riprova tra ${mins} minuti.`, { retryAfterMinutes: mins });
    }

    const household = await findHouseholdByPin(req.body?.pin);
    if (!household) {
      const [ipNowLocked, devNowLocked, pinNowLocked] = await Promise.all([
        recordFail(ipKey),
        devKey ? recordFail(devKey) : false,
        pinKey ? recordFail(pinKey) : false,
      ]);
      if (ipNowLocked || devNowLocked || pinNowLocked) sendLockoutAlert(ip, deviceId).catch(console.error);
      audit("login_fail", { ip, deviceId, success: false });
      return sendError(res, 401, "INVALID_PIN", "PIN non valido");
    }

    await Promise.all([clearLock(ipKey), devKey ? clearLock(devKey) : null, pinKey ? clearLock(pinKey) : null]);
    const { token, jti } = signToken(household.householdId);
    await storeToken(jti, household.householdId);
    audit("login_success", { householdId: household.householdId, ip, deviceId });
    res.cookie("token", token, COOKIE_OPTS);
    res.json({ ...household, persone: sanitizePersone(household.persone) });
  } catch (e) { logger.error("login_failed", { requestId: req.requestId, error: e.message }); sendError(res, 500, "INTERNAL_ERROR", "Errore login"); }
});

app.post("/api/auth/logout", requireHousehold, async (req, res) => {
  try {
    await revokeToken(req.jti);
    audit("logout", { householdId: req.householdId, ip: clientIp(req) });
    res.clearCookie("token", { path: "/", httpOnly: true, secure: IS_PROD, sameSite: "strict" });
    res.json({ ok: true });
  } catch (e) { sendError(res, 500, "INTERNAL_ERROR", "Errore logout"); }
});

app.post("/api/auth/register", registerLimiter, async (req, res) => {
  try {
    const { nome, persone, pin, email } = req.body || {};
    if (!nome || !pin || !Array.isArray(persone) || persone.length === 0)
      return sendError(res, 400, "MISSING_FIELDS", "Campi obbligatori: nome, persone, pin");
    if (!/^\d{6,8}$/.test(pin))
      return sendError(res, 400, "INVALID_PIN_FORMAT", "Il PIN deve essere di 6-8 cifre");
    let emailNorm = null;
    if (email) {
      emailNorm = String(email).trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm) || emailNorm.length > 200)
        return sendError(res, 400, "INVALID_EMAIL", "Email non valida");
    }

    // Build householdId: slug from nome + random suffix
    const slug = nome.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const suffix = Math.random().toString(36).slice(2, 7);
    const householdId = `${slug}-${suffix}`;

    const DEFAULT_EMOJIS = ["👤", "👩", "👨", "🧑", "👧", "👦"];
    const COLORS = ["#6C5CE7", "#E84393", "#0984E3", "#00B894", "#FD79A8", "#FDCB6E"];
    // MOD-025 foundation: the first persona (whoever filled in the
    // registration form) defaults to "owner", everyone else to "member" —
    // a reasonable default, not a security decision (see validateRuolo's
    // comment: roles aren't enforced by authentication yet). A caller can
    // override per-persona via an object's `ruolo` field.
    let personeFormatted;
    try {
      personeFormatted = persone.map((p, i) => {
        const explicitRuolo = typeof p === "object" ? p.ruolo : null;
        const ruolo = explicitRuolo != null ? validateRuolo(explicitRuolo) : (i === 0 ? "owner" : DEFAULT_HOUSEHOLD_ROLE);
        return {
          id: (typeof p === "string" ? p : p.nome).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, ""),
          nome: typeof p === "string" ? p : p.nome,
          emoji: (typeof p === "object" && p.emoji) ? p.emoji : DEFAULT_EMOJIS[i % DEFAULT_EMOJIS.length],
          colore: COLORS[i % COLORS.length],
          ruolo,
        };
      });
    } catch (ve) {
      if (ve instanceof ValidationError) return sendError(res, 400, ve.code, ve.message, ve.fields);
      throw ve;
    }

    const pinHash = await hashPin(pin);
    const doc = { householdId, nome, persone: personeFormatted, pinHash, pinLookup: pinLookupKey(pin), createdAt: new Date() };
    // Sparse unique index on email requires the field to be ABSENT (not null)
    // for docs without an email — a stored `null` still gets indexed, so a
    // second no-email registration would collide on the first one.
    if (emailNorm) doc.email = emailNorm;
    await householdsCol.insertOne(doc);
    const { token, jti } = signToken(householdId);
    await storeToken(jti, householdId);
    audit("register", { householdId, ip: clientIp(req) });
    res.cookie("token", token, COOKIE_OPTS);
    res.status(201).json({ householdId, nome, persone: sanitizePersone(personeFormatted) });
  } catch (e) {
    if (e.code === 11000 && e.message?.includes("pinLookup")) return sendError(res, 409, "PIN_ALREADY_IN_USE", "PIN già in uso, scegline un altro");
    if (e.code === 11000 && e.message?.includes("email")) return sendError(res, 409, "EMAIL_ALREADY_IN_USE", "Email già collegata a un altro gruppo");
    logger.error("register_failed", { requestId: req.requestId, error: e.message }); // never log e directly — req.body may appear in stack
    sendError(res, 500, "INTERNAL_ERROR", "Errore durante la registrazione");
  }
});

// ─── DELETE household ───
// ─── Change PIN ───
app.put("/api/auth/pin", requireHousehold, async (req, res) => {
  try {
    const { newPin } = req.body || {};
    if (!newPin || !/^\d{6,8}$/.test(newPin))
      return sendError(res, 400, "INVALID_PIN_FORMAT", "Il nuovo PIN deve essere di 6-8 cifre");
    const pinHash = await hashPin(newPin);
    const pinLookup = pinLookupKey(newPin);
    await householdsCol.updateOne(
      { householdId: req.householdId },
      { $set: { pinHash, pinLookup, requiresPinChange: false, updatedAt: new Date() }, $unset: { pin: "" } }
    );
    await revokeAllTokens(req.householdId);
    const { token, jti } = signToken(req.householdId);
    await storeToken(jti, req.householdId);
    audit("pin_change", { householdId: req.householdId, ip: clientIp(req) });
    res.cookie("token", token, COOKIE_OPTS);
    res.json({ ok: true });
  } catch (e) { logger.error("pin_change_failed", { requestId: req.requestId, householdId: req.householdId, error: e.message }); sendError(res, 500, "INTERNAL_ERROR", "Errore aggiornamento PIN"); }
});

// ─── Recupero PIN dimenticato ───
const forgotPinLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false, message: { error: { code: "RATE_LIMITED", message: "Troppi tentativi, riprova tra qualche minuto" } } });

app.post("/api/auth/forgot-pin/request", forgotPinLimiter, async (req, res) => {
  // Risposta generica sempre uguale, email esista o meno: non si conferma
  // né si smentisce l'esistenza di un account legato a quell'indirizzo.
  const GENERIC_OK = { ok: true, message: "Se l'email è collegata a un account, riceverai un codice a breve." };
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendError(res, 400, "INVALID_EMAIL", "Email non valida");

    const household = await householdsCol.findOne({ email });
    if (!household) return res.json(GENERIC_OK); // non riveliamo se l'email esiste

    const code = String(Math.floor(100000 + Math.random() * 900000)); // 6 cifre
    const codeHash = await bcrypt.hash(code, 10);
    await db.collection("pinResets").deleteMany({ householdId: household.householdId }); // invalida richieste precedenti
    await db.collection("pinResets").insertOne({
      householdId: household.householdId, codeHash, attempts: 0,
      createdAt: new Date(), expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    });
    // Invio in background, senza "await": anche una chiamata HTTPS può
    // essere lenta, e non deve mai tenere in sospeso la risposta al client
    // — altrimenti resta bloccato su "Invio..." indefinitamente.
    sendPinResetCode(email, code, household.nome).catch(mailErr => {
      logger.error("pin_reset_email_send_failed", { requestId: req.requestId, code: mailErr.code || null, error: mailErr.message, response: mailErr.response || undefined });
      // Non sveliamo all'esterno se l'invio è fallito per non far trapelare l'esistenza dell'account
    });
    audit("pin_reset_requested", { householdId: household.householdId, ip: clientIp(req) });
    res.json(GENERIC_OK);
  } catch (e) { logger.error("forgot_pin_request_failed", { requestId: req.requestId, error: e.message }); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

app.post("/api/auth/forgot-pin/confirm", forgotPinLimiter, async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const code = String(req.body?.code || "").trim();
    const newPin = req.body?.newPin;
    if (!email || !code || !newPin) return sendError(res, 400, "MISSING_FIELDS", "Campi obbligatori: email, codice, nuovo PIN");
    if (!/^\d{6,8}$/.test(newPin)) return sendError(res, 400, "INVALID_PIN_FORMAT", "Il nuovo PIN deve essere di 6-8 cifre");

    const household = await householdsCol.findOne({ email });
    if (!household) return sendError(res, 400, "INVALID_RESET_CODE", "Codice non valido o scaduto");

    const reset = await db.collection("pinResets").findOne({ householdId: household.householdId });
    if (!reset || reset.expiresAt < new Date()) return sendError(res, 400, "INVALID_RESET_CODE", "Codice non valido o scaduto");
    if (reset.attempts >= 5) {
      await db.collection("pinResets").deleteOne({ _id: reset._id });
      return sendError(res, 429, "TOO_MANY_ATTEMPTS", "Troppi tentativi. Richiedi un nuovo codice.");
    }

    const valid = await bcrypt.compare(code, reset.codeHash);
    if (!valid) {
      await db.collection("pinResets").updateOne({ _id: reset._id }, { $inc: { attempts: 1 } });
      return sendError(res, 400, "INVALID_RESET_CODE", "Codice non corretto");
    }

    const pinHash = await hashPin(newPin);
    const pinLookup = pinLookupKey(newPin);
    await householdsCol.updateOne(
      { householdId: household.householdId },
      { $set: { pinHash, pinLookup, requiresPinChange: false, updatedAt: new Date() }, $unset: { pin: "" } }
    );
    await db.collection("pinResets").deleteOne({ _id: reset._id });
    await revokeAllTokens(household.householdId); // disconnette ogni sessione precedente, per sicurezza

    const { token, jti } = signToken(household.householdId);
    await storeToken(jti, household.householdId);
    audit("pin_reset_completed", { householdId: household.householdId, ip: clientIp(req) });
    res.cookie("token", token, COOKIE_OPTS);
    res.json({ id: household.householdId, nome: household.nome, persone: sanitizePersone(household.persone) });
  } catch (e) {
    if (e.code === 11000) return sendError(res, 409, "PIN_ALREADY_IN_USE", "PIN già in uso, scegline un altro");
    logger.error("forgot_pin_confirm_failed", { requestId: req.requestId, error: e.message });
    sendError(res, 500, "INTERNAL_ERROR", "Errore");
  }
});

// Aggiungere/aggiornare l'email di recupero da account già autenticato
// (fondamentale per le case create prima che questa funzione esistesse).
app.put("/api/auth/recovery-email", writeLimiter, requireHousehold, async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200)
      return sendError(res, 400, "INVALID_EMAIL", "Email non valida");
    await householdsCol.updateOne({ householdId: req.householdId }, { $set: { email, updatedAt: new Date() } });
    audit("recovery_email_set", { householdId: req.householdId, ip: clientIp(req) });
    res.json({ ok: true });
  } catch (e) {
    if (e.code === 11000) return sendError(res, 409, "EMAIL_ALREADY_IN_USE", "Email già collegata a un altro gruppo");
    console.error("Set recovery email error:", e.message); sendError(res, 500, "INTERNAL_ERROR", "Errore");
  }
});

app.delete("/api/auth/household", requireHousehold, async (req, res) => {
  try {
    const { pin } = req.body || {};
    if (!pin) return sendError(res, 400, "MISSING_PIN", "PIN obbligatorio per confermare");

    // Verify PIN matches
    const household = await householdsCol.findOne({ householdId: req.householdId });
    if (!household) return sendError(res, 404, "NOT_FOUND", "Account non trovato");
    const pinValid = household.pinHash
      ? await bcrypt.compare(pin, household.pinHash)
      : household.pin === pin;
    if (!pinValid) return sendError(res, 401, "INVALID_PIN", "PIN non corretto");

    // Delete all data for this household
    await transactionsCol.deleteMany({ householdId: req.householdId });
    await db.collection("positions").deleteMany({ householdId: req.householdId });
    await db.collection("goals").deleteMany({ householdId: req.householdId });
    await db.collection("accounts").deleteMany({ householdId: req.householdId });
    await tripsCol.deleteMany({ householdId: req.householdId });
    await quotesCol.deleteMany({ householdId: req.householdId });
    await db.collection("pinResets").deleteMany({ householdId: req.householdId });
    await revokeAllTokens(req.householdId);
    await householdsCol.deleteOne({ householdId: req.householdId });
    audit("household_delete", { householdId: req.householdId, ip: clientIp(req) });
    res.clearCookie("token", { path: "/", httpOnly: true, secure: IS_PROD, sameSite: "strict" });
    res.json({ ok: true });
  } catch (e) { console.error("Delete household error:", e.message); sendError(res, 500, "INTERNAL_ERROR", "Errore durante l'eliminazione"); }
});

// ─── GET household info ───
app.get("/api/household", requireHousehold, (req, res) => {
  res.json({ id: req.household.id, nome: req.household.nome, persone: sanitizePersone(req.household.persone), hasRecoveryEmail: !!req.household.email, valutaBase: req.household.valutaBase || "EUR" });
});

// ─── Base currency ───
app.put("/api/household/valuta", writeLimiter, requireHousehold, async (req, res) => {
  try {
    const valuta = sanitizeValuta(req.body?.valutaBase);
    if (!valuta) return sendError(res, 400, "INVALID_CURRENCY", "Valuta non supportata");
    await householdsCol.updateOne({ householdId: req.householdId }, { $set: { valutaBase: valuta, updatedAt: new Date() } });
    res.json({ valutaBase: valuta });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

// ─── Household member roles (MOD-025 foundation) ───
// Advisory only — see validateRuolo's comment. Anyone with the household
// PIN can already act as any persona; this doesn't add a new permission
// boundary, it lets a household record who's meant to be in charge of
// what. Refuses to demote/remove the household's last "owner" — a
// data-integrity guard (a household with zero owners is a dead end no one
// can fix from inside the app), not a security control.
app.put("/api/household/persone/:id/ruolo", writeLimiter, requireHousehold, async (req, res) => {
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

// ─── Persona credentials (MOD-025 Stage 1) ───
// Enroll/change a persona's own password. Requires the household PIN
// (already enforced by requireHousehold) PLUS — if this persona already
// has a credential — that credential too, so knowing only the shared PIN
// is never enough to silently take over an already-enrolled identity.
// Zero enforcement: any PIN-holder can enroll/change ANY persona's
// credential when that persona has none yet (first-time setup on a
// shared device, one household member setting it up for another) — the
// "themselves or an admin" restriction from the design doc is Stage 2
// material once role enforcement exists to express it.
app.post("/api/auth/persona-credential", writeLimiter, requireHousehold, async (req, res) => {
  try {
    const { personaId, newPassword, currentPassword } = req.body || {};
    if (!personaId || typeof personaId !== "string") return sendError(res, 400, "MISSING_FIELDS", "personaId obbligatorio");
    const persone = req.household.persone || [];
    const target = persone.find(p => p.id === personaId);
    if (!target) return sendError(res, 404, "NOT_FOUND", "Persona non trovata");

    let validatedPassword;
    try { validatedPassword = validatePersonaPassword(newPassword); }
    catch (ve) { if (ve instanceof ValidationError) return sendError(res, 400, ve.code, ve.message, ve.fields); throw ve; }

    if (target.auth?.method === "password") {
      if (!currentPassword || !(await bcrypt.compare(currentPassword, target.auth.passwordHash))) {
        return sendError(res, 401, "INVALID_CURRENT_PASSWORD", "Password attuale non corretta");
      }
    }

    const passwordHash = await bcrypt.hash(validatedPassword, 10);
    const updatedPersone = persone.map(p => p.id === personaId
      ? { ...p, auth: { method: "password", passwordHash, enrolledAt: new Date() } }
      : p);
    await householdsCol.updateOne({ householdId: req.householdId }, { $set: { persone: updatedPersone, updatedAt: new Date() } });
    audit("persona_credential_enrolled", { householdId: req.householdId, ip: clientIp(req), detail: { personaId } }); // never the password/hash
    res.json({ persone: sanitizePersone(updatedPersone) });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

app.delete("/api/auth/persona-credential/:id", writeLimiter, requireHousehold, async (req, res) => {
  try {
    const persone = req.household.persone || [];
    const target = persone.find(p => p.id === req.params.id);
    if (!target) return sendError(res, 404, "NOT_FOUND", "Persona non trovata");
    const updatedPersone = persone.map(p => p.id === req.params.id ? { ...p, auth: null } : p);
    await householdsCol.updateOne({ householdId: req.householdId }, { $set: { persone: updatedPersone, updatedAt: new Date() } });
    await clearLock(`persona:${req.householdId}:${req.params.id}`); // an un-enrolled persona shouldn't stay locked from a credential that no longer exists
    audit("persona_credential_removed", { householdId: req.householdId, ip: clientIp(req), detail: { personaId: req.params.id } });
    res.json({ persone: sanitizePersone(updatedPersone) });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

// Step 2 of the layered login flow (see MOD-025-DESIGN.md) — requires an
// existing household session (the PIN, step 1), issues a NEW session that
// additionally names which persona this is. Rate limiting mirrors the
// household PIN's own two-layer pattern: personaLoginLimiter as a blunt
// IP-keyed outer bound, plus the same persistent login_locks lockout the
// PIN uses, keyed per-persona so an attacker rotating IPs/devices still
// hits it and a lockout on one persona never affects any other persona or
// the household PIN itself.
app.post("/api/auth/persona-login", personaLoginLimiter, requireHousehold, async (req, res) => {
  try {
    const { personaId, password } = req.body || {};
    if (!personaId || typeof personaId !== "string") return sendError(res, 400, "MISSING_FIELDS", "personaId obbligatorio");
    const lockKey = `persona:${req.householdId}:${personaId}`;
    const lock = await checkLock(lockKey);
    if (lock?.lockedUntil) {
      const mins = Math.ceil((lock.lockedUntil - new Date()) / 60000);
      audit("persona_login_blocked", { householdId: req.householdId, ip: clientIp(req), success: false, detail: { personaId, lockedMinutes: mins } });
      return sendError(res, 429, "RATE_LIMITED", `Accesso bloccato. Riprova tra ${mins} minuti.`, { retryAfterMinutes: mins });
    }

    const target = (req.household.persone || []).find(p => p.id === personaId);
    if (!target || target.auth?.method !== "password") {
      return sendError(res, 400, "NO_PERSONA_CREDENTIAL", "Questa persona non ha una credenziale configurata");
    }

    const valid = typeof password === "string" && await bcrypt.compare(password, target.auth.passwordHash);
    if (!valid) {
      const nowLocked = await recordFail(lockKey);
      audit("persona_login_fail", { householdId: req.householdId, ip: clientIp(req), success: false, detail: { personaId, locked: nowLocked } });
      return sendError(res, 401, "INVALID_PERSONA_PASSWORD", "Password non corretta");
    }

    await clearLock(lockKey);
    const { token, jti } = signToken(req.householdId, personaId);
    await storeToken(jti, req.householdId);
    await revokeToken(req.jti); // the household-only session this replaces
    audit("persona_login_success", { householdId: req.householdId, ip: clientIp(req), detail: { personaId } });
    res.cookie("token", token, COOKIE_OPTS);
    res.json({ personaId });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

app.get("/api/exchange-rates", requireHousehold, async (req, res) => {
  try {
    const base = req.household.valutaBase || "EUR";
    const { rates, stale } = await fetchRatesTable(base);
    if (!rates) {
      return res.status(503).json({ error: { code: "EXCHANGE_RATE_UNAVAILABLE", message: "Cambio valuta non disponibile al momento, riprova più tardi." } });
    }
    res.json({ base, rates: { ...rates, [base]: 1 }, stale });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
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

app.get("/api/transactions", exportLimiter, requireHousehold, async (req, res) => {
  try {
    const { tipo, categoria, pagatoDa, contoId, meseAnno, from, to, cursor } = req.query;
    const filter = { householdId: req.householdId, deletedAt: null };
    if (tipo) filter.tipo = tipo;
    if (categoria) filter.categoria = categoria;
    if (pagatoDa) filter.pagatoDa = pagatoDa;
    if (meseAnno) {
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
    if (contoId) andClauses.push({ $or: [{ contoId }, { contoDa: contoId }, { contoA: contoId }] });
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
app.post("/api/transactions", writeLimiter, requireHousehold, async (req, res) => {
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
      validated = validateTransactionInput(b, { householdPersonIds, accountIds });
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
app.delete("/api/transactions/:id", writeLimiter, requireHousehold, async (req, res) => {
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
app.get("/api/transactions/trash", requireHousehold, async (req, res) => {
  try {
    const docs = await transactionsCol.find({ householdId: req.householdId, deletedAt: { $ne: null } })
      .sort({ deletedAt: -1 }).toArray();
    res.json(docs.map(d => { const id = d._id.toString(); delete d._id; delete d.householdId; return { id, ...d }; }));
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

app.post("/api/transactions/:id/restore", writeLimiter, requireHousehold, async (req, res) => {
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

app.delete("/api/transactions/:id/permanent", writeLimiter, requireHousehold, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return sendError(res, 400, "INVALID_ID", "ID non valido");
    const r = await transactionsCol.deleteOne({ _id: new ObjectId(req.params.id), householdId: req.householdId, deletedAt: { $ne: null } });
    if (r.deletedCount === 0) return sendError(res, 404, "NOT_FOUND", "Non trovata nel cestino");
    res.json({ deleted: true, id: req.params.id });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

app.delete("/api/transactions/trash/empty", writeLimiter, requireHousehold, async (req, res) => {
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
app.put("/api/transactions/:id", writeLimiter, requireHousehold, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return sendError(res, 400, "INVALID_ID", "ID non valido");
    const existing = await transactionsCol.findOne({ _id: new ObjectId(req.params.id), householdId: req.householdId });
    if (!existing) return sendError(res, 404, "NOT_FOUND", "Non trovata");

    const householdPersonIds = (req.household.persone || []).map(p => p.id);
    const accountDocs = await db.collection("accounts").find({ householdId: req.householdId }, { projection: { _id: 1 } }).toArray();
    const accountIds = new Set(accountDocs.map(a => a._id.toString()));

    let update;
    try {
      update = validateTransactionInput(req.body, { householdPersonIds, accountIds, partial: true, existing });
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
        unset.valuta = ""; unset.importoOriginale = ""; unset.tassoCambio = ""; unset.tassoCambioObsoleto = "";
      }
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

// ─── N-person debt matrix ───
app.get("/api/stats/debiti", requireHousehold, async (req, res) => {
  try {
    const txs = await transactionsCol.find({
      householdId: req.householdId, tipo: "uscita", pagatoDa: { $ne: null }, deletedAt: null
    }).toArray();

    // Also fetch saldo transactions to account for settlements
    // (trip settlements "saldo_viaggio" are record-only and excluded: their
    // underlying expenses live in the trips collection, not in this ledger)
    const saldi = await transactionsCol.find({
      householdId: req.householdId, tipo: "saldo", pagatoDa: { $ne: null }, ricevutoDa: { $ne: null },
      categoria: { $ne: "saldo_viaggio" }, deletedAt: null
    }).toArray();

    // Per-person net balance
    // MOD-016: accumulate in integer minor units, not raw floats — same
    // reasoning as calcolaDebitiMatrix (src/lib/finance.js) and
    // calcolaSettleViaggioServer above, which this endpoint otherwise
    // duplicates.
    const netPerPersonMinor = {};
    function addAmountMinor(id, deltaMinor) { netPerPersonMinor[id] = (netPerPersonMinor[id] || 0) + deltaMinor; }

    for (const t of txs) {
      const payer = t.pagatoDa;
      let shares = [];
      if (t.splits && Array.isArray(t.splits) && t.splits.length > 0) {
        shares = t.splits;
      } else if (t.splitPagante != null) {
        const other = req.household.persone.find(p => p.id !== payer);
        if (other) shares = [{ personaId: payer, quota: t.splitPagante }, { personaId: other.id, quota: 100 - t.splitPagante }];
      }
      if (!shares.length) continue;
      const totalQ = shares.reduce((s, sh) => s + (sh.quota || 0), 0);
      if (totalQ <= 0) continue;
      const importoMinor = minorUnitsOf(t); // MOD-016 contract phase
      for (const sh of shares) {
        if (sh.personaId === payer) continue;
        const owedMinor = Math.round(importoMinor * (sh.quota / totalQ));
        addAmountMinor(payer, +owedMinor);
        addAmountMinor(sh.personaId, -owedMinor);
      }
    }

    // Settlements reduce balances
    for (const s of saldi) {
      const importoMinor = minorUnitsOf(s); // MOD-016 contract phase
      addAmountMinor(s.pagatoDa, +importoMinor);
      addAmountMinor(s.ricevutoDa, -importoMinor);
    }

    // Greedy creditor/debtor matching
    const creditors = [], debtors = [];
    for (const [id, balMinor] of Object.entries(netPerPersonMinor)) {
      if (balMinor >  1) creditors.push({ id, balMinor });
      if (balMinor < -1) debtors.push({ id, balMinor: -balMinor });
    }
    creditors.sort((a, b) => b.balMinor - a.balMinor);
    debtors.sort((a, b) => b.balMinor - a.balMinor);

    const debiti = [];
    let i = 0, j = 0;
    while (i < debtors.length && j < creditors.length) {
      const payMinor = Math.min(debtors[i].balMinor, creditors[j].balMinor);
      debiti.push({ da: debtors[i].id, a: creditors[j].id, importo: fromMinorUnits(payMinor) });
      debtors[i].balMinor   -= payMinor;
      creditors[j].balMinor -= payMinor;
      if (debtors[i].balMinor   < 1) i++;
      if (creditors[j].balMinor < 1) j++;
    }
    res.json({ debiti });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

// ─── Stats summary ───
app.get("/api/stats/summary", requireHousehold, async (req, res) => {
  try {
    const match = { householdId: req.householdId, deletedAt: null };
    if (req.query.meseAnno) {
      const [a, m] = req.query.meseAnno.split("-").map(Number);
      match.data = { $gte: new Date(a, m - 1, 1).toISOString().slice(0, 10), $lte: new Date(a, m, 0).toISOString().slice(0, 10) };
    }
    const results = await transactionsCol.aggregate([
      { $match: match },
      { $group: { _id: { tipo: "$tipo", categoria: "$categoria", pagatoDa: "$pagatoDa" }, totale: { $sum: "$importo" }, count: { $sum: 1 } } }
    ]).toArray();
    res.json(results);
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

app.get("/api/health", (req, res) => res.json({ status: "ok", db: !!db }));

// ─── Custom Categories ───
// Already loaded in requireHousehold via findHousehold — just return it
app.get("/api/categorie", requireHousehold, (req, res) => {
  res.json({ categorie: req.household.categorieUscita || null });
});

app.put("/api/categorie", requireHousehold, async (req, res) => {
  try {
    const { categorie } = req.body || {};
    if (!Array.isArray(categorie) || categorie.length === 0)
      return sendError(res, 400, "INVALID_CATEGORIES", "categorie deve essere un array non vuoto");
    if (categorie.length > 100)
      return sendError(res, 400, "TOO_MANY_CATEGORIES", "Massimo 100 categorie");
    // Sanitize: allow strings or objects with known keys only
    const ALLOWED_CAT_KEYS = new Set(["nome", "etichetta", "label", "emoji", "icona", "colore", "color", "id"]);
    const sanitized = categorie.map(c => {
      if (typeof c === "string") return sanitizeText(c, 100);
      if (c && typeof c === "object" && !Array.isArray(c)) {
        const safe = {};
        for (const k of ALLOWED_CAT_KEYS) {
          if (c[k] !== undefined) safe[k] = sanitizeText(String(c[k]), 100);
        }
        return safe;
      }
      return null;
    }).filter(Boolean);
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
app.get("/api/trip-categories", requireHousehold, async (req, res) => {
  res.json({ categorie: req.household.tripCategories || null });
});

app.put("/api/trip-categories", writeLimiter, requireHousehold, async (req, res) => {
  try {
    const { categorie } = req.body || {};
    if (!Array.isArray(categorie) || categorie.length === 0)
      return sendError(res, 400, "INVALID_CATEGORIES", "categorie deve essere un array non vuoto");
    if (categorie.length > 100)
      return sendError(res, 400, "TOO_MANY_CATEGORIES", "Massimo 100 categorie");
    const ALLOWED_CAT_KEYS = new Set(["nome", "etichetta", "label", "emoji", "icona", "colore", "color", "id"]);
    const sanitized = categorie.map(c => {
      if (c && typeof c === "object" && !Array.isArray(c)) {
        const safe = {};
        for (const k of ALLOWED_CAT_KEYS) {
          if (c[k] !== undefined) safe[k] = sanitizeText(String(c[k]), 100);
        }
        return safe;
      }
      return null;
    }).filter(Boolean);
    if (sanitized.length === 0)
      return sendError(res, 400, "NO_VALID_CATEGORIES", "Nessuna categoria valida");
    await householdsCol.updateOne(
      { householdId: req.householdId },
      { $set: { tripCategories: sanitized, updatedAt: new Date() } }
    );
    res.json({ ok: true });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
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
async function isHouseholdAccount(id, householdId) {
  if (!id || !ObjectId.isValid(id)) return false;
  const acc = await db.collection("accounts").findOne({ _id: new ObjectId(id), householdId }, { projection: { _id: 1 } });
  return !!acc;
}

app.get("/api/positions", requireHousehold, requirePortfolioAccess, async (req, res) => {
  try {
    const col = db.collection("positions");
    const docs = await col.find({ householdId: req.householdId }).sort({ dataAcquisto: -1 }).toArray();
    res.json(docs.map(d => { const id = d._id.toString(); delete d._id; delete d.householdId; return { id, ...d }; }));
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

app.post("/api/positions", writeLimiter, requireHousehold, requirePortfolioAccess, async (req, res) => {
  try {
    const idemKey = idempotencyKeyFrom(req);
    const claim = await claimIdempotencyKey(req.householdId, idemKey);
    if (handleIdempotencyClaim(claim, res)) return;

    const b = req.body;
    if (!b.ticker || !b.quantita || !b.prezzoAcquisto) return sendError(res, 400, "MISSING_FIELDS", "Campi obbligatori: ticker, quantita, prezzoAcquisto");
    const ticker = b.ticker.toUpperCase().trim();
    if (!/^[A-Z0-9.^=\-]{1,20}$/.test(ticker)) return sendError(res, 400, "INVALID_TICKER", "Ticker non valido (max 20 caratteri alfanumerici)");
    const doc = {
      householdId: req.householdId,
      ticker,
      nome: sanitizeText(b.nome || ticker, 100),
      quantita: parseFloat(b.quantita),
      prezzoAcquisto: parseFloat(b.prezzoAcquisto),
      prezzoAcquistoMinorUnits: toMinorUnits(parseFloat(b.prezzoAcquisto)), // MOD-016
      dataAcquisto: b.dataAcquisto || new Date().toISOString().slice(0, 10),
      valuta: b.valuta || "EUR",
      note: sanitizeText(b.note, 500),
      tipo: b.tipo || "buy", // buy or sell
      createdAt: new Date(),
    };
    const result = await db.collection("positions").insertOne(doc);
    const id = result.insertedId.toString(); delete doc.householdId;
    const responseBody = { id, ...doc };
    await finalizeIdempotencyKey(req.householdId, idemKey, 201, responseBody);
    res.status(201).json(responseBody);
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

app.delete("/api/positions/:id", requireHousehold, requirePortfolioAccess, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return sendError(res, 400, "INVALID_ID", "ID non valido");
    const r = await db.collection("positions").deleteOne({ _id: new ObjectId(req.params.id), householdId: req.householdId });
    if (r.deletedCount === 0) return sendError(res, 404, "NOT_FOUND", "Non trovata");
    res.json({ deleted: true, id: req.params.id });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

// ─── Manual price overrides (stored in quotes_cache, scoped by householdId) ───
app.get("/api/positions/prices", requireHousehold, async (req, res) => {
  try {
    const docs = await quotesCol.find({ householdId: req.householdId, manualPrice: { $exists: true } }).toArray();
    const manualPrices = {};
    for (const d of docs) manualPrices[d.ticker] = d.manualPrice;
    res.json({ manualPrices });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

app.put("/api/positions/prices", requireHousehold, async (req, res) => {
  try {
    const { manualPrices } = req.body || {};
    if (typeof manualPrices !== "object" || manualPrices === null || Array.isArray(manualPrices))
      return sendError(res, 400, "INVALID_MANUAL_PRICES", "manualPrices deve essere un oggetto");
    const TICKER_RE = /^[A-Z0-9.^=\-]{1,20}$/;
    const entries = Object.entries(manualPrices);
    if (entries.length > 200)
      return sendError(res, 400, "TOO_MANY_PRICES", "Massimo 200 prezzi manuali");
    // Remove all existing manual prices for this household, then upsert validated ones
    await quotesCol.deleteMany({ householdId: req.householdId, manualPrice: { $exists: true } });
    for (const [rawTicker, rawPrice] of entries) {
      const ticker = String(rawTicker).toUpperCase().trim();
      if (!TICKER_RE.test(ticker)) continue; // skip malformed keys
      const price = typeof rawPrice === "number" ? rawPrice : parseFloat(rawPrice);
      if (!Number.isFinite(price) || price < 0) continue; // skip non-numeric or negative
      await quotesCol.updateOne(
        { ticker, householdId: req.householdId },
        { $set: { ticker, householdId: req.householdId, manualPrice: price, updatedAt: new Date() } },
        { upsert: true }
      );
    }
    res.json({ ok: true });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

// Stock quotes endpoint — DISABLED, only manual prices are supported now.
app.get("/api/quotes", quotesLimiter, requireHousehold, async (req, res) => {
  sendError(res, 410, "QUOTES_DISABLED", "API quotazioni rimossa. Usa i prezzi manuali.");
});

// Savings Goals
app.get("/api/goals", requireHousehold, async (req, res) => {
  try {
    const col = db.collection("goals");
    const docs = await col.find({ householdId: req.householdId }).sort({ createdAt: -1 }).toArray();
    res.json(docs.map(d => { const id = d._id.toString(); delete d._id; delete d.householdId; return { id, ...d }; }));
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

app.post("/api/goals", writeLimiter, requireHousehold, async (req, res) => {
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
    const doc = {
      householdId: req.householdId,
      nome: sanitizeText(b.nome, 100),
      targetAmount: parseFloat(b.targetAmount),
      targetAmountMinorUnits: toMinorUnits(parseFloat(b.targetAmount)), // MOD-016
      targetDate: b.targetDate || null,
      currentAmount: parseFloat(b.currentAmount) || 0,
      currentAmountMinorUnits: toMinorUnits(parseFloat(b.currentAmount) || 0), // MOD-016
      contributionType: b.contributionType || "manual",
      contributionValue: b.contributionType !== "manual" ? parseFloat(b.contributionValue) || 0 : 0,
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

app.put("/api/goals/:id", writeLimiter, requireHousehold, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return sendError(res, 400, "INVALID_ID", "ID non valido");
    const b = req.body;
    // MOD-009: same ownership check as create — a PUT can just as easily
    // try to attach the goal to someone else's account.
    if (b.contoId !== undefined && b.contoId && !(await isHouseholdAccount(b.contoId, req.householdId))) {
      return sendError(res, 400, "UNKNOWN_ACCOUNT", "Conto non valido", { contoId: b.contoId });
    }
    const update = {};
    if (b.nome !== undefined) update.nome = sanitizeText(b.nome, 100);
    if (b.targetAmount !== undefined) {
      update.targetAmount = parseFloat(b.targetAmount);
      update.targetAmountMinorUnits = toMinorUnits(update.targetAmount); // MOD-016
    }
    if (b.targetDate !== undefined) update.targetDate = b.targetDate;
    if (b.currentAmount !== undefined) {
      update.currentAmount = parseFloat(b.currentAmount);
      update.currentAmountMinorUnits = toMinorUnits(update.currentAmount); // MOD-016
    }
    if (b.contributionType !== undefined) update.contributionType = b.contributionType;
    if (b.contributionValue !== undefined) update.contributionValue = parseFloat(b.contributionValue);
    if (b.autoAdd !== undefined) update.autoAdd = b.autoAdd === true;
    if (b.contoId !== undefined) update.contoId = b.contoId || null;
    if (Object.keys(update).length === 0) return sendError(res, 400, "NO_FIELDS_TO_UPDATE", "Nessun campo da aggiornare");
    update.updatedAt = new Date();
    await db.collection("goals").updateOne({ _id: new ObjectId(req.params.id), householdId: req.householdId }, { $set: update });
    res.json({ ok: true });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

app.delete("/api/goals/:id", requireHousehold, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return sendError(res, 400, "INVALID_ID", "ID non valido");
    const r = await db.collection("goals").deleteOne({ _id: new ObjectId(req.params.id), householdId: req.householdId });
    if (r.deletedCount === 0) return sendError(res, 404, "NOT_FOUND", "Non trovato");
    res.json({ deleted: true });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

// ─── Accounts (conti) API ───
app.get("/api/accounts", requireHousehold, async (req, res) => {
  try {
    const docs = await db.collection("accounts").find({ householdId: req.householdId }).sort({ createdAt: 1 }).toArray();
    res.json(docs.map(d => { const id = d._id.toString(); delete d._id; delete d.householdId; return { id, ...d }; }));
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

app.post("/api/accounts", writeLimiter, requireHousehold, async (req, res) => {
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
      saldoInizialeMinorUnits: toMinorUnits(Number.isFinite(saldoIniziale) ? saldoIniziale : 0), // MOD-016
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

app.put("/api/accounts/:id", writeLimiter, requireHousehold, async (req, res) => {
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
      update.saldoInizialeMinorUnits = toMinorUnits(v); // MOD-016
    }
    if (Object.keys(update).length === 0) return sendError(res, 400, "NO_FIELDS_TO_UPDATE", "Nessun campo da aggiornare");
    update.updatedAt = new Date();
    await db.collection("accounts").updateOne({ _id: new ObjectId(req.params.id), householdId: req.householdId }, { $set: update });
    res.json({ ok: true });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

app.delete("/api/accounts/:id", writeLimiter, requireHousehold, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return sendError(res, 400, "INVALID_ID", "ID non valido");
    const r = await db.collection("accounts").deleteOne({ _id: new ObjectId(req.params.id), householdId: req.householdId });
    if (r.deletedCount === 0) return sendError(res, 404, "NOT_FOUND", "Non trovato");
    // Detach the deleted account from its transactions and goals (they stay, unassigned)
    await transactionsCol.updateMany({ householdId: req.householdId, contoId: req.params.id }, { $set: { contoId: null } });
    await transactionsCol.updateMany({ householdId: req.householdId, contoDa: req.params.id }, { $set: { contoDa: null } });
    await transactionsCol.updateMany({ householdId: req.householdId, contoA: req.params.id }, { $set: { contoA: null } });
    await db.collection("goals").updateMany({ householdId: req.householdId, contoId: req.params.id }, { $set: { contoId: null } });
    res.json({ deleted: true });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

// ─── Full backup & restore ───
app.get("/api/backup", requireHousehold, async (req, res) => {
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

app.post("/api/backup/restore", writeLimiter, requireHousehold, async (req, res) => {
  try {
    const b = req.body;
    if (!b || b.formato !== "balance-tracker-backup") return sendError(res, 400, "INVALID_BACKUP_FORMAT", "File non riconosciuto come backup");
    const hid = req.householdId;
    const asArray = (x) => Array.isArray(x) ? x : [];
    const clean = (d) => { const o = { ...d }; delete o.id; delete o._id; o.householdId = hid; return o; };
    const counts = { transactions: 0, accounts: 0, goals: 0, trips: 0, positions: 0, manualPrices: 0 };

    // 1. Accounts first, building an old→new id map for references
    const contoIdMap = {};
    for (const a of asArray(b.accounts)) {
      const doc = clean(a);
      doc.nome = sanitizeText(String(doc.nome || "Conto"), 60);
      doc.icona = sanitizeText(String(doc.icona || "🏦"), 8);
      doc.saldoIniziale = Number.isFinite(parseFloat(doc.saldoIniziale)) ? parseFloat(doc.saldoIniziale) : 0;
      doc.saldoInizialeMinorUnits = toMinorUnits(doc.saldoIniziale); // MOD-016
      doc.restoredAt = new Date();
      const r = await db.collection("accounts").insertOne(doc);
      if (a.id) contoIdMap[a.id] = r.insertedId.toString();
      counts.accounts++;
    }
    const remap = (oldId) => (oldId && contoIdMap[oldId]) || null;

    // 2. Goals (remapping the linked account)
    for (const g of asArray(b.goals)) {
      const doc = clean(g);
      doc.contoId = remap(doc.contoId);
      if (Number.isFinite(parseFloat(doc.targetAmount))) doc.targetAmountMinorUnits = toMinorUnits(parseFloat(doc.targetAmount)); // MOD-016
      if (Number.isFinite(parseFloat(doc.currentAmount))) doc.currentAmountMinorUnits = toMinorUnits(parseFloat(doc.currentAmount)); // MOD-016
      doc.restoredAt = new Date();
      await db.collection("goals").insertOne(doc);
      counts.goals++;
    }

    // 3. Trips (expenses are embedded, restored as-is — except the MOD-016
    // companion field, recomputed per expense rather than trusted from a
    // possibly stale/absent backup, same reasoning as transactions below)
    for (const t of asArray(b.trips)) {
      const doc = clean(t);
      if (Array.isArray(doc.expenses)) {
        doc.expenses = doc.expenses.map(e =>
          typeof e.importo === "number" ? { ...e, importoMinorUnits: toMinorUnits(e.importo) } : e
        );
      }
      doc.restoredAt = new Date();
      await tripsCol.insertOne(doc);
      counts.trips++;
    }

    // 4. Positions
    for (const p of asArray(b.positions)) {
      const doc = clean(p);
      if (Number.isFinite(parseFloat(doc.prezzoAcquisto))) doc.prezzoAcquistoMinorUnits = toMinorUnits(parseFloat(doc.prezzoAcquisto)); // MOD-016
      doc.restoredAt = new Date();
      await db.collection("positions").insertOne(doc);
      counts.positions++;
    }

    // 5. Manual prices (upsert, non-destructive)
    if (b.manualPrices && typeof b.manualPrices === "object" && !Array.isArray(b.manualPrices)) {
      const TICKER_RE = /^[A-Z0-9.^=\-]{1,20}$/;
      for (const [rawTicker, rawPrice] of Object.entries(b.manualPrices).slice(0, 200)) {
        const ticker = String(rawTicker).toUpperCase().trim();
        const price = typeof rawPrice === "number" ? rawPrice : parseFloat(rawPrice);
        if (!TICKER_RE.test(ticker) || !Number.isFinite(price) || price < 0) continue;
        await quotesCol.updateOne({ ticker, householdId: hid }, { $set: { ticker, householdId: hid, manualPrice: price, updatedAt: new Date() } }, { upsert: true });
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
      doc.importoMinorUnits = toMinorUnits(doc.importo); // MOD-016 — recomputed, not trusted from a possibly stale/absent backup field
      doc.descrizione = sanitizeText(doc.descrizione);
      doc.contoId = remap(doc.contoId);
      doc.contoDa = remap(doc.contoDa);
      doc.contoA = remap(doc.contoA);
      doc.restoredAt = new Date();
      await transactionsCol.insertOne(doc);
      counts.transactions++;
    }

    // 7. Custom categories: restore only if the household has none
    if (b.household?.categorieUscita && !req.household.categorieUscita) {
      await householdsCol.updateOne({ householdId: hid }, { $set: { categorieUscita: b.household.categorieUscita, updatedAt: new Date() } });
    }

    await auditCol.insertOne({ householdId: hid, action: "backup_restore", counts, at: new Date() });
    res.json({ ok: true, counts });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore durante il ripristino"); }
});

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
app.post("/api/widget-key", writeLimiter, requireHousehold, async (req, res) => {
  try {
    const key = randomBytes(24).toString("base64url");
    // MOD-011: store only the hash — the plaintext key exists only in this
    // response, shown to the person once, never persisted server-side.
    await householdsCol.updateOne({ householdId: req.householdId }, { $set: { widgetKeyHash: hashCapabilityToken(key), widgetKeyCreatedAt: new Date() }, $unset: { widgetKey: "" } });
    await auditCol.insertOne({ householdId: req.householdId, action: "widget_key_created", at: new Date() });
    res.json({ key });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

app.delete("/api/widget-key", writeLimiter, requireHousehold, async (req, res) => {
  try {
    await householdsCol.updateOne({ householdId: req.householdId }, { $unset: { widgetKey: "", widgetKeyHash: "", widgetKeyCreatedAt: "" } });
    await auditCol.insertOne({ householdId: req.householdId, action: "widget_key_revoked", at: new Date() });
    res.json({ ok: true });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

const widgetLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, message: { error: { code: "RATE_LIMITED", message: "Troppe richieste, riprova tra un minuto" } } });
app.get("/api/widget", widgetLimiter, async (req, res) => {
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

    // Portfolio a costo medio, prezzo manuale o costo di carico
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
      totInvestimenti += (prices[k] > 0) ? h.q * prices[k] : h.c;
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
app.post("/api/widget/transaction", widgetWriteLimiter, async (req, res) => {
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
      importoMinorUnits: toMinorUnits(importo), // MOD-016
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

// ─── Calendar sync: read-only .ics feed of recurring transactions ───
// Same capability-URL pattern as the widget key. Google Calendar, Apple
// Calendar and Outlook all support "subscribe by URL" natively, so one
// endpoint covers every calendar app without any OAuth/provider integration.
app.post("/api/calendar-key", writeLimiter, requireHousehold, async (req, res) => {
  try {
    const key = randomBytes(24).toString("base64url");
    await householdsCol.updateOne({ householdId: req.householdId }, { $set: { calendarKeyHash: hashCapabilityToken(key), calendarKeyCreatedAt: new Date() }, $unset: { calendarKey: "" } });
    await auditCol.insertOne({ householdId: req.householdId, action: "calendar_key_created", at: new Date() });
    res.json({ key });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

app.delete("/api/calendar-key", writeLimiter, requireHousehold, async (req, res) => {
  try {
    await householdsCol.updateOne({ householdId: req.householdId }, { $unset: { calendarKey: "", calendarKeyHash: "", calendarKeyCreatedAt: "" } });
    await auditCol.insertOne({ householdId: req.householdId, action: "calendar_key_revoked", at: new Date() });
    res.json({ ok: true });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

function icsEscape(s) {
  return String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}
const RRULE_BY_FREQUENZA = {
  settimanale: "FREQ=WEEKLY",
  mensile: "FREQ=MONTHLY",
  trimestrale: "FREQ=MONTHLY;INTERVAL=3",
  annuale: "FREQ=YEARLY",
};
const calendarLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, message: { error: { code: "RATE_LIMITED", message: "Troppe richieste, riprova tra un minuto" } } });
app.get("/api/calendar.ics", calendarLimiter, async (req, res) => {
  try {
    const key = req.query.key;
    if (!key || typeof key !== "string" || key.length < 20) return sendError(res, 401, "MISSING_KEY", "Chiave mancante");
    const household = await findByCapabilityToken(householdsCol, "calendarKey", key);
    if (!household) return sendError(res, 401, "INVALID_KEY", "Chiave non valida");
    const hid = household.householdId;

    const templates = await transactionsCol.find({
      householdId: hid, deletedAt: null, "ricorrenza.frequenza": { $exists: true },
    }).toArray();

    const catById = {};
    for (const c of (household.categorieUscita || [])) catById[c.id] = c.nome;

    const now = new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Finanza Tracker//Recurring Transactions//IT",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      `X-WR-CALNAME:${icsEscape(household.nome)} — Spese ricorrenti`,
      "X-PUBLISHED-TTL:PT12H",
      "REFRESH-INTERVAL;VALUE=DURATION:PT12H",
    ];
    for (const t of templates) {
      const rrule = RRULE_BY_FREQUENZA[t.ricorrenza.frequenza];
      if (!rrule || !/^\d{4}-\d{2}-\d{2}$/.test(t.ricorrenza.prossimaData)) continue;
      const dtstart = t.ricorrenza.prossimaData.replace(/-/g, "");
      const catNome = catById[t.categoria] || t.categoria || "";
      const summary = `${t.tipo === "entrata" ? "💰" : "💸"} ${t.descrizione || catNome} — €${Number(t.importo).toFixed(2)}`;
      lines.push(
        "BEGIN:VEVENT",
        `UID:${t._id.toString()}@finanza-tracker`,
        `DTSTAMP:${now}`,
        `DTSTART;VALUE=DATE:${dtstart}`,
        `RRULE:${rrule}`,
        `SUMMARY:${icsEscape(summary)}`,
        `DESCRIPTION:${icsEscape(t.ricorrenza.variabile ? "Importo variabile — verificare ad ogni rinnovo" : "")}`,
        "END:VEVENT",
      );
    }
    lines.push("END:VCALENDAR");

    res.set("Content-Type", "text/calendar; charset=utf-8");
    res.set("Content-Disposition", 'inline; filename="finanza-ricorrenti.ics"');
    res.send(lines.join("\r\n"));
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

// ─── Trips API ───
app.get("/api/trips", requireHousehold, async (req, res) => {
  try {
    const trips = await tripsCol.find({ householdId: req.householdId }).sort({ startDate: -1 }).toArray();
    for (const t of trips) recordTripEmbeddingStats(t); // MOD-019: cheap — trips are already in hand, no extra query
    res.json(trips.map(t => { const id = t._id.toString(); delete t._id; delete t.householdId; return { id, ...t }; }));
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

app.post("/api/trips", writeLimiter, requireHousehold, async (req, res) => {
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

app.put("/api/trips/:id", writeLimiter, requireHousehold, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return sendError(res, 400, "INVALID_ID", "ID non valido");
    const t = req.body;
    const update = {};
    if (t.nome !== undefined) update.nome = sanitizeText(t.nome, 100);
    if (t.descrizione !== undefined) update.descrizione = sanitizeText(t.descrizione, 500);
    if (t.startDate !== undefined) update.startDate = t.startDate;
    if (t.endDate !== undefined) update.endDate = t.endDate;
    if (t.partecipanti !== undefined) update.partecipanti = sanitizePartecipanti(t.partecipanti);
    if (t.settled !== undefined) update.settled = t.settled === true;
    if (Object.keys(update).length === 0) return sendError(res, 400, "NO_FIELDS_TO_UPDATE", "Nessun campo da aggiornare");
    update.updatedAt = new Date();
    await tripsCol.updateOne({ _id: new ObjectId(req.params.id), householdId: req.householdId }, { $set: update });
    res.json({ ok: true });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

app.delete("/api/trips/:id", writeLimiter, requireHousehold, async (req, res) => {
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

app.post("/api/trips/:id/expenses", writeLimiter, requireHousehold, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return sendError(res, 400, "INVALID_ID", "ID non valido");
    const trip = await tripsCol.findOne({ _id: new ObjectId(req.params.id), householdId: req.householdId });
    if (!trip) return sendError(res, 404, "NOT_FOUND", "Viaggio non trovato");
    if (trip.settled) return sendError(res, 400, "TRIP_SETTLED", "Viaggio già chiuso");

    let expense;
    try {
      expense = buildTripExpense(req.body, trip);
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

app.delete("/api/trips/:id/expenses/:expenseId", writeLimiter, requireHousehold, async (req, res) => {
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
app.post("/api/trips/:id/share", writeLimiter, requireHousehold, async (req, res) => {
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

app.delete("/api/trips/:id/share", writeLimiter, requireHousehold, async (req, res) => {
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

function stripTripForGuest(trip) {
  const id = trip._id.toString();
  return {
    id, nome: trip.nome, descrizione: trip.descrizione,
    startDate: trip.startDate, endDate: trip.endDate,
    partecipanti: trip.partecipanti, expenses: trip.expenses, settled: trip.settled,
  };
}

app.get("/api/trips/shared/:token", tripShareLimiter, async (req, res) => {
  try {
    const token = req.params.token;
    if (!token || token.length < 20) return sendError(res, 401, "INVALID_TOKEN", "Link non valido");
    const trip = await findTripByShareToken(token);
    if (!trip) return sendError(res, 404, "NOT_FOUND", "Link non valido, scaduto o revocato");
    res.json(stripTripForGuest(trip));
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

app.post("/api/trips/shared/:token/join", tripShareWriteLimiter, async (req, res) => {
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

    const esistente = (trip.partecipanti || []).find(p => p.id === id);
    if (esistente) return res.json(esistente); // stesso nome già presente: rientra come lo stesso ospite

    const colors = ["#E17055", "#74B9FF", "#55EFC4", "#FDCB6E", "#A29BFE", "#FF7675", "#00CEC9"];
    const nuovo = { id, nome, emoji: "👤", colore: colors[(trip.partecipanti || []).length % colors.length] };
    await tripsCol.updateOne({ _id: trip._id }, { $push: { partecipanti: nuovo }, $set: { updatedAt: new Date() } });
    res.status(201).json(nuovo);
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

app.post("/api/trips/shared/:token/expenses", tripShareWriteLimiter, async (req, res) => {
  try {
    const token = req.params.token;
    if (!token || token.length < 20) return sendError(res, 401, "INVALID_TOKEN", "Link non valido");
    const trip = await findTripByShareToken(token);
    if (!trip) return sendError(res, 404, "NOT_FOUND", "Link non valido, scaduto o revocato");
    if (trip.settled) return sendError(res, 400, "TRIP_SETTLED", "Viaggio già chiuso");

    let expense;
    try {
      expense = buildTripExpense(req.body, trip);
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

async function start() {
  try {
    await connectDB();
    app.listen(PORT, () => logger.info("server_listening", { port: PORT }));
    verifyEmailSetup().catch(() => {}); // diagnostico, non deve mai bloccare l'avvio
    import("./keep-alive.js").catch(() => {});
    generaRicorrentiDovute();
    setInterval(generaRicorrentiDovute, RICORRENTI_CHECK_MS);
    svuotaCestinoScaduto();
    setInterval(svuotaCestinoScaduto, RICORRENTI_CHECK_MS);
    chiudiViaggiScaduti();
    setInterval(chiudiViaggiScaduti, RICORRENTI_CHECK_MS);
  } catch (e) { logger.error("startup_failed", { error: e.message }); process.exit(1); }
}

// MOD-014: only bind a port / connect to the real database / start the
// background-job intervals when this file is run directly (`node index.js`
// or `node --watch index.js`, i.e. production and local dev) — not when
// it's imported by a test file. Tests import `app` and call `connectDB(uri)`
// themselves against a disposable mongodb-memory-server instance instead.
//
// Comparing realpath'd paths (not raw `import.meta.url` vs `process.argv[1]`
// strings) matters here: on systems where the invocation path runs through
// a symlink (e.g. macOS's /tmp -> /private/tmp), Node resolves
// import.meta.url through the symlink but leaves process.argv[1] as typed,
// so a naive string comparison silently mismatches and start() never runs.
let isMainModule = false;
try {
  isMainModule = !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
} catch { /* argv[1] not a real file (e.g. some REPL/loader contexts) — not the main module */ }
if (isMainModule) {
  start();
}

export { app, connectDB };
