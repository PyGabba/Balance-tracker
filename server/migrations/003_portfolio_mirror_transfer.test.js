import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient } from "mongodb";
import migration from "./003_portfolio_mirror_transfer.js";

let mongod, client, db;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db("migration_003_test");
});

afterAll(async () => {
  await client?.close();
  await mongod?.stop();
});

beforeEach(async () => {
  const collections = await db.listCollections().toArray();
  await Promise.all(collections.map(c => db.collection(c.name).deleteMany({})));
});

describe("003_portfolio_mirror_transfer", () => {
  it("turns a buy mirror (uscita) into a single-sided transfer out of the account", async () => {
    const { insertedId } = await db.collection("transactions").insertOne({
      tipo: "uscita", categoria: "investimenti", contoId: "acc1", positionId: "pos1", importo: 100,
    });
    await migration.up(db, { dryRun: false, log: () => {} });
    const t = await db.collection("transactions").findOne({ _id: insertedId });
    expect(t.tipo).toBe("trasferimento");
    expect(t.contoDa).toBe("acc1");
    expect(t.contoA).toBe(null);
    expect(t.contoId).toBeUndefined();
    expect(t.categoria).toBeUndefined();
    expect(t.positionId).toBe("pos1");
  });

  it("turns a sell mirror (entrata) into a transfer into the account", async () => {
    const { insertedId } = await db.collection("transactions").insertOne({
      tipo: "entrata", categoria: "investimenti", contoId: "acc1", positionId: "pos2", importo: 50,
    });
    await migration.up(db, { dryRun: false, log: () => {} });
    const t = await db.collection("transactions").findOne({ _id: insertedId });
    expect(t.tipo).toBe("trasferimento");
    expect(t.contoDa).toBe(null);
    expect(t.contoA).toBe("acc1");
  });

  it("leaves ordinary expenses and incomes alone", async () => {
    await db.collection("transactions").insertMany([
      { tipo: "uscita", categoria: "cibo", contoId: "acc1", importo: 20 },
      { tipo: "entrata", categoria: "entrata", contoId: "acc1", importo: 2000 },
      { tipo: "trasferimento", contoDa: "acc1", contoA: "acc2", importo: 30 },
    ]);
    const { docsAffected } = await migration.up(db, { dryRun: false, log: () => {} });
    expect(docsAffected).toBe(0);
    const cibo = await db.collection("transactions").findOne({ categoria: "cibo" });
    expect(cibo.tipo).toBe("uscita");
    expect(cibo.contoId).toBe("acc1");
  });

  it("dry run reports the count but writes nothing", async () => {
    await db.collection("transactions").insertOne({ tipo: "uscita", contoId: "acc1", positionId: "pos1", importo: 100 });
    const { docsAffected } = await migration.up(db, { dryRun: true, log: () => {} });
    expect(docsAffected).toBe(1);
    const t = await db.collection("transactions").findOne({ positionId: "pos1" });
    expect(t.tipo).toBe("uscita");
    expect(t.contoId).toBe("acc1");
  });

  it("is idempotent", async () => {
    await db.collection("transactions").insertOne({ tipo: "uscita", contoId: "acc1", positionId: "pos1", importo: 100 });
    await migration.up(db, { dryRun: false, log: () => {} });
    const { docsAffected } = await migration.up(db, { dryRun: false, log: () => {} });
    expect(docsAffected).toBe(0);
  });
});
