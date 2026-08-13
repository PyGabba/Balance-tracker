import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { MongoClient, ObjectId } from "mongodb";
import { createHmac, randomUUID, randomBytes } from "crypto";
import dotenv from "dotenv";
// Yahoo Finance disabled — manual prices only
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
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

function signToken(householdId) {
  const jti = randomUUID();
  const token = jwt.sign({ householdId, jti }, JWT_SECRET, { expiresIn: "90d" });
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
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
  optionsSuccessStatus: 200,
};
app.use(cors(CORS_OPTIONS));
app.options("*", cors(CORS_OPTIONS));
app.use(cookieParser());
app.use(express.json({ limit: "10mb" }));

const IS_PROD = process.env.NODE_ENV === "production";
const COOKIE_OPTS = {
  httpOnly: true,
  secure: IS_PROD,      // localhost dev doesn't use HTTPS
  sameSite: "strict",   // safe: prod requests come via Vercel proxy (same-origin); local is same-site
  maxAge: TOKEN_TTL_SECONDS * 1000,
  path: "/",
};

let db, transactionsCol, householdsCol, quotesCol, blacklistCol, auditCol, tripsCol;
async function connectDB() {
  const client = new MongoClient(MONGO_URI); await client.connect();
  db = client.db(DB_NAME);
  transactionsCol = db.collection("transactions");
  householdsCol = db.collection("households");
  locksCol = db.collection("login_locks");
  quotesCol = db.collection("quotes_cache");
  blacklistCol = db.collection("blacklist");
  activeTokensCol = db.collection("active_tokens");
  auditCol = db.collection("audit_log");
  tripsCol = db.collection("trips");
  await transactionsCol.createIndex({ householdId: 1, data: -1 });
  await transactionsCol.createIndex({ deletedAt: 1 }, { sparse: true });
  await tripsCol.createIndex({ householdId: 1, startDate: -1 });
  await tripsCol.createIndex({ householdId: 1 });
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
  console.log("Connected: " + DB_NAME); return client;
}

// ─── Input sanitization ───
function sanitizeText(s, maxLen = 500) {
  if (s == null) return "";
  return String(s).trim().slice(0, maxLen);
}

// #7: whitelist splits/extraPersone sub-object keys to prevent stored XSS via arbitrary fields
function sanitizeSplits(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  if (arr.length > 20) return null; // more splits than people = suspicious
  return arr.map(s => {
    if (!s || typeof s !== "object") return null;
    const quota = typeof s.quota === "number" ? s.quota : parseFloat(s.quota);
    if (!Number.isFinite(quota) || quota < 0 || quota > 100) return null;
    return { personaId: sanitizeText(s.personaId, 50), quota };
  }).filter(Boolean);
}

function sanitizeExtraPersone(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  if (arr.length > 20) return null;
  return arr.map(p => {
    if (!p || typeof p !== "object") return null;
    return { id: sanitizeText(p.id, 50), nome: sanitizeText(p.nome, 100) };
  }).filter(Boolean);
}

const RICORRENZA_FREQUENZE = ["settimanale", "mensile", "trimestrale", "annuale"];
function sanitizeRicorrenza(r) {
  if (!r || typeof r !== "object") return null;
  if (!RICORRENZA_FREQUENZE.includes(r.frequenza)) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.prossimaData))) return null;
  return { frequenza: r.frequenza, prossimaData: r.prossimaData, variabile: !!r.variabile };
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
  if (ricorrentiRunning || !transactionsCol) return;
  ricorrentiRunning = true;
  try {
    const oggi = new Date().toISOString().slice(0, 10);
    const dovute = await transactionsCol.find({ "ricorrenza.prossimaData": { $lte: oggi }, deletedAt: null }).toArray();
    for (const t of dovute) {
      const child = { ...t, data: t.ricorrenza.prossimaData, createdAt: new Date() };
      delete child._id;
      delete child.ricorrenza;
      delete child.updatedAt;
      if (t.ricorrenza.variabile) child.daVerificare = true;
      await transactionsCol.insertOne(child);
      const updatedRicorrenza = {
        frequenza: t.ricorrenza.frequenza,
        prossimaData: nextRicorrenzaData(t.ricorrenza.prossimaData, t.ricorrenza.frequenza),
        variabile: t.ricorrenza.variabile,
      };
      await transactionsCol.updateOne({ _id: t._id }, { $set: { ricorrenza: updatedRicorrenza } });
    }
    if (dovute.length > 0) console.log(`Ricorrenti: generate ${dovute.length} transazioni`);
  } catch (e) {
    console.error("generaRicorrentiDovute error:", e);
  } finally {
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
  try {
    const soglia = new Date(Date.now() - TRASH_RETENTION_MS);
    const r = await transactionsCol.deleteMany({ deletedAt: { $ne: null, $lte: soglia } });
    if (r.deletedCount > 0) console.log(`Cestino: eliminate definitivamente ${r.deletedCount} transazioni`);
  } catch (e) {
    console.error("svuotaCestinoScaduto error:", e);
  } finally {
    trashPurgeRunning = false;
  }
}

// ─── Trip auto-close — settles + closes trips once their endDate has passed ───
function calcolaSettleViaggioServer(trip) {
  const balances = {};
  for (const e of trip.expenses || []) {
    if (e.splits && e.splits.length > 0) {
      const totalQ = e.splits.reduce((s, sc) => s + sc.quota, 0);
      for (const s of e.splits) {
        if (s.personaId !== e.pagatoDa) {
          const owed = e.importo * (s.quota / totalQ);
          balances[s.personaId] = (balances[s.personaId] || 0) - owed;
          balances[e.pagatoDa] = (balances[e.pagatoDa] || 0) + owed;
        }
      }
    }
  }
  const creditors = [], debtors = [];
  for (const [id, bal] of Object.entries(balances)) {
    if (bal > 0.01) creditors.push({ id, bal });
    if (bal < -0.01) debtors.push({ id, bal: -bal });
  }
  creditors.sort((a, b) => b.bal - a.bal);
  debtors.sort((a, b) => b.bal - a.bal);
  const settlements = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const pay = Math.min(debtors[i].bal, creditors[j].bal);
    if (pay > 0.01) settlements.push({ da: debtors[i].id, a: creditors[j].id, importo: Math.round(pay * 100) / 100 });
    debtors[i].bal -= pay;
    creditors[j].bal -= pay;
    if (debtors[i].bal < 0.01) i++;
    if (creditors[j].bal < 0.01) j++;
  }
  return settlements;
}

