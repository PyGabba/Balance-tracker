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

// ─── MongoDB connection ───
let db;
let transactionsCol;

async function connectDB() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db(DB_NAME);
  transactionsCol = db.collection("transactions");

  // Create indexes for performance
  await transactionsCol.createIndex({ data: -1 });
  await transactionsCol.createIndex({ tipo: 1 });
  await transactionsCol.createIndex({ pagatoDa: 1 });
  await transactionsCol.createIndex({ categoria: 1 });

  console.log(`Connected to MongoDB: ${DB_NAME}`);
  return client;
}

// ─── API Routes ───

// GET /api/transactions — list all (with optional filters)
app.get("/api/transactions", async (req, res) => {
  try {
    const { tipo, categoria, pagatoDa, meseAnno, limit } = req.query;
    const filter = {};

    if (tipo) filter.tipo = tipo;
    if (categoria) filter.categoria = categoria;
    if (pagatoDa) filter.pagatoDa = pagatoDa;

    // Filter by month: "2026-03" format
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

    // Map _id to id for frontend compatibility
    const result = docs.map(({ _id, ...rest }) => ({ id: _id.toString(), ...rest }));
    res.json(result);
  } catch (err) {
    console.error("GET /api/transactions error:", err);
    res.status(500).json({ error: "Errore nel recupero delle transazioni" });
  }
});

// POST /api/transactions — create one
app.post("/api/transactions", async (req, res) => {
  try {
    const {
      tipo, importo, categoria, descrizione, data,
      pagatoDa, splitPagante, daScontrino
    } = req.body;

    if (!tipo || !importo || !data) {
      return res.status(400).json({ error: "Campi obbligatori: tipo, importo, data" });
    }

    const doc = {
      tipo,
      importo: parseFloat(importo),
      categoria: categoria || "altro",
      descrizione: descrizione || "",
      data,
      pagatoDa: pagatoDa || null,
      splitPagante: splitPagante != null ? parseInt(splitPagante) : null,
      daScontrino: !!daScontrino,
      createdAt: new Date(),
    };

    const result = await transactionsCol.insertOne(doc);
    res.status(201).json({ id: result.insertedId.toString(), ...doc });
  } catch (err) {
    console.error("POST /api/transactions error:", err);
    res.status(500).json({ error: "Errore nel salvataggio" });
  }
});

// DELETE /api/transactions/:id — delete one
app.delete("/api/transactions/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "ID non valido" });
    }
    const result = await transactionsCol.deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "Transazione non trovata" });
    }
    res.json({ deleted: true, id });
  } catch (err) {
    console.error("DELETE /api/transactions error:", err);
    res.status(500).json({ error: "Errore nell'eliminazione" });
  }
});

// PUT /api/transactions/:id — update one
app.put("/api/transactions/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "ID non valido" });
    }

    const update = {};
    const allowed = ["tipo", "importo", "categoria", "descrizione", "data", "pagatoDa", "splitPagante", "daScontrino"];
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        update[key] = key === "importo" ? parseFloat(req.body[key])
          : key === "splitPagante" ? (req.body[key] != null ? parseInt(req.body[key]) : null)
          : req.body[key];
      }
    }
    update.updatedAt = new Date();

    const result = await transactionsCol.findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: update },
      { returnDocument: "after" }
    );

    if (!result) {
      return res.status(404).json({ error: "Transazione non trovata" });
    }

    const { _id, ...rest } = result;
    res.json({ id: _id.toString(), ...rest });
  } catch (err) {
    console.error("PUT /api/transactions error:", err);
    res.status(500).json({ error: "Errore nell'aggiornamento" });
  }
});

// GET /api/stats/summary — aggregated stats
app.get("/api/stats/summary", async (req, res) => {
  try {
    const { meseAnno } = req.query;
    const match = {};
    if (meseAnno) {
      const [anno, mese] = meseAnno.split("-").map(Number);
      const start = new Date(anno, mese - 1, 1).toISOString().slice(0, 10);
      const end = new Date(anno, mese, 0).toISOString().slice(0, 10);
      match.data = { $gte: start, $lte: end };
    }

    const pipeline = [
      { $match: match },
      {
        $group: {
          _id: { tipo: "$tipo", categoria: "$categoria", pagatoDa: "$pagatoDa" },
          totale: { $sum: "$importo" },
          count: { $sum: 1 },
        },
      },
    ];

    const results = await transactionsCol.aggregate(pipeline).toArray();
    res.json(results);
  } catch (err) {
    console.error("GET /api/stats/summary error:", err);
    res.status(500).json({ error: "Errore nelle statistiche" });
  }
});

// GET /api/stats/debiti — debt balance
app.get("/api/stats/debiti", async (req, res) => {
  try {
    const pipeline = [
      { $match: { tipo: "uscita", pagatoDa: { $ne: null }, splitPagante: { $ne: null } } },
      {
        $project: {
          pagatoDa: 1,
          importo: 1,
          splitPagante: 1,
          quotaAltro: { $multiply: ["$importo", { $divide: [{ $subtract: [100, "$splitPagante"] }, 100] }] },
          data: 1,
        },
      },
      {
        $group: {
          _id: null,
          // Positive = Gabriele owes Laura
          saldo: {
            $sum: {
              $cond: [{ $eq: ["$pagatoDa", "laura"] }, "$quotaAltro", { $multiply: ["$quotaAltro", -1] }],
            },
          },
        },
      },
    ];

    const result = await transactionsCol.aggregate(pipeline).toArray();
    const saldo = result.length > 0 ? result[0].saldo : 0;
    res.json({ saldoVersoLaura: saldo });
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
    app.listen(PORT, () => {
      console.log(`Finanza Tracker API running on http://localhost:${PORT}`);
    });
    // Start keep-alive pinger
    import("./keep-alive.js").catch(() => {});
  } catch (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }
}

start();
