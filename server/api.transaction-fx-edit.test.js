import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { ObjectId } from "mongodb";
import { startTestServer, stopTestServer, getDb } from "./testUtils.js";

// Regression: PUT /api/transactions/:id only recomputed foreign-currency
// metadata (valuta/importoOriginale/tassoCambio) when the request touched
// BOTH importo and valuta together. An amount-only edit — which is exactly
// what the edit UI (TransactionRow.jsx) always sends, since it initializes
// its field from the base-currency importo and never exposes valuta at
// all — left the OLD importoOriginale/tassoCambio attached to the NEW
// importo: an internally contradictory record (the stored "original
// amount at this rate" no longer matches the amount actually saved).

let app;
let agent;

beforeAll(async () => {
  app = await startTestServer();
  agent = request.agent(app);
  const reg = await agent.post("/api/auth/register")
    .send({ nome: "FX Edit Household", persone: ["Gabriele"], pin: "748213" });
  expect(reg.status).toBe(201);
  await agent.post("/api/auth/login").send({ pin: "748213" });
}, 60000);

afterAll(async () => {
  await stopTestServer();
});

async function seedFxTransaction() {
  const db = getDb();
  const household = await db.collection("households").findOne({ nome: "FX Edit Household" });
  const doc = {
    householdId: household.householdId,
    tipo: "uscita",
    importo: 90, // base currency (EUR), already converted
    importoMinorUnits: 9000,
    valuta: "USD",
    importoOriginale: 100,
    importoOriginaleMinorUnits: 10000,
    tassoCambio: 0.9,
    categoria: "altro",
    descrizione: "Cena USD",
    data: "2026-08-01",
    createdAt: new Date(),
  };
  const r = await db.collection("transactions").insertOne(doc);
  return r.insertedId.toString();
}

describe("PUT /api/transactions/:id — amount-only edit of a foreign-currency transaction", () => {
  it("clears the now-stale FX metadata instead of leaving it attached to the new amount", async () => {
    const id = await seedFxTransaction();

    const res = await agent.put(`/api/transactions/${id}`).send({ importo: 200 });
    expect(res.status).toBe(200);
    expect(res.body.importo).toBe(200);
    expect(res.body.valuta).toBeUndefined();
    expect(res.body.importoOriginale).toBeUndefined();
    expect(res.body.tassoCambio).toBeUndefined();

    // Confirm it's actually gone from the database, not just missing from
    // this response's projection.
    const db = getDb();
    const stored = await db.collection("transactions").findOne({ _id: new ObjectId(id) });
    expect(stored.importo).toBe(200);
    expect(stored.valuta).toBeUndefined();
    expect(stored.importoOriginale).toBeUndefined();
    expect(stored.importoOriginaleMinorUnits).toBeUndefined();
    expect(stored.tassoCambio).toBeUndefined();
    expect(stored.tassoCambioObsoleto).toBeUndefined();
  });

  it("does not touch FX metadata when the edit doesn't touch importo at all", async () => {
    const id = await seedFxTransaction();

    const res = await agent.put(`/api/transactions/${id}`).send({ descrizione: "Cena USD (updated)" });
    expect(res.status).toBe(200);
    expect(res.body.valuta).toBe("USD");
    expect(res.body.importoOriginale).toBe(100);
    expect(res.body.tassoCambio).toBe(0.9);
  });

  it("a plain (never-FX) transaction's amount-only edit is unaffected (no metadata to clear)", async () => {
    const create = await agent.post("/api/transactions").send({ tipo: "uscita", importo: 10, data: "2026-08-01" });
    expect(create.status).toBe(201);

    const res = await agent.put(`/api/transactions/${create.body.id}`).send({ importo: 25 });
    expect(res.status).toBe(200);
    expect(res.body.importo).toBe(25);
    expect(res.body.valuta).toBeUndefined();
  });
});