let tripAutoCloseRunning = false;
export async function chiudiViaggiScaduti() {
  if (tripAutoCloseRunning || !tripsCol) return;
  tripAutoCloseRunning = true;
  try {
    const oggi = new Date().toISOString().slice(0, 10);
    const scaduti = await tripsCol.find({ settled: false, endDate: { $ne: null, $lt: oggi } }).toArray();
    for (const trip of scaduti) {
      const nameOf = (id) => (trip.partecipanti || []).find(p => p.id === id)?.nome || id;
      const settlements = calcolaSettleViaggioServer(trip);
      for (const s of settlements) {
        await transactionsCol.insertOne({
          householdId: trip.householdId,
          tipo: "saldo",
          importo: s.importo,
          categoria: "saldo_viaggio",
          descrizione: `Saldo viaggio: ${trip.nome} (${nameOf(s.da)} → ${nameOf(s.a)})`,
          data: oggi,
          pagatoDa: s.da,
          ricevutoDa: s.a,
          createdAt: new Date(),
        });
      }
      await tripsCol.updateOne({ _id: trip._id }, { $set: { settled: true, autoSettled: true, updatedAt: new Date() } });
    }
    if (scaduti.length > 0) console.log(`Viaggi: chiusi automaticamente ${scaduti.length} viaggi scaduti`);
  } catch (e) {
    console.error("chiudiViaggiScaduti error:", e);
  } finally {
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
  message: { error: "Troppi tentativi di accesso, riprova tra 15 minuti" },
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true, legacyHeaders: false,
  message: { error: "Troppi account creati, riprova tra un'ora" },
});

const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5, // #8: 5 attempts per 15 min — wrong secret = locked out fast
  standardHeaders: true, legacyHeaders: false,
  message: { error: "Troppi tentativi admin" },
});

const quotesLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5, // #4: 5 quote fetches/min — prevents Yahoo Finance hammering
  standardHeaders: true, legacyHeaders: false,
  message: { error: "Troppe richieste quotazioni, riprova tra un minuto" },
});

const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120, // #5: 120 writes/min per IP — stops storage flood while allowing normal use
  standardHeaders: true, legacyHeaders: false,
  message: { error: "Troppe operazioni, riprova tra un minuto" },
});

const exportLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true, legacyHeaders: false,
  message: { error: "Troppe richieste, riprova tra un minuto" },
});

// ─── Admin middleware ───
function requireAdmin(req, res, next) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return res.status(503).json({ error: "Admin non configurato (ADMIN_SECRET mancante)" });
  if (req.headers["x-admin-secret"] !== secret) return res.status(401).json({ error: "Non autorizzato" });
  next();
}

// ─── Admin blacklist routes ───
app.get("/api/admin/blacklist", adminLimiter, requireAdmin, async (req, res) => {
  try {
    const docs = await blacklistCol.find({}).sort({ addedAt: -1 }).toArray();
    res.json(docs.map(d => ({ key: d.key, reason: d.reason || "", addedAt: d.addedAt })));
  } catch (e) { res.status(500).json({ error: "Errore" }); }
});

app.post("/api/admin/blacklist", adminLimiter, requireAdmin, async (req, res) => {
  try {
    const { key, reason } = req.body || {};
    if (!key || typeof key !== "string") return res.status(400).json({ error: "key obbligatorio (es. ip:1.2.3.4 o device:uuid)" });
    await blacklistCol.updateOne(
      { key },
      { $set: { key, reason: reason || "", addedAt: new Date() } },
      { upsert: true }
    );
    res.status(201).json({ ok: true, key });
  } catch (e) { res.status(500).json({ error: "Errore" }); }
});

app.delete("/api/admin/blacklist/:key(*)", adminLimiter, requireAdmin, async (req, res) => {
  try {
    const key = decodeURIComponent(req.params.key);
    const r = await blacklistCol.deleteOne({ key });
    if (r.deletedCount === 0) return res.status(404).json({ error: "Non trovato" });
    res.json({ ok: true, key });
  } catch (e) { res.status(500).json({ error: "Errore" }); }
});

async function findHousehold(hid) {
  const dbH = await householdsCol.findOne({ householdId: hid });
  if (dbH) return {
    id: dbH.householdId, nome: dbH.nome, persone: dbH.persone,
    categorieUscita: dbH.categorieUscita || null,
    tripCategories: dbH.tripCategories || null,
    requiresPinChange: dbH.requiresPinChange || false,
    email: dbH.email || null,
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

async function requireHousehold(req, res, next) {
  const rawToken = req.cookies?.token;
  if (!rawToken) return res.status(401).json({ error: "Household non valido" });
  let payload;
  try { payload = jwt.verify(rawToken, JWT_SECRET, { algorithms: ["HS256"] }); }
  catch { return res.status(401).json({ error: "Token non valido" }); }
  const { householdId: hid, jti } = payload;
  if (!jti) return res.status(401).json({ error: "Token non valido" });
  try {
    const [household, active] = await Promise.all([
      findHousehold(hid),
      activeTokensCol.findOne({ jti }),
    ]);
    if (!household || !active) return res.status(401).json({ error: "Sessione scaduta, accedi nuovamente" });
    // #2: enforce PIN change server-side — token is valid but access is locked until PIN updated
    if (household.requiresPinChange && !PIN_CHANGE_EXEMPT.includes(req.path)) {
      return res.status(403).json({ error: "PIN_CHANGE_REQUIRED" });
    }
    req.household = household; req.householdId = hid; req.jti = jti; next();
  } catch (e) { res.status(500).json({ error: "Errore autenticazione" }); }
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
      return res.status(403).json({ error: "Accesso permanentemente bloccato" });
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
      return res.status(429).json({ error: `Accesso bloccato. Riprova tra ${mins} minuti.` });
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
      return res.status(401).json({ error: "PIN non valido" });
    }

    await Promise.all([clearLock(ipKey), devKey ? clearLock(devKey) : null, pinKey ? clearLock(pinKey) : null]);
    const { token, jti } = signToken(household.householdId);
    await storeToken(jti, household.householdId);
    audit("login_success", { householdId: household.householdId, ip, deviceId });
    res.cookie("token", token, COOKIE_OPTS);
    res.json({ ...household });
  } catch (e) { res.status(500).json({ error: "Errore login" }); }
});

app.post("/api/auth/logout", requireHousehold, async (req, res) => {
  try {
    await revokeToken(req.jti);
    audit("logout", { householdId: req.householdId, ip: clientIp(req) });
    res.clearCookie("token", { path: "/", httpOnly: true, secure: IS_PROD, sameSite: "strict" });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: "Errore logout" }); }
});

