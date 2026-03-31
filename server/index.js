import express from "express";
import cors from "cors";
import { MongoClient, ObjectId } from "mongodb";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const MONGO_URI = process.env.MONGODB_URI || "mongodb://localhost:27017";
const DB_NAME = process.env.DB_NAME || "finanza_tracker";

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// ─── Households config ───
// Each household has an id, a PIN for login, and two members
const HOUSEHOLDS = [
  {
    id: "laura-gabriele",
    nome: "Laura & Gabriele",
    pin: process.env.PIN_LAURA_GABRIELE || "1234",
    persone: [
      { id: "laura", nome: "Laura", emoji: "👩", colore: "#E84393" },
      { id: "gabriele", nome: "Gabriele", emoji: "👨", colore: "#0984E3" },
    ],
  },
  {
    id: "gianmarco-giulia",
    nome: "Gian Marco & Giulia",
    pin: process.env.PIN_GIANMARCO_GIULIA || "5678",
    persone: [
      { id: "gianmarco", nome: "Gian Marco", emoji: "👨", colore: "#00B894" },
      { id: "giulia", nome: "Giulia", emoji: "👩", colore: "#FD79A8" },
    ],
  },
];

// ─── MongoDB connection ───
let db;
let transactionsCol;

async function connectDB() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db(DB_NAME);
  transactionsCol = db.collection("transactions");

  await transactionsCol.createIndex({ householdId: 1, data: -1 });
  await transactionsCol.createIndex({ householdId: 1, tipo: 1 });
  await transactionsCol.createIndex({ householdId: 1, pagatoDa: 1 });
  await transactionsCol.createIndex({ householdId: 1, categoria: 1 });

  console.log(`Connected to MongoDB: ${DB_NAME}`);
  return client;
}

// ─── Auth middleware ───
// Expects header: x-household-id
function requireHousehold(req, res, next) {
  const hid = req.headers["x-household-id"];
  if (!hid) return res.status(401).json({ error: "Household non specificato" });
  const household = HOUSEHOLDS.find(h => h.id === hid);
  if (!household) return res.status(401).json({ error: "Household non valido" });
  req.household = household;
  req.householdId = hid;
  next();
}

// ─── Auth routes ───

// POST /api/auth/login — verify PIN and return household info
app.post("/api/auth/login", (req, res) => {
  const { pin } = req.body;
  if (!pin) return res.status(400).json({ error: "PIN richiesto" });

  const household = HOUSEHOLDS.find(h => h.pin === pin);
  if (!household) return res.status(401).json({ error: "PIN non valido" });

  // Return household info (no sensitive data)
  res.json({
    householdId: household.id,
    nome: household.nome,
    persone: household.persone,
  });
});

// GET /api/auth/households — list available households (no PINs)
app.get("/api/auth/households", (req, res) => {
  res.json(HOUSEHOLDS.map(h => ({ id: h.id, nome: h.nome, persone: h.persone })));
});

// GET /api/auth/household/:id — get household info (requires valid header)
app.get("/api/auth/household/:id", (req, res) => {
  const household = HOUSEHOLDS.find(h => h.id === req.params.id);
  if (!household) return res.status(404).json({ error: "Household non trovato" });
  res.json({ id: household.id, nome: household.nome, persone: household.persone });
});

// ─── Transaction routes (all require household) ───

// GET /api/transactions
app.get("/api/transactions", requireHousehold, async (req, res) => {
  try {
    const { tipo, categoria, pagatoDa, meseAnno, limit } = req.query;
    const filter = { householdId: req.householdId };

    if (tipo) filter.tipo = tipo;
    if (categoria) filter.categoria = categoria;
    if (pagatoDa) filter.pagatoDa = pagatoDa;

    if (meseAnno) {
      const [anno, mese] = meseAnno.split("-").map(Number);
      const start = new Date(anno, mese - 1, 1).toISOString().slice(0, 10);
      const end = new Date(anno, mese, 0).toISOString().slice(0, 10);
      filter.data = { $gte: start, $lte: end };
    }

    const docs = await transactionsCol
      .find(filter)
      .sort({ data: -1, _id: -1 })
      .limit(parseInt(limit) || 500)
      .toArray();

    const result = docs.map(({ _id, householdId, ...rest }) => ({ id: _id.toString(), ...rest }));
    res.json(result);
  } catch (err) {
    console.error("GET /api/transactions error:", err);
    res.status(500).json({ error: "Errore nel recupero delle transazioni" });
  }
});

