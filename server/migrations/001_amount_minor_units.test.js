import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient } from "mongodb";
import migration from "./001_amount_minor_units.js";
import { runMigrations, getAppliedMigrations } from "./runner.js";

let mongod, client, db;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db("migration_001_test");
});

afterAll(async () => {
  await client?.close();
  await mongod?.stop();
});

beforeEach(async () => {
  const collections = await db.listCollections().toArray();
  await Promise.all(collections.map(c => db.collection(c.name).deleteMany({})));
});

describe("001_amount_minor_units", () => {
  it("adds importoMinorUnits to transactions without touching importo", async () => {
    const { insertedId } = await db.collection("transactions").insertOne({ importo: 12.34, tipo: "uscita" });
    await migration.up(db, { dryRun: false, log: () => {} });
    const doc = await db.collection("transactions").findOne({ _id: insertedId });
    expect(doc.importo).toBe(12.34); // untouched
    expect(doc.importoMinorUnits).toBe(1234);
  });

  it("also migrates importoOriginale when present", async () => {
    const { insertedId } = await db.collection("transactions").insertOne({ importo: 10, importoOriginale: 9.99, tipo: "uscita" });
    await migration.up(db, { dryRun: false, log: () => {} });
    const doc = await db.collection("transactions").findOne({ _id: insertedId });
    expect(doc.importoMinorUnits).toBe(1000);
    expect(doc.importoOriginaleMinorUnits).toBe(999);
  });

  it("migrates accounts, goals, and positions", async () => {
    const { insertedId: accId } = await db.collection("accounts").insertOne({ nome: "Conto", saldoIniziale: 100.5 });
    const { insertedId: goalId } = await db.collection("goals").insertOne({ nome: "Fondo", targetAmount: 500, currentAmount: 123.45 });
    const { insertedId: posId } = await db.collection("positions").insertOne({ ticker: "AAPL", prezzoAcquisto: 150.25 });

    await migration.up(db, { dryRun: false, log: () => {} });

    const acc = await db.collection("accounts").findOne({ _id: accId });
    expect(acc.saldoInizialeMinorUnits).toBe(10050);
    const goal = await db.collection("goals").findOne({ _id: goalId });
    expect(goal.targetAmountMinorUnits).toBe(50000);
    expect(goal.currentAmountMinorUnits).toBe(12345);
    const pos = await db.collection("positions").findOne({ _id: posId });
    expect(pos.prezzoAcquistoMinorUnits).toBe(15025);
  });

  it("migrates each trip expense's importo without touching the rest of the array element", async () => {
    const { insertedId } = await db.collection("trips").insertOne({
      nome: "Viaggio",
      expenses: [
        { id: "e1", pagatoDa: "p1", importo: 42.5, descrizione: "cena" },
        { id: "e2", pagatoDa: "p2", importo: 10, descrizione: "taxi" },
      ],
    });
    await migration.up(db, { dryRun: false, log: () => {} });
    const trip = await db.collection("trips").findOne({ _id: insertedId });
    expect(trip.expenses[0]).toMatchObject({ id: "e1", descrizione: "cena", importo: 42.5, importoMinorUnits: 4250 });
    expect(trip.expenses[1]).toMatchObject({ id: "e2", descrizione: "taxi", importo: 10, importoMinorUnits: 1000 });
  });

  it("dry run reports the count but writes nothing", async () => {
    await db.collection("transactions").insertOne({ importo: 5, tipo: "uscita" });
    const { docsAffected } = await migration.up(db, { dryRun: true, log: () => {} });
    expect(docsAffected).toBe(1);
    const doc = await db.collection("transactions").findOne({});
    expect(doc.importoMinorUnits).toBeUndefined();
  });

  it("is idempotent — running twice doesn't re-touch already-migrated docs", async () => {
    const { insertedId } = await db.collection("transactions").insertOne({ importo: 7, tipo: "uscita" });
    await migration.up(db, { dryRun: false, log: () => {} });
    const { docsAffected: second } = await migration.up(db, { dryRun: false, log: () => {} });
    expect(second).toBe(0);
    const doc = await db.collection("transactions").findOne({ _id: insertedId });
    expect(doc.importoMinorUnits).toBe(700);
  });

  it("skips a document that already has the minor-units field set", async () => {
    await db.collection("transactions").insertOne({ importo: 7, importoMinorUnits: 999, tipo: "uscita" });
    const { docsAffected } = await migration.up(db, { dryRun: false, log: () => {} });
    expect(docsAffected).toBe(0);
  });

  it("runs cleanly through the runner and is recorded as applied", async () => {
    await db.collection("transactions").insertOne({ importo: 3.33, tipo: "uscita" });
    const results = await runMigrations(db, [migration], { log: () => {} });
    expect(results[0].status).toBe("applied");
    expect(results[0].docsAffected).toBe(1);
    const applied = await getAppliedMigrations(db);
    expect(applied[0].id).toBe("001");
  });
});