app.post("/api/auth/register", registerLimiter, async (req, res) => {
  try {
    const { nome, persone, pin, email } = req.body || {};
    if (!nome || !pin || !Array.isArray(persone) || persone.length === 0)
      return res.status(400).json({ error: "Campi obbligatori: nome, persone, pin" });
    if (!/^\d{6,8}$/.test(pin))
      return res.status(400).json({ error: "Il PIN deve essere di 6-8 cifre" });
    let emailNorm = null;
    if (email) {
      emailNorm = String(email).trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm) || emailNorm.length > 200)
        return res.status(400).json({ error: "Email non valida" });
    }

    // Build householdId: slug from nome + random suffix
    const slug = nome.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const suffix = Math.random().toString(36).slice(2, 7);
    const householdId = `${slug}-${suffix}`;

    const DEFAULT_EMOJIS = ["👤", "👩", "👨", "🧑", "👧", "👦"];
    const COLORS = ["#6C5CE7", "#E84393", "#0984E3", "#00B894", "#FD79A8", "#FDCB6E"];
    const personeFormatted = persone.map((p, i) => ({
      id: (typeof p === "string" ? p : p.nome).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, ""),
      nome: typeof p === "string" ? p : p.nome,
      emoji: (typeof p === "object" && p.emoji) ? p.emoji : DEFAULT_EMOJIS[i % DEFAULT_EMOJIS.length],
      colore: COLORS[i % COLORS.length],
    }));

    const pinHash = await hashPin(pin);
    const doc = { householdId, nome, persone: personeFormatted, pinHash, pinLookup: pinLookupKey(pin), email: emailNorm, createdAt: new Date() };
    await householdsCol.insertOne(doc);
    const { token, jti } = signToken(householdId);
    await storeToken(jti, householdId);
    audit("register", { householdId, ip: clientIp(req) });
    res.cookie("token", token, COOKIE_OPTS);
    res.status(201).json({ householdId, nome, persone: personeFormatted });
  } catch (e) {
    if (e.code === 11000 && e.message?.includes("pinLookup")) return res.status(409).json({ error: "PIN già in uso, scegline un altro" });
    if (e.code === 11000 && e.message?.includes("email")) return res.status(409).json({ error: "Email già collegata a un altro gruppo" });
    console.error("Register error:", e.message); // never log e directly — req.body may appear in stack
    res.status(500).json({ error: "Errore durante la registrazione" });
  }
});

// ─── DELETE household ───
// ─── Change PIN ───
app.put("/api/auth/pin", requireHousehold, async (req, res) => {
  try {
    const { newPin } = req.body || {};
    if (!newPin || !/^\d{6,8}$/.test(newPin))
      return res.status(400).json({ error: "Il nuovo PIN deve essere di 6-8 cifre" });
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
  } catch (e) { console.error("PIN change error:", e.message); res.status(500).json({ error: "Errore aggiornamento PIN" }); }
});

// ─── Recupero PIN dimenticato ───
const forgotPinLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false });

app.post("/api/auth/forgot-pin/request", forgotPinLimiter, async (req, res) => {
  // Risposta generica sempre uguale, email esista o meno: non si conferma
  // né si smentisce l'esistenza di un account legato a quell'indirizzo.
  const GENERIC_OK = { ok: true, message: "Se l'email è collegata a un account, riceverai un codice a breve." };
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Email non valida" });

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
      console.error(`Invio email reset fallito [${mailErr.code || "?"}]: ${mailErr.message}${mailErr.response ? " — " + mailErr.response : ""}`);
      // Non sveliamo all'esterno se l'invio è fallito per non far trapelare l'esistenza dell'account
    });
    audit("pin_reset_requested", { householdId: household.householdId, ip: clientIp(req) });
    res.json(GENERIC_OK);
  } catch (e) { console.error("Forgot-pin request error:", e.message); res.status(500).json({ error: "Errore" }); }
});

app.post("/api/auth/forgot-pin/confirm", forgotPinLimiter, async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const code = String(req.body?.code || "").trim();
    const newPin = req.body?.newPin;
    if (!email || !code || !newPin) return res.status(400).json({ error: "Campi obbligatori: email, codice, nuovo PIN" });
    if (!/^\d{6,8}$/.test(newPin)) return res.status(400).json({ error: "Il nuovo PIN deve essere di 6-8 cifre" });

    const household = await householdsCol.findOne({ email });
    if (!household) return res.status(400).json({ error: "Codice non valido o scaduto" });

    const reset = await db.collection("pinResets").findOne({ householdId: household.householdId });
    if (!reset || reset.expiresAt < new Date()) return res.status(400).json({ error: "Codice non valido o scaduto" });
    if (reset.attempts >= 5) {
      await db.collection("pinResets").deleteOne({ _id: reset._id });
      return res.status(429).json({ error: "Troppi tentativi. Richiedi un nuovo codice." });
    }

    const valid = await bcrypt.compare(code, reset.codeHash);
    if (!valid) {
      await db.collection("pinResets").updateOne({ _id: reset._id }, { $inc: { attempts: 1 } });
      return res.status(400).json({ error: "Codice non corretto" });
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
    res.json({ id: household.householdId, nome: household.nome, persone: household.persone });
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ error: "PIN già in uso, scegline un altro" });
    console.error("Forgot-pin confirm error:", e.message); res.status(500).json({ error: "Errore" });
  }
});

// Aggiungere/aggiornare l'email di recupero da account già autenticato
// (fondamentale per le case create prima che questa funzione esistesse).
app.put("/api/auth/recovery-email", writeLimiter, requireHousehold, async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200)
      return res.status(400).json({ error: "Email non valida" });
    await householdsCol.updateOne({ householdId: req.householdId }, { $set: { email, updatedAt: new Date() } });
    audit("recovery_email_set", { householdId: req.householdId, ip: clientIp(req) });
    res.json({ ok: true });
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ error: "Email già collegata a un altro gruppo" });
    console.error("Set recovery email error:", e.message); res.status(500).json({ error: "Errore" });
  }
});

