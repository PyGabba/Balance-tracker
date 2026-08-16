// Exercises the background jobs directly against the real (in-memory)
// database rather than through HTTP — this is what MOD-007/MOD-008 actually
// need proven: that a unique-index-backed atomic claim holds when two
// instances race, not just that the pure eligibility logic in
// validation.test.js is correct (that file explicitly says it's a spec, not
// proof of the database-level guarantee — this is that proof).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startTestServer, stopTestServer, clearCollections, getDb } from "./testUtils.js";
import { generaRicorrentiDovute, chiudiViaggiScaduti } from "./index.js";

beforeAll(async () => {
  await startTestServer();
}, 60000);

afterAll(async () => {
  await stopTestServer();
});

beforeEach(async () => {
  await clearCollections();
});

describe("generaRicorrentiDovute (MOD-007) — concurrent generation", () => {
  it("two concurrent runs against the same due recurrence generate exactly one occurrence", async () => {
    const db = getDb();
    const parent = {
      householdId: "hh-jobs-test",
      tipo: "uscita",
      importo: 20,
      categoria: "bollette",
      descrizione: "Abbonamento",
      data: "2026-01-01",
      pagatoDa: null,
      deletedAt: null,
      ricorrenza: { frequenza: "mensile", prossimaData: "2026-01-01", variabile: false },
      createdAt: new Date(),
    };
    const { insertedId } = await db.collection("transactions").insertOne(parent);

    await Promise.all([generaRicorrentiDovute(), generaRicorrentiDovute()]);

    const occurrenceKey = `${insertedId.toString()}:2026-01-01`;
    const children = await db.collection("transactions").find({ recurrenceOccurrenceKey: occurrenceKey }).toArray();
    expect(children).toHaveLength(1);
  });
});

describe("chiudiViaggiScaduti (MOD-008) — concurrent trip settlement", () => {
  it("two concurrent runs against the same overdue trip settle it exactly once", async () => {
    const db = getDb();
    const trip = {
      householdId: "hh-jobs-test",
      nome: "Viaggio Test",
      partecipanti: [{ id: "a", nome: "A" }, { id: "b", nome: "B" }],
      expenses: [{
        id: "e1", pagatoDa: "a", importo: 100, descrizione: "Cena", categoria: "cibo", data: "2026-01-01",
        splits: [{ personaId: "a", quota: 50 }, { personaId: "b", quota: 50 }],
      }],
      settled: false,
      settlementStatus: null,
      startDate: "2025-12-01",
      endDate: "2025-12-10", // well in the past relative to "today" in this test env
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const { insertedId } = await db.collection("trips").insertOne(trip);

    await Promise.all([chiudiViaggiScaduti(), chiudiViaggiScaduti()]);

    const settlementTxs = await db.collection("transactions").find({ categoria: "saldo_viaggio" }).toArray();
    expect(settlementTxs).toHaveLength(1); // not double-settled
    expect(settlementTxs[0].settlementKey).toBe(`${insertedId.toString()}:0`);

    const updatedTrip = await db.collection("trips").findOne({ _id: insertedId });
    expect(updatedTrip.settled).toBe(true);
    expect(updatedTrip.settlementStatus).toBe("settled");
  });
});
