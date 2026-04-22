import express from "express";
import cors from "cors";
import helmet from "helmet";
import { MongoClient, ObjectId } from "mongodb";
import { createHmac } from "crypto";
import dotenv from "dotenv";
import YahooFinance from "yahoo-finance2";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import nodemailer from "nodemailer";
dotenv.config();

// ─── Email alert ───
async function sendLockoutAlert(ip, deviceId) {
  if (!process.env.GMAIL_APP_PASSWORD) return;
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: "pygabba@gmail.com", pass: process.env.GMAIL_APP_PASSWORD },
  });
  await transporter.sendMail({
    from: "pygabba@gmail.com",
    to: "pygabba@gmail.com",
    subject: "⚠️ Balance Tracker: accesso bloccato",
    text: `10 tentativi di PIN errati rilevati.\nIP: ${ip}\nDevice ID: ${deviceId || "sconosciuto"}\nAccount bloccato per 10 minuti.\n\n${new Date().toISOString()}`,
  });
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

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-in-production";
function signToken(householdId) {
  return jwt.sign({ householdId }, JWT_SECRET, { expiresIn: "90d" });
}
function pinLookupKey(pin) {
  return createHmac("sha256", JWT_SECRET).update(pin).digest("hex");
}
async function hashPin(pin) { return bcrypt.hash(pin, 10); }

const yf = new YahooFinance();

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return fwd.split(",")[0].trim();
  return req.socket?.remoteAddress || req.ip;
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
];
// Allow any Vercel preview deploy for this project
const VERCEL_PREVIEW_RE = /^https:\/\/balance-tracker-[a-z0-9-]+-pygabba\.vercel\.app$/;
const CORS_OPTIONS = {
  origin(origin, cb) {
    if (!origin) return cb(null, true); // native app / curl / server-to-server
    if (ALLOWED_ORIGINS.includes(origin) || VERCEL_PREVIEW_RE.test(origin))
      return cb(null, true);
    cb(new Error(`CORS: origin not allowed: ${origin}`));
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  optionsSuccessStatus: 200,
};
app.use(cors(CORS_OPTIONS));
app.options("*", cors(CORS_OPTIONS));
app.use(express.json({ limit: "10mb" }));

let db, transactionsCol, householdsCol, quotesCol, blacklistCol;
async function connectDB() {
  const client = new MongoClient(MONGO_URI); await client.connect();
  db = client.db(DB_NAME);
  transactionsCol = db.collection("transactions");
  householdsCol = db.collection("households");
  locksCol = db.collection("login_locks");
  quotesCol = db.collection("quotes_cache");
  blacklistCol = db.collection("blacklist");
  await transactionsCol.createIndex({ householdId: 1, data: -1 });
  try { await householdsCol.dropIndex("pin_1"); } catch {}
  await householdsCol.createIndex({ pin: 1 }, { unique: true, sparse: true });
  await householdsCol.createIndex({ pinLookup: 1 }, { unique: true, sparse: true });
  await householdsCol.createIndex({ householdId: 1 }, { unique: true });
  try { await locksCol.dropIndex("ip_1"); } catch {}
  await locksCol.createIndex({ key: 1 }, { unique: true });
  await locksCol.createIndex({ lockedUntil: 1 }, { expireAfterSeconds: 0, sparse: true });
  await blacklistCol.createIndex({ key: 1 }, { unique: true });
  // One-time migration: flag all existing households to require a 6-digit PIN change
  await householdsCol.updateMany(
    { requiresPinChange: { $exists: false } },
    { $set: { requiresPinChange: true } }
  );
  console.log("Connected: " + DB_NAME); return client;
}

// ─── Blacklist helpers ───
async function isBlacklisted(key) {
  const rec = await blacklistCol.findOne({ key });
  return !!rec;
}

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
  if (dbH) return { id: dbH.householdId, nome: dbH.nome, persone: dbH.persone, categorieUscita: dbH.categorieUscita || null, requiresPinChange: dbH.requiresPinChange || false };
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

async function requireHousehold(req, res, next) {
  const auth = req.headers["authorization"];
  if (!auth?.startsWith("Bearer ")) return res.status(401).json({ error: "Household non valido" });
  let payload;
  try { payload = jwt.verify(auth.slice(7), JWT_SECRET, { algorithms: ["HS256"] }); }
  catch { return res.status(401).json({ error: "Token non valido" }); }
  const hid = payload.householdId;
  try {
    const household = await findHousehold(hid);
    if (!household) return res.status(401).json({ error: "Household non valido" });
    req.household = household; req.householdId = hid; next();
  } catch (e) { res.status(500).json({ error: "Errore autenticazione" }); }
}

// ─── Rate limiters ───
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,                    // 5 registrations per IP per hour
  standardHeaders: true, legacyHeaders: false,
  message: { error: "Troppi account creati, riprova tra un'ora" },
});