app.delete("/api/auth/household", requireHousehold, async (req, res) => {
  try {
    const { pin } = req.body || {};
    if (!pin) return res.status(400).json({ error: "PIN obbligatorio per confermare" });

    // Verify PIN matches
    const household = await householdsCol.findOne({ householdId: req.householdId });
    if (!household) return res.status(404).json({ error: "Account non trovato" });
    const pinValid = household.pinHash
      ? await bcrypt.compare(pin, household.pinHash)
      : household.pin === pin;
    if (!pinValid) return res.status(401).json({ error: "PIN non corretto" });

    // Delete all data for this household
    await transactionsCol.deleteMany({ householdId: req.householdId });
    await db.collection("positions").deleteMany({ householdId: req.householdId });
    await revokeAllTokens(req.householdId);
    await householdsCol.deleteOne({ householdId: req.householdId });
    audit("household_delete", { householdId: req.householdId, ip: clientIp(req) });
    res.clearCookie("token", { path: "/", httpOnly: true, secure: IS_PROD, sameSite: "strict" });
    res.json({ ok: true });
  } catch (e) { console.error("Delete household error:", e.message); res.status(500).json({ error: "Errore durante l'eliminazione" }); }
});

// ─── GET household info ───
app.get("/api/household", requireHousehold, (req, res) => {
  res.json({ id: req.household.id, nome: req.household.nome, persone: req.household.persone, hasRecoveryEmail: !!req.household.email });
});

// ─── GET transactions ───
app.get("/api/transactions", exportLimiter, requireHousehold, async (req, res) => {
  try {
    const { tipo, categoria, pagatoDa, meseAnno, limit } = req.query;
    const filter = { householdId: req.householdId, deletedAt: null };
    if (tipo) filter.tipo = tipo;
    if (categoria) filter.categoria = categoria;
    if (pagatoDa) filter.pagatoDa = pagatoDa;
    if (meseAnno) {
      const [a, m] = meseAnno.split("-").map(Number);
      filter.data = { $gte: new Date(a, m - 1, 1).toISOString().slice(0, 10), $lte: new Date(a, m, 0).toISOString().slice(0, 10) };
    }
    const docs = await transactionsCol.find(filter).sort({ data: -1, _id: -1 }).limit(parseInt(limit) || 500).toArray();
    res.json(docs.map(d => { const id = d._id.toString(); delete d._id; delete d.householdId; return { id, ...d }; }));
  } catch (e) { console.error(e); res.status(500).json({ error: "Errore" }); }
});

// ─── POST transaction ───
app.post("/api/transactions", writeLimiter, requireHousehold, async (req, res) => {
  try {
    const b = req.body;
    if (!b.tipo || !b.importo || !b.data) return res.status(400).json({ error: "Campi obbligatori" });
    if (!["uscita", "entrata", "saldo", "trasferimento"].includes(b.tipo)) return res.status(400).json({ error: "Tipo non valido" });
    if (!Number.isFinite(parseFloat(b.importo))) return res.status(400).json({ error: "Importo non valido" });
    if (b.tipo === "trasferimento") {
      if (!b.contoDa || !b.contoA) return res.status(400).json({ error: "Trasferimento: contoDa e contoA obbligatori" });
      if (b.contoDa === b.contoA) return res.status(400).json({ error: "Trasferimento: i due conti devono essere diversi" });
    }
    const doc = {
      householdId: req.householdId,
      tipo: b.tipo,
      importo: parseFloat(b.importo),
      categoria: b.categoria || "altro",
      descrizione: sanitizeText(b.descrizione),
      data: b.data,
      pagatoDa: b.pagatoDa || null,
      ricevutoDa: b.ricevutoDa || null,
      splits: sanitizeSplits(b.splits),
      extraPersone: sanitizeExtraPersone(b.extraPersone),
      splitPagante: b.splitPagante != null ? parseInt(b.splitPagante) : null,
      intestataA: b.intestataA || null,
      contoId: b.contoId || null,
      contoDa: b.contoDa || null,
      contoA: b.contoA || null,
      ricorrenza: sanitizeRicorrenza(b.ricorrenza),
      daVerificare: !!b.daVerificare,
      createdAt: new Date(),
    };
    const result = await transactionsCol.insertOne(doc);
    const id = result.insertedId.toString();
    delete doc.householdId;
    res.status(201).json({ id, ...doc });
  } catch (e) { console.error(e); res.status(500).json({ error: "Errore" }); }
});

// ─── DELETE transaction (soft delete — moves to trash, purged after 30 days) ───
app.delete("/api/transactions/:id", writeLimiter, requireHousehold, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "ID non valido" });
    const r = await transactionsCol.findOneAndUpdate(
      { _id: new ObjectId(req.params.id), householdId: req.householdId, deletedAt: null },
      { $set: { deletedAt: new Date() } }
    );
    if (!r) return res.status(404).json({ error: "Non trovata" });
    res.json({ deleted: true, id: req.params.id });
  } catch (e) { console.error(e); res.status(500).json({ error: "Errore" }); }
});

// ─── Trash (soft-deleted transactions) ───
app.get("/api/transactions/trash", requireHousehold, async (req, res) => {
  try {
    const docs = await transactionsCol.find({ householdId: req.householdId, deletedAt: { $ne: null } })
      .sort({ deletedAt: -1 }).toArray();
    res.json(docs.map(d => { const id = d._id.toString(); delete d._id; delete d.householdId; return { id, ...d }; }));
  } catch (e) { console.error(e); res.status(500).json({ error: "Errore" }); }
});

app.post("/api/transactions/:id/restore", writeLimiter, requireHousehold, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "ID non valido" });
    const result = await transactionsCol.findOneAndUpdate(
      { _id: new ObjectId(req.params.id), householdId: req.householdId, deletedAt: { $ne: null } },
      { $unset: { deletedAt: "" } }, { returnDocument: "after" }
    );
    if (!result) return res.status(404).json({ error: "Non trovata nel cestino" });
    const id = result._id.toString(); delete result._id; delete result.householdId;
    res.json({ id, ...result });
  } catch (e) { console.error(e); res.status(500).json({ error: "Errore" }); }
});

app.delete("/api/transactions/:id/permanent", writeLimiter, requireHousehold, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "ID non valido" });
    const r = await transactionsCol.deleteOne({ _id: new ObjectId(req.params.id), householdId: req.householdId, deletedAt: { $ne: null } });
    if (r.deletedCount === 0) return res.status(404).json({ error: "Non trovata nel cestino" });
    res.json({ deleted: true, id: req.params.id });
  } catch (e) { console.error(e); res.status(500).json({ error: "Errore" }); }
});

app.delete("/api/transactions/trash/empty", writeLimiter, requireHousehold, async (req, res) => {
  try {
    const r = await transactionsCol.deleteMany({ householdId: req.householdId, deletedAt: { $ne: null } });
    res.json({ deleted: r.deletedCount });
  } catch (e) { console.error(e); res.status(500).json({ error: "Errore" }); }
});

