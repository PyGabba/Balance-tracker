import express from "express";
import cors from "cors";
import { MongoClient, ObjectId } from "mongodb";
import dotenv from "dotenv";
import YahooFinance from "yahoo-finance2";
dotenv.config();

const yf = new YahooFinance();

const app = express();
const PORT = process.env.PORT || 3001;
const MONGO_URI = process.env.MONGODB_URI || "mongodb://localhost:27017";
const DB_NAME = process.env.DB_NAME || "finanza_tracker";
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const HOUSEHOLDS = [
  { id: "laura-gabriele", nome: "Laura & Gabriele", pin: process.env.PIN_LAURA_GABRIELE || "1234",
    persone: [{ id: "laura", nome: "Laura", emoji: "👩", colore: "#E84393" },{ id: "gabriele", nome: "Gabriele", emoji: "👨", colore: "#0984E3" }] },
  { id: "viaggio-irlanda", nome: "Irlanda", pin: process.env.PIN_IRLANDA || "5678",
    persone: [{ id: "gabriele", nome: "Gabriele", emoji: "👨", colore: "#00B894" },{ id: "laura", nome: "Laura", emoji: "👩", colore: "#FD79A8" },{ id: "marco", nome: "Marco", emoji: "👨", colore: "#0984E3" },{ id: "roberta", nome: "Roberta", emoji: "👩", colore: "#E84393" }] },
];

let db, transactionsCol;
async function connectDB() {
  const client = new MongoClient(MONGO_URI); await client.connect();
  db = client.db(DB_NAME); transactionsCol = db.collection("transactions");
  await transactionsCol.createIndex({ householdId: 1, data: -1 });
  console.log("Connected: " + DB_NAME); return client;
}

function requireHousehold(req, res, next) {
  const hid = req.headers["x-household-id"];
  const household = HOUSEHOLDS.find(h => h.id === hid);
  if (!household) return res.status(401).json({ error: "Household non valido" });
  req.household = household; req.householdId = hid; next();
}

// ─── Auth ───
app.post("/api/auth/login", (req, res) => {
  const household = HOUSEHOLDS.find(h => h.pin === (req.body && req.body.pin));
  if (!household) return res.status(401).json({ error: "PIN non valido" });
  res.json({ householdId: household.id, nome: household.nome, persone: household.persone });
});
app.get("/api/auth/households", (req, res) => res.json(HOUSEHOLDS.map(h => ({ id: h.id, nome: h.nome, persone: h.persone }))));

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
    const allowed = ["tipo","importo","categoria","descrizione","data","pagatoDa","splitPagante","intestataA","splits","extraPersone"];
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

    const net = {};
    function addDebt(creditor, debtor, amount) {
      if (creditor === debtor || amount <= 0) return;
      if (!net[creditor]) net[creditor] = {};
      if (!net[debtor]) net[debtor] = {};
      net[creditor][debtor] = (net[creditor][debtor] || 0) + amount;
      net[debtor][creditor] = (net[debtor][creditor] || 0) - amount;
    }

    for (const t of txs) {
      const payer = t.pagatoDa;
      if (t.splits && Array.isArray(t.splits) && t.splits.length > 0) {
        const totalQ = t.splits.reduce((s, sh) => s + (sh.quota || 0), 0);
        if (totalQ <= 0) continue;
        for (const sh of t.splits) {
          if (sh.personaId === payer) continue;
          addDebt(payer, sh.personaId, t.importo * (sh.quota / totalQ));
        }
      } else if (t.splitPagante != null) {
        const other = req.household.persone.find(p => p.id !== payer);
        if (other) addDebt(payer, other.id, t.importo * (100 - t.splitPagante) / 100);
      }
    }

    const debiti = [], seen = {};
    for (const a of Object.keys(net)) {
      for (const b of Object.keys(net[a] || {})) {
        const key = [a, b].sort().join("|");
        if (seen[key]) continue;
        seen[key] = true;
        const v = net[a][b] || 0;
        if (Math.abs(v) > 0.01) {
          debiti.push(v > 0
            ? { da: b, a: a, importo: +(v.toFixed(2)) }
            : { da: a, a: b, importo: +(Math.abs(v).toFixed(2)) }
          );
        }
      }
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

// ─── Stock Positions ───
// Collection: positions { householdId, ticker, nome, quantita, prezzoAcquisto, dataAcquisto, valuta, note, createdAt }

// Only laura-gabriele can access portfolio
function requirePortfolioAccess(req, res, next) {
  if (req.householdId !== "laura-gabriele") return res.status(403).json({ error: "Portfolio non disponibile per questo account" });
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

// Stock quotes via yahoo-finance2 library (handles cookies/crumb automatically)
// Supports all exchanges: .MI (Milano), .DE (Frankfurt), .L (London), US, etc.
// Cached once per day in MongoDB

app.get("/api/quotes", async (req, res) => {
  try {
    const symbols = req.query.symbols;
    if (!symbols) return res.status(400).json({ error: "symbols required" });
    const forceRefresh = req.query.refresh === "true";
    const tickers = symbols.split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
    const quotesCol = db.collection("quotes_cache");
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