const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true, legacyHeaders: false,
  message: { error: "Troppi tentativi admin" },
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const ip = clientIp(req);
    const deviceId = req.body?.deviceId || null;
    const ipKey = `ip:${ip}`;
    const devKey = deviceId ? `device:${deviceId}` : null;

    // Check blacklist first — permanent block
    const [ipBanned, devBanned] = await Promise.all([
      isBlacklisted(ipKey),
      devKey ? isBlacklisted(devKey) : false,
    ]);
    if (ipBanned || devBanned) {
      return res.status(403).json({ error: "Accesso permanentemente bloccato" });
    }

    // Check both locks — blocked if either is active
    const [ipLock, devLock] = await Promise.all([
      checkLock(ipKey),
      devKey ? checkLock(devKey) : null,
    ]);
    const activeLock = (ipLock?.lockedUntil && ipLock) || (devLock?.lockedUntil && devLock);
    if (activeLock) {
      const mins = Math.ceil((activeLock.lockedUntil - new Date()) / 60000);
      return res.status(429).json({ error: `Accesso bloccato. Riprova tra ${mins} minuti.` });
    }

    const household = await findHouseholdByPin(req.body?.pin);
    if (!household) {
      const [ipNowLocked, devNowLocked] = await Promise.all([
        recordFail(ipKey),
        devKey ? recordFail(devKey) : false,
      ]);
      if (ipNowLocked || devNowLocked) sendLockoutAlert(ip, deviceId).catch(console.error);
      return res.status(401).json({ error: "PIN non valido" });
    }

    await Promise.all([clearLock(ipKey), devKey ? clearLock(devKey) : null]);
    res.json({ ...household, token: signToken(household.householdId) });
  } catch (e) { res.status(500).json({ error: "Errore login" }); }
});

app.post("/api/auth/register", registerLimiter, async (req, res) => {
  try {
    const { nome, persone, pin } = req.body || {};
    if (!nome || !pin || !Array.isArray(persone) || persone.length === 0)
      return res.status(400).json({ error: "Campi obbligatori: nome, persone, pin" });
    if (!/^\d{6,8}$/.test(pin))
      return res.status(400).json({ error: "Il PIN deve essere di 6-8 cifre" });

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
    const doc = { householdId, nome, persone: personeFormatted, pinHash, pinLookup: pinLookupKey(pin), createdAt: new Date() };
    await householdsCol.insertOne(doc);
    res.status(201).json({ householdId, nome, persone: personeFormatted, token: signToken(householdId) });
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ error: "PIN già in uso, scegline un altro" });
    console.error("Register error:", e);
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
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "Errore aggiornamento PIN" }); }
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
    await householdsCol.deleteOne({ householdId: req.householdId });

    res.json({ ok: true });
  } catch (e) { console.error("Delete household error:", e); res.status(500).json({ error: "Errore durante l'eliminazione" }); }
});

// ─── GET household info ───
app.get("/api/household", requireHousehold, (req, res) => {
  res.json({ id: req.household.id, nome: req.household.nome, persone: req.household.persone });
});

// ─── GET transactions ───
app.get("/api/transactions", requireHousehold, async (req, res) => {
  try {
    const { tipo, categoria, pagatoDa, meseAnno, limit } = req.query;
    const filter = { householdId: req.householdId };
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
app.post("/api/transactions", requireHousehold, async (req, res) => {
  try {
    const b = req.body;
    if (!b.tipo || !b.importo || !b.data) return res.status(400).json({ error: "Campi obbligatori" });
    const doc = {
      householdId: req.householdId,
      tipo: b.tipo,
      importo: parseFloat(b.importo),
      categoria: b.categoria || "altro",
      descrizione: b.descrizione || "",
      data: b.data,
      pagatoDa: b.pagatoDa || null,
      ricevutoDa: b.ricevutoDa || null,
      splits: Array.isArray(b.splits) && b.splits.length > 0 ? b.splits : null,
      extraPersone: Array.isArray(b.extraPersone) && b.extraPersone.length > 0 ? b.extraPersone : null,
      splitPagante: b.splitPagante != null ? parseInt(b.splitPagante) : null,
      intestataA: b.intestataA || null,
      createdAt: new Date(),
    };
    const result = await transactionsCol.insertOne(doc);
    const id = result.insertedId.toString();
    delete doc.householdId;
    res.status(201).json({ id, ...doc });
  } catch (e) { console.error(e); res.status(500).json({ error: "Errore" }); }
});

// ─── DELETE transaction ───
app.delete("/api/transactions/:id", requireHousehold, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "ID non valido" });
    const r = await transactionsCol.deleteOne({ _id: new ObjectId(req.params.id), householdId: req.householdId });
    if (r.deletedCount === 0) return res.status(404).json({ error: "Non trovata" });
    res.json({ deleted: true, id: req.params.id });
  } catch (e) { console.error(e); res.status(500).json({ error: "Errore" }); }
});