// ─── PUT transaction ───
app.put("/api/transactions/:id", writeLimiter, requireHousehold, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "ID non valido" });
    const update = {};
    const allowed = ["tipo","importo","categoria","descrizione","data","pagatoDa","ricevutoDa","splitPagante","intestataA","splits","extraPersone","contoId","contoDa","contoA","ricorrenza","daVerificare"];
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        if (key === "importo") update[key] = parseFloat(req.body[key]);
        else if (key === "splitPagante") update[key] = req.body[key] != null ? parseInt(req.body[key]) : null;
        else if (key === "splits") update[key] = sanitizeSplits(req.body[key]);
        else if (key === "extraPersone") update[key] = sanitizeExtraPersone(req.body[key]);
        else if (key === "descrizione") update[key] = sanitizeText(req.body[key]);
        else if (key === "ricorrenza") update[key] = sanitizeRicorrenza(req.body[key]);
        else if (key === "daVerificare") update[key] = !!req.body[key];
        else update[key] = req.body[key];
      }
    }
    update.updatedAt = new Date();
    const result = await transactionsCol.findOneAndUpdate(
      { _id: new ObjectId(req.params.id), householdId: req.householdId },
      { $set: update }, { returnDocument: "after" }
    );
    if (!result) return res.status(404).json({ error: "Non trovata" });
    const id = result._id.toString(); delete result._id; delete result.householdId;
    res.json({ id, ...result });
  } catch (e) { console.error(e); res.status(500).json({ error: "Errore" }); }
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
    const netPerPerson = {};
    function addAmount(id, delta) { netPerPerson[id] = (netPerPerson[id] || 0) + delta; }

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
      for (const sh of shares) {
        if (sh.personaId === payer) continue;
        const owed = t.importo * (sh.quota / totalQ);
        addAmount(payer, +owed);
        addAmount(sh.personaId, -owed);
      }
    }

    // Settlements reduce balances
    for (const s of saldi) {
      addAmount(s.pagatoDa, +s.importo);
      addAmount(s.ricevutoDa, -s.importo);
    }

    // Greedy creditor/debtor matching
    const creditors = [], debtors = [];
    for (const [id, bal] of Object.entries(netPerPerson)) {
      if (bal >  0.01) creditors.push({ id, bal });
      if (bal < -0.01) debtors.push({ id, bal: -bal });
    }
    creditors.sort((a, b) => b.bal - a.bal);
    debtors.sort((a, b) => b.bal - a.bal);

    const debiti = [];
    let i = 0, j = 0;
    while (i < debtors.length && j < creditors.length) {
      const pay = Math.min(debtors[i].bal, creditors[j].bal);
      debiti.push({ da: debtors[i].id, a: creditors[j].id, importo: +(pay.toFixed(2)) });
      debtors[i].bal   -= pay;
      creditors[j].bal -= pay;
      if (debtors[i].bal   < 0.01) i++;
      if (creditors[j].bal < 0.01) j++;
    }
    res.json({ debiti });
  } catch (e) { console.error(e); res.status(500).json({ error: "Errore" }); }
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
  } catch (e) { console.error(e); res.status(500).json({ error: "Errore" }); }
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
      return res.status(400).json({ error: "categorie deve essere un array non vuoto" });
    if (categorie.length > 100)
      return res.status(400).json({ error: "Massimo 100 categorie" });
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
      return res.status(400).json({ error: "Nessuna categoria valida" });
    await householdsCol.updateOne(
      { householdId: req.householdId },
      { $set: { categorieUscita: sanitized, updatedAt: new Date() } }
    );
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "Errore" }); }
});

// ─── Trip categories (sincronizzate sulla casa, come categorieUscita) ───
app.get("/api/trip-categories", requireHousehold, async (req, res) => {
  res.json({ categorie: req.household.tripCategories || null });
});

app.put("/api/trip-categories", writeLimiter, requireHousehold, async (req, res) => {
  try {
    const { categorie } = req.body || {};
    if (!Array.isArray(categorie) || categorie.length === 0)
      return res.status(400).json({ error: "categorie deve essere un array non vuoto" });
    if (categorie.length > 100)
      return res.status(400).json({ error: "Massimo 100 categorie" });
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
      return res.status(400).json({ error: "Nessuna categoria valida" });
    await householdsCol.updateOne(
      { householdId: req.householdId },
      { $set: { tripCategories: sanitized, updatedAt: new Date() } }
    );
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "Errore" }); }
});

// ─── Stock Positions ───
// Collection: positions { householdId, ticker, nome, quantita, prezzoAcquisto, dataAcquisto, valuta, note, createdAt }

// Portfolio is available to all authenticated households
function requirePortfolioAccess(req, res, next) {
  next();
}

app.get("/api/positions", requireHousehold, requirePortfolioAccess, async (req, res) => {
  try {
    const col = db.collection("positions");
    const docs = await col.find({ householdId: req.householdId }).sort({ dataAcquisto: -1 }).toArray();
    res.json(docs.map(d => { const id = d._id.toString(); delete d._id; delete d.householdId; return { id, ...d }; }));
  } catch (e) { console.error(e); res.status(500).json({ error: "Errore" }); }
});

app.post("/api/positions", writeLimiter, requireHousehold, requirePortfolioAccess, async (req, res) => {
  try {
    const b = req.body;
    if (!b.ticker || !b.quantita || !b.prezzoAcquisto) return res.status(400).json({ error: "Campi obbligatori: ticker, quantita, prezzoAcquisto" });
    const ticker = b.ticker.toUpperCase().trim();
    if (!/^[A-Z0-9.^=\-]{1,20}$/.test(ticker)) return res.status(400).json({ error: "Ticker non valido (max 20 caratteri alfanumerici)" });
    const doc = {
      householdId: req.householdId,
      ticker,
      nome: sanitizeText(b.nome || ticker, 100),
      quantita: parseFloat(b.quantita),
      prezzoAcquisto: parseFloat(b.prezzoAcquisto),
      dataAcquisto: b.dataAcquisto || new Date().toISOString().slice(0, 10),
      valuta: b.valuta || "EUR",
      note: sanitizeText(b.note, 500),
      tipo: b.tipo || "buy", // buy or sell
      createdAt: new Date(),
    };
    const result = await db.collection("positions").insertOne(doc);
    const id = result.insertedId.toString(); delete doc.householdId;
    res.status(201).json({ id, ...doc });
  } catch (e) { console.error(e); res.status(500).json({ error: "Errore" }); }
});