// POST /api/transactions
app.post("/api/transactions", requireHousehold, async (req, res) => {
  try {
    const { tipo, importo, categoria, descrizione, data, pagatoDa, splitPagante, daScontrino, intestataA } = req.body;

    if (!tipo || !importo || !data) {
      return res.status(400).json({ error: "Campi obbligatori: tipo, importo, data" });
    }

    const doc = {
      householdId: req.householdId,
      tipo,
      importo: parseFloat(importo),
      categoria: categoria || "altro",
      descrizione: descrizione || "",
      data,
      pagatoDa: pagatoDa || null,
      splitPagante: splitPagante != null ? parseInt(splitPagante) : null,
      intestataA: intestataA || null,
      daScontrino: !!daScontrino,
      createdAt: new Date(),
    };

    const result = await transactionsCol.insertOne(doc);
    const { householdId, ...rest } = doc;
    res.status(201).json({ id: result.insertedId.toString(), ...rest });
  } catch (err) {
    console.error("POST /api/transactions error:", err);
    res.status(500).json({ error: "Errore nel salvataggio" });
  }
});

// DELETE /api/transactions/:id
app.delete("/api/transactions/:id", requireHousehold, async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: "ID non valido" });

    const result = await transactionsCol.deleteOne({ _id: new ObjectId(id), householdId: req.householdId });
    if (result.deletedCount === 0) return res.status(404).json({ error: "Transazione non trovata" });
    res.json({ deleted: true, id });
  } catch (err) {
    console.error("DELETE /api/transactions error:", err);
    res.status(500).json({ error: "Errore nell'eliminazione" });
  }
});

// PUT /api/transactions/:id
app.put("/api/transactions/:id", requireHousehold, async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: "ID non valido" });

    const update = {};
    const allowed = ["tipo", "importo", "categoria", "descrizione", "data", "pagatoDa", "splitPagante", "daScontrino", "intestataA"];
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        update[key] = key === "importo" ? parseFloat(req.body[key])
          : key === "splitPagante" ? (req.body[key] != null ? parseInt(req.body[key]) : null)
          : req.body[key];
      }
    }
    update.updatedAt = new Date();

    const result = await transactionsCol.findOneAndUpdate(
      { _id: new ObjectId(id), householdId: req.householdId },
      { $set: update },
      { returnDocument: "after" }
    );

    if (!result) return res.status(404).json({ error: "Transazione non trovata" });
    const { _id, householdId, ...rest } = result;
    res.json({ id: _id.toString(), ...rest });
  } catch (err) {
    console.error("PUT /api/transactions error:", err);
    res.status(500).json({ error: "Errore nell'aggiornamento" });
  }
});

// GET /api/stats/summary
app.get("/api/stats/summary", requireHousehold, async (req, res) => {
  try {
    const { meseAnno } = req.query;
    const match = { householdId: req.householdId };
    if (meseAnno) {
      const [anno, mese] = meseAnno.split("-").map(Number);
      match.data = { $gte: new Date(anno, mese-1, 1).toISOString().slice(0,10), $lte: new Date(anno, mese, 0).toISOString().slice(0,10) };
    }
    const results = await transactionsCol.aggregate([
      { $match: match },
      { $group: { _id: { tipo: "$tipo", categoria: "$categoria", pagatoDa: "$pagatoDa" }, totale: { $sum: "$importo" }, count: { $sum: 1 } } },
    ]).toArray();
    res.json(results);
  } catch (err) {
    console.error("GET /api/stats/summary error:", err);
    res.status(500).json({ error: "Errore nelle statistiche" });
  }
});

// GET /api/stats/debiti
app.get("/api/stats/debiti", requireHousehold, async (req, res) => {
  try {
    const persona1 = req.household.persone[0].id;
    const pipeline = [
      { $match: { householdId: req.householdId, tipo: "uscita", pagatoDa: { $ne: null }, splitPagante: { $ne: null } } },
      { $project: { pagatoDa: 1, importo: 1, splitPagante: 1, quotaAltro: { $multiply: ["$importo", { $divide: [{ $subtract: [100, "$splitPagante"] }, 100] }] } } },
      { $group: { _id: null, saldo: { $sum: { $cond: [{ $eq: ["$pagatoDa", persona1] }, "$quotaAltro", { $multiply: ["$quotaAltro", -1] }] } } } },
    ];
    const result = await transactionsCol.aggregate(pipeline).toArray();
    res.json({ saldoVersoPersona1: result.length > 0 ? result[0].saldo : 0 });
  } catch (err) {
    console.error("GET /api/stats/debiti error:", err);
    res.status(500).json({ error: "Errore nel calcolo debiti" });
  }
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", db: !!db });
});

// ─── Start server ───
async function start() {
  try {
    await connectDB();
    app.listen(PORT, () => console.log(`Finanza Tracker API on http://localhost:${PORT}`));
    import("./keep-alive.js").catch(() => {});
  } catch (err) {
    console.error("Failed to start:", err);
    process.exit(1);
  }
}

start();