// ─── PUT transaction ───
app.put("/api/transactions/:id", requireHousehold, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "ID non valido" });
    const update = {};
    const allowed = ["tipo","importo","categoria","descrizione","data","pagatoDa","ricevutoDa","splitPagante","intestataA","splits","extraPersone"];
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        if (key === "importo") update[key] = parseFloat(req.body[key]);
        else if (key === "splitPagante") update[key] = req.body[key] != null ? parseInt(req.body[key]) : null;
        else if (key === "splits") update[key] = Array.isArray(req.body[key]) ? req.body[key] : null;
        else if (key === "extraPersone") update[key] = Array.isArray(req.body[key]) ? req.body[key] : null;
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
      householdId: req.householdId, tipo: "uscita", pagatoDa: { $ne: null }
    }).toArray();

    // Also fetch saldo transactions to account for settlements
    const saldi = await transactionsCol.find({
      householdId: req.householdId, tipo: "saldo", pagatoDa: { $ne: null }, ricevutoDa: { $ne: null }
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
    const match = { householdId: req.householdId };
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
    await householdsCol.updateOne(
      { householdId: req.householdId },
      { $set: { categorieUscita: categorie, updatedAt: new Date() } }
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

app.post("/api/positions", requireHousehold, requirePortfolioAccess, async (req, res) => {
  try {
    const b = req.body;
    if (!b.ticker || !b.quantita || !b.prezzoAcquisto) return res.status(400).json({ error: "Campi obbligatori: ticker, quantita, prezzoAcquisto" });
    const doc = {
      householdId: req.householdId,
      ticker: b.ticker.toUpperCase().trim(),
      nome: b.nome || b.ticker.toUpperCase().trim(),
      quantita: parseFloat(b.quantita),
      prezzoAcquisto: parseFloat(b.prezzoAcquisto),
      dataAcquisto: b.dataAcquisto || new Date().toISOString().slice(0, 10),
      valuta: b.valuta || "EUR",
      note: b.note || "",
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
    // Remove all existing manual prices for this household, then upsert new ones
    await quotesCol.deleteMany({ householdId: req.householdId, manualPrice: { $exists: true } });
    for (const [ticker, price] of Object.entries(manualPrices)) {
      await quotesCol.updateOne(
        { ticker: ticker.toUpperCase(), householdId: req.householdId },
        { $set: { ticker: ticker.toUpperCase(), householdId: req.householdId, manualPrice: price, updatedAt: new Date() } },
        { upsert: true }
      );
    }
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "Errore" }); }
});

// Stock quotes via yahoo-finance2 library (handles cookies/crumb automatically)
// Supports all exchanges: .MI (Milano), .DE (Frankfurt), .L (London), US, etc.
// Cached once per day in MongoDB

app.get("/api/quotes", requireHousehold, async (req, res) => {
  try {
    const symbols = req.query.symbols;
    if (!symbols) return res.status(400).json({ error: "symbols required" });
    const forceRefresh = req.query.refresh === "true";
    const tickers = symbols.split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
    const today = new Date().toISOString().slice(0, 10);
    const quotes = {};

    // Check cache first
    const toFetch = [];
    for (const sym of tickers) {
      if (!forceRefresh) {
        const cached = await quotesCol.findOne({ ticker: sym, dataCache: today });
        if (cached) { quotes[sym] = cached.quote; continue; }
      }
      toFetch.push(sym);
    }

    // Fetch missing tickers via yahoo-finance2
    if (toFetch.length > 0) {
      for (const sym of toFetch) {
        try {
          const q = await yf.quote(sym);
          if (q && q.regularMarketPrice) {
            const quote = {
              prezzo: q.regularMarketPrice || 0,
              cambio: q.regularMarketChange || 0,
              cambioPct: q.regularMarketChangePercent || 0,
              valuta: q.currency || "EUR",
              nome: q.shortName || q.longName || q.symbol || sym,
              apertura: q.regularMarketOpen || 0,
              massimo: q.regularMarketDayHigh || 0,
              minimo: q.regularMarketDayLow || 0,
              volume: q.regularMarketVolume || 0,
              chiusuraPrec: q.regularMarketPreviousClose || 0,
              marketCap: q.marketCap || 0,
              maxAnno: q.fiftyTwoWeekHigh || 0,
              minAnno: q.fiftyTwoWeekLow || 0,
              exchange: q.exchange || "",
            };
            quotes[sym] = quote;
            await quotesCol.updateOne(
              { ticker: sym },
              { $set: { ticker: sym, quote, dataCache: today, updatedAt: new Date() } },
              { upsert: true }
            );
          }
        } catch (err) {
          console.error(`Quote error for ${sym}:`, err.message);
          // Fallback to stale cache
          const stale = await quotesCol.findOne({ ticker: sym });
          if (stale) quotes[sym] = stale.quote;
        }
      }
    }

    const cached = toFetch.length === 0;
    res.json({ quotes, cached, aggiornamento: today });
  } catch (e) {
    console.error("Quotes error:", e.message);
    res.status(502).json({ error: "Impossibile recuperare le quotazioni" });
  }
});

async function start() {
  try {
    await connectDB();
    app.listen(PORT, () => console.log(`Finanza Tracker API on :${PORT}`));
    import("./keep-alive.js").catch(() => {});
  } catch (e) { console.error(e); process.exit(1); }
}
start();