app.delete("/api/positions/:id", requireHousehold, requirePortfolioAccess, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "ID non valido" });
    const r = await db.collection("positions").deleteOne({ _id: new ObjectId(req.params.id), householdId: req.householdId });
    if (r.deletedCount === 0) return res.status(404).json({ error: "Non trovata" });
    res.json({ deleted: true, id: req.params.id });
  } catch (e) { console.error(e); res.status(500).json({ error: "Errore" }); }
});

// ─── Manual price overrides (stored in quotes_cache, scoped by householdId) ───
app.get("/api/positions/prices", requireHousehold, async (req, res) => {
  try {
    const docs = await quotesCol.find({ householdId: req.householdId, manualPrice: { $exists: true } }).toArray();
    const manualPrices = {};
    for (const d of docs) manualPrices[d.ticker] = d.manualPrice;
    res.json({ manualPrices });
  } catch (e) { console.error(e); res.status(500).json({ error: "Errore" }); }
});

app.put("/api/positions/prices", requireHousehold, async (req, res) => {
  try {
    const { manualPrices } = req.body || {};
    if (typeof manualPrices !== "object" || manualPrices === null || Array.isArray(manualPrices))
      return res.status(400).json({ error: "manualPrices deve essere un oggetto" });
    const TICKER_RE = /^[A-Z0-9.^=\-]{1,20}$/;
    const entries = Object.entries(manualPrices);
    if (entries.length > 200)
      return res.status(400).json({ error: "Massimo 200 prezzi manuali" });
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
  } catch (e) { console.error(e); res.status(500).json({ error: "Errore" }); }
});

// Stock quotes endpoint — DISABLED
// Only manual prices via /api/manual-prices are now supported
// To re-enable: uncomment and ensure yahoo-finance2 is installed

app.get("/api/quotes", quotesLimiter, requireHousehold, async (req, res) => {
  res.status(410).json({ error: "API quotazioni rimossa. Usa i prezzi manuali." });
});

// Savings Goals
app.get("/api/goals", requireHousehold, async (req, res) => {
  try {
    const col = db.collection("goals");
    const docs = await col.find({ householdId: req.householdId }).sort({ createdAt: -1 }).toArray();
    res.json(docs.map(d => { const id = d._id.toString(); delete d._id; delete d.householdId; return { id, ...d }; }));
  } catch (e) { console.error(e); res.status(500).json({ error: "Errore" }); }
});

app.post("/api/goals", writeLimiter, requireHousehold, async (req, res) => {
  try {
    const b = req.body;
    if (!b.nome || !b.targetAmount) return res.status(400).json({ error: "Campi obbligatori: nome, targetAmount" });
    const doc = {
      householdId: req.householdId,
      nome: sanitizeText(b.nome, 100),
      targetAmount: parseFloat(b.targetAmount),
      targetDate: b.targetDate || null,
      currentAmount: parseFloat(b.currentAmount) || 0,
      contributionType: b.contributionType || "manual",
      contributionValue: b.contributionType !== "manual" ? parseFloat(b.contributionValue) || 0 : 0,
      autoAdd: b.autoAdd === true,
      contoId: b.contoId || null,
      createdAt: new Date(),
    };
    const result = await db.collection("goals").insertOne(doc);
    const id = result.insertedId.toString();
    delete doc.householdId;
    res.status(201).json({ id, ...doc });
  } catch (e) { console.error(e); res.status(500).json({ error: "Errore" }); }
});

app.put("/api/goals/:id", writeLimiter, requireHousehold, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "ID non valido" });
    const b = req.body;
    const update = {};
    if (b.nome !== undefined) update.nome = sanitizeText(b.nome, 100);
    if (b.targetAmount !== undefined) update.targetAmount = parseFloat(b.targetAmount);
    if (b.targetDate !== undefined) update.targetDate = b.targetDate;
    if (b.currentAmount !== undefined) update.currentAmount = parseFloat(b.currentAmount);
    if (b.contributionType !== undefined) update.contributionType = b.contributionType;
    if (b.contributionValue !== undefined) update.contributionValue = parseFloat(b.contributionValue);
    if (b.autoAdd !== undefined) update.autoAdd = b.autoAdd === true;
    if (b.contoId !== undefined) update.contoId = b.contoId || null;
    if (Object.keys(update).length === 0) return res.status(400).json({ error: "Nessun campo da aggiornare" });
    update.updatedAt = new Date();
    await db.collection("goals").updateOne({ _id: new ObjectId(req.params.id), householdId: req.householdId }, { $set: update });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "Errore" }); }
});

app.delete("/api/goals/:id", requireHousehold, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "ID non valido" });
    const r = await db.collection("goals").deleteOne({ _id: new ObjectId(req.params.id), householdId: req.householdId });
    if (r.deletedCount === 0) return res.status(404).json({ error: "Non trovato" });
    res.json({ deleted: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "Errore" }); }
});

// ─── Accounts (conti) API ───
app.get("/api/accounts", requireHousehold, async (req, res) => {
  try {
    const docs = await db.collection("accounts").find({ householdId: req.householdId }).sort({ createdAt: 1 }).toArray();
    res.json(docs.map(d => { const id = d._id.toString(); delete d._id; delete d.householdId; return { id, ...d }; }));
  } catch (e) { console.error(e); res.status(500).json({ error: "Errore" }); }
});

app.post("/api/accounts", writeLimiter, requireHousehold, async (req, res) => {
  try {
    const b = req.body;
    if (!b.nome) return res.status(400).json({ error: "Campo obbligatorio: nome" });
    const saldoIniziale = parseFloat(b.saldoIniziale);
    const doc = {
      householdId: req.householdId,
      nome: sanitizeText(b.nome, 60),
      icona: sanitizeText(b.icona, 8) || "🏦",
      saldoIniziale: Number.isFinite(saldoIniziale) ? saldoIniziale : 0,
      createdAt: new Date(),
    };
    const result = await db.collection("accounts").insertOne(doc);
    const id = result.insertedId.toString();
    delete doc.householdId;
    res.status(201).json({ id, ...doc });
  } catch (e) { console.error(e); res.status(500).json({ error: "Errore" }); }
});

app.put("/api/accounts/:id", writeLimiter, requireHousehold, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "ID non valido" });
    const b = req.body;
    const update = {};
    if (b.nome !== undefined) update.nome = sanitizeText(b.nome, 60);
    if (b.icona !== undefined) update.icona = sanitizeText(b.icona, 8) || "🏦";
    if (b.saldoIniziale !== undefined) {
      const v = parseFloat(b.saldoIniziale);
      if (!Number.isFinite(v)) return res.status(400).json({ error: "saldoIniziale non valido" });
      update.saldoIniziale = v;
    }
    if (Object.keys(update).length === 0) return res.status(400).json({ error: "Nessun campo da aggiornare" });
    update.updatedAt = new Date();
    await db.collection("accounts").updateOne({ _id: new ObjectId(req.params.id), householdId: req.householdId }, { $set: update });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "Errore" }); }
});

app.delete("/api/accounts/:id", writeLimiter, requireHousehold, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "ID non valido" });
    const r = await db.collection("accounts").deleteOne({ _id: new ObjectId(req.params.id), householdId: req.householdId });
    if (r.deletedCount === 0) return res.status(404).json({ error: "Non trovato" });
    // Detach the deleted account from its transactions and goals (they stay, unassigned)
    await transactionsCol.updateMany({ householdId: req.householdId, contoId: req.params.id }, { $set: { contoId: null } });
    await transactionsCol.updateMany({ householdId: req.householdId, contoDa: req.params.id }, { $set: { contoDa: null } });
    await transactionsCol.updateMany({ householdId: req.householdId, contoA: req.params.id }, { $set: { contoA: null } });
    await db.collection("goals").updateMany({ householdId: req.householdId, contoId: req.params.id }, { $set: { contoId: null } });
    res.json({ deleted: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "Errore" }); }
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
      household: { nome: req.household.nome, persone: req.household.persone, categorieUscita: req.household.categorieUscita || null },
      transactions: transactions.map(strip),
      accounts: accounts.map(strip),
      goals: goals.map(strip),
      trips: trips.map(strip),
      positions: positions.map(strip),
      manualPrices,
    });
  } catch (e) { console.error(e); res.status(500).json({ error: "Errore" }); }
});

app.post("/api/backup/restore", writeLimiter, requireHousehold, async (req, res) => {
  try {
    const b = req.body;
    if (!b || b.formato !== "balance-tracker-backup") return res.status(400).json({ error: "File non riconosciuto come backup" });
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
      doc.restoredAt = new Date();
      await db.collection("goals").insertOne(doc);
      counts.goals++;
    }

    // 3. Trips (expenses are embedded, restored as-is)
    for (const t of asArray(b.trips)) {
      const doc = clean(t);
      doc.restoredAt = new Date();
      await tripsCol.insertOne(doc);
      counts.trips++;
    }

    // 4. Positions
    for (const p of asArray(b.positions)) {
      const doc = clean(p);
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
  } catch (e) { console.error(e); res.status(500).json({ error: "Errore durante il ripristino" }); }
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
    await householdsCol.updateOne({ householdId: req.householdId }, { $set: { widgetKey: key, widgetKeyCreatedAt: new Date() } });
    await auditCol.insertOne({ householdId: req.householdId, action: "widget_key_created", at: new Date() });
    res.json({ key });
  } catch (e) { console.error(e); res.status(500).json({ error: "Errore" }); }
});

app.delete("/api/widget-key", writeLimiter, requireHousehold, async (req, res) => {
  try {
    await householdsCol.updateOne({ householdId: req.householdId }, { $unset: { widgetKey: "", widgetKeyCreatedAt: "" } });
    await auditCol.insertOne({ householdId: req.householdId, action: "widget_key_revoked", at: new Date() });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "Errore" }); }
});

const widgetLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });
app.get("/api/widget", widgetLimiter, async (req, res) => {
  try {
    const key = req.query.key;
    if (!key || typeof key !== "string" || key.length < 20) return res.status(401).json({ error: "Chiave mancante" });
    const household = await householdsCol.findOne({ widgetKey: key });
    if (!household) return res.status(401).json({ error: "Chiave non valida" });
    const hid = household.householdId;

    const [transactions, accounts, positions, priceDocs] = await Promise.all([
      transactionsCol.find({ householdId: hid, deletedAt: null }).toArray(),
      db.collection("accounts").find({ householdId: hid }).toArray(),
      db.collection("positions").find({ householdId: hid }).toArray(),
      quotesCol.find({ householdId: hid, manualPrice: { $exists: true } }).toArray(),
    ]);

    // Saldi conti (stessa logica del client)
    const saldi = {};
    for (const c of accounts) saldi[c._id.toString()] = c.saldoIniziale || 0;
    for (const t of transactions) {
      if (t.tipo === "trasferimento") {
        if (t.contoDa && saldi[t.contoDa] !== undefined) saldi[t.contoDa] -= t.importo;
        if (t.contoA && saldi[t.contoA] !== undefined) saldi[t.contoA] += t.importo;
        continue;
      }
      if (!t.contoId || saldi[t.contoId] === undefined) continue;
      if (t.tipo === "entrata") saldi[t.contoId] += t.importo;
      else if (t.tipo === "uscita") saldi[t.contoId] -= t.importo;
    }
    const conti = accounts.map(c => ({ nome: c.nome, icona: c.icona || "🏦", saldo: Math.round((saldi[c._id.toString()] || 0) * 100) / 100 }));
    const totConti = conti.reduce((s, c) => s + c.saldo, 0);

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

    // Mese corrente
    const now = new Date();
    const meseKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const txMese = transactions.filter(t => (t.data || "").startsWith(meseKey));
    const speseMese = txMese.filter(t => t.tipo === "uscita").reduce((s, t) => s + t.importo, 0);
    const entrateMese = txMese.filter(t => t.tipo === "entrata").reduce((s, t) => s + t.importo, 0);

    res.json({
      aggiornato: new Date().toISOString(),
      patrimonio: Math.round((totConti + totInvestimenti) * 100) / 100,
      conti,
      contiCompleti: accounts.map(c => ({ id: c._id.toString(), nome: c.nome, icona: c.icona || "🏦" })),
      persone: household.persone || [],
      categorie: household.categorieUscita || WIDGET_DEFAULT_CATEGORIE,
      investimenti: Math.round(totInvestimenti * 100) / 100,
      speseMese: Math.round(speseMese * 100) / 100,
      entrateMese: Math.round(entrateMese * 100) / 100,
    });
  } catch (e) { console.error(e); res.status(500).json({ error: "Errore" }); }
});

// Aggiunta rapida di una transazione dal widget. Stessa chiave dell'endpoint
// di lettura, ma con superficie di scrittura minima e volutamente rigida:
// solo tipo/importo/descrizione/data, categoria fissa lato server, nessun
// accesso a split, persone, conti o eliminazioni.
const widgetWriteLimiter = rateLimit({ windowMs: 60 * 1000, max: 15, standardHeaders: true, legacyHeaders: false });
app.post("/api/widget/transaction", widgetWriteLimiter, async (req, res) => {
  try {
    const key = req.query.key;
    if (!key || typeof key !== "string" || key.length < 20) return res.status(401).json({ error: "Chiave mancante" });
    const household = await householdsCol.findOne({ widgetKey: key });
    if (!household) return res.status(401).json({ error: "Chiave non valida" });
    const hid = household.householdId;
    const persone = household.persone || [];
    const personeIds = new Set(persone.map(p => p.id));

    const b = req.body || {};
    if (!["uscita", "entrata"].includes(b.tipo)) return res.status(400).json({ error: "Tipo non valido (uscita/entrata)" });
    const importo = parseFloat(b.importo);
    if (!Number.isFinite(importo) || importo <= 0 || importo > 1000000) return res.status(400).json({ error: "Importo non valido" });
    let data = typeof b.data === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.data) ? b.data : null;
    if (!data) data = new Date().toISOString().slice(0, 10);

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

    // Split: solo per uscite, solo se pagatoDa è valido, quote validate e
    // ricondotte a persone reali della casa (silenziosamente scartate altrimenti)
    let splits = null;
    if (b.tipo === "uscita" && pagatoDa && Array.isArray(b.splits) && b.splits.length > 0 && b.splits.length <= persone.length) {
      const cleaned = b.splits
        .filter(s => s && personeIds.has(s.personaId) && Number.isFinite(parseFloat(s.quota)))
        .map(s => ({ personaId: s.personaId, quota: Math.max(0, Math.min(100, parseFloat(s.quota))) }));
      const somma = cleaned.reduce((s, x) => s + x.quota, 0);
      if (cleaned.length > 0 && Math.abs(somma - 100) < 1) splits = cleaned;
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
    res.status(201).json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "Errore" }); }
});

// ─── Trips API ───
app.get("/api/trips", requireHousehold, async (req, res) => {
  try {
    const trips = await tripsCol.find({ householdId: req.householdId }).sort({ startDate: -1 }).toArray();
    res.json(trips.map(t => { const id = t._id.toString(); delete t._id; delete t.householdId; return { id, ...t }; }));
  } catch (e) { console.error(e); res.status(500).json({ error: "Errore" }); }
});

app.post("/api/trips", writeLimiter, requireHousehold, async (req, res) => {
  try {
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
    if (!doc.nome) return res.status(400).json({ error: "Nome richiesto" });
    const result = await tripsCol.insertOne(doc);
    delete doc.householdId;
    res.json({ id: result.insertedId.toString(), ...doc });
  } catch (e) { console.error(e); res.status(500).json({ error: "Errore" }); }
});

app.put("/api/trips/:id", writeLimiter, requireHousehold, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "ID non valido" });
    const t = req.body;
    const update = {};
    if (t.nome !== undefined) update.nome = sanitizeText(t.nome, 100);
    if (t.descrizione !== undefined) update.descrizione = sanitizeText(t.descrizione, 500);
    if (t.startDate !== undefined) update.startDate = t.startDate;
    if (t.endDate !== undefined) update.endDate = t.endDate;
    if (t.partecipanti !== undefined) update.partecipanti = sanitizePartecipanti(t.partecipanti);
    if (t.settled !== undefined) update.settled = t.settled === true;
    if (Object.keys(update).length === 0) return res.status(400).json({ error: "Nessun campo da aggiornare" });
    update.updatedAt = new Date();
    await tripsCol.updateOne({ _id: new ObjectId(req.params.id), householdId: req.householdId }, { $set: update });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "Errore" }); }
});

app.delete("/api/trips/:id", writeLimiter, requireHousehold, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "ID non valido" });
    const r = await tripsCol.deleteOne({ _id: new ObjectId(req.params.id), householdId: req.householdId });
    if (r.deletedCount === 0) return res.status(404).json({ error: "Non trovato" });
    res.json({ deleted: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "Errore" }); }
});

app.post("/api/trips/:id/expenses", writeLimiter, requireHousehold, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "ID non valido" });
    const trip = await tripsCol.findOne({ _id: new ObjectId(req.params.id), householdId: req.householdId });
    if (!trip) return res.status(404).json({ error: "Viaggio non trovato" });
    if (trip.settled) return res.status(400).json({ error: "Viaggio già chiuso" });
    
    const e = req.body;
    const expense = {
      id: randomUUID(),
      pagatoDa: sanitizeText(e.pagatoDa, 50),
      importo: parseFloat(e.importo) || 0,
      descrizione: sanitizeText(e.descrizione, 200),
      categoria: sanitizeText(e.categoria, 50) || "altro",
      data: e.data || new Date().toISOString().slice(0, 10),
      splits: sanitizeSplits(e.splits),
    };
    if (!expense.importo || expense.importo <= 0) return res.status(400).json({ error: "Importo non valido" });
    
    await tripsCol.updateOne(
      { _id: new ObjectId(req.params.id), householdId: req.householdId },
      { $push: { expenses: expense }, $set: { updatedAt: new Date() } }
    );
    res.json(expense);
  } catch (e) { console.error(e); res.status(500).json({ error: "Errore" }); }
});

app.delete("/api/trips/:id/expenses/:expenseId", writeLimiter, requireHousehold, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "ID non valido" });
    const trip = await tripsCol.findOne({ _id: new ObjectId(req.params.id), householdId: req.householdId });
    if (!trip) return res.status(404).json({ error: "Viaggio non trovato" });
    if (trip.settled) return res.status(400).json({ error: "Viaggio già chiuso" });
    
    await tripsCol.updateOne(
      { _id: new ObjectId(req.params.id), householdId: req.householdId },
      { $pull: { expenses: { id: req.params.expenseId } }, $set: { updatedAt: new Date() } }
    );
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "Errore" }); }
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
    app.listen(PORT, () => console.log(`Finanza Tracker API on :${PORT}`));
    verifyEmailSetup().catch(() => {}); // diagnostico, non deve mai bloccare l'avvio
    import("./keep-alive.js").catch(() => {});
    generaRicorrentiDovute();
    setInterval(generaRicorrentiDovute, RICORRENTI_CHECK_MS);
    svuotaCestinoScaduto();
    setInterval(svuotaCestinoScaduto, RICORRENTI_CHECK_MS);
    chiudiViaggiScaduti();
    setInterval(chiudiViaggiScaduti, RICORRENTI_CHECK_MS);
  } catch (e) { console.error(e); process.exit(1); }
}
start();
