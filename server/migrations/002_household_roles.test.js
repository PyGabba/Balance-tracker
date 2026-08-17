import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient } from "mongodb";
import migration from "./002_household_roles.js";

let mongod, client, db;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db("migration_002_test");
});

afterAll(async () => {
  await client?.close();
  await mongod?.stop();
});

beforeEach(async () => {
  const collections = await db.listCollections().toArray();
  await Promise.all(collections.map(c => db.collection(c.name).deleteMany({})));
});

describe("002_household_roles", () => {
  it("assigns owner to the first persona and member to the rest", async () => {
    const { insertedId } = await db.collection("households").insertOne({
      householdId: "h1",
      persone: [{ id: "p1", nome: "Gabriele" }, { id: "p2", nome: "Laura" }],
    });
    await migration.up(db, { dryRun: false, log: () => {} });
    const household = await db.collection("households").findOne({ _id: insertedId });
    expect(household.persone[0].ruolo).toBe("owner");
    expect(household.persone[1].ruolo).toBe("member");
  });

  it("never overwrites a ruolo that's already set", async () => {
    const { insertedId } = await db.collection("households").insertOne({
      householdId: "h1",
      persone: [{ id: "p1", nome: "Gabriele", ruolo: "guest" }, { id: "p2", nome: "Laura" }],
    });
    await migration.up(db, { dryRun: false, log: () => {} });
    const household = await db.collection("households").findOne({ _id: insertedId });
    expect(household.persone[0].ruolo).toBe("guest"); // untouched, even though it's "first persona"
    expect(household.persone[1].ruolo).toBe("member");
  });

  it("leaves every other field on each persona untouched", async () => {
    const { insertedId } = await db.collection("households").insertOne({
      householdId: "h1",
      persone: [{ id: "p1", nome: "Gabriele", emoji: "🧑", colore: "#fff" }],
    });
    await migration.up(db, { dryRun: false, log: () => {} });
    const household = await db.collection("households").findOne({ _id: insertedId });
    expect(household.persone[0]).toEqual({ id: "p1", nome: "Gabriele", emoji: "🧑", colore: "#fff", ruolo: "owner" });
  });

  it("skips a household whose persone already all have a ruolo", async () => {
    await db.collection("households").insertOne({
      householdId: "h1",
      persone: [{ id: "p1", nome: "Gabriele", ruolo: "owner" }],
    });
    const { docsAffected } = await migration.up(db, { dryRun: false, log: () => {} });
    expect(docsAffected).toBe(0);
  });

  it("dry run reports the count but writes nothing", async () => {
    await db.collection("households").insertOne({ householdId: "h1", persone: [{ id: "p1", nome: "Gabriele" }] });
    const { docsAffected } = await migration.up(db, { dryRun: true, log: () => {} });
    expect(docsAffected).toBe(1);
    const household = await db.collection("households").findOne({ householdId: "h1" });
    expect(household.persone[0].ruolo).toBeUndefined();
  });

  it("is idempotent", async () => {
    await db.collection("households").insertOne({ householdId: "h1", persone: [{ id: "p1", nome: "Gabriele" }, { id: "p2", nome: "Laura" }] });
    await migration.up(db, { dryRun: false, log: () => {} });
    const { docsAffected } = await migration.up(db, { dryRun: false, log: () => {} });
    expect(docsAffected).toBe(0);
  });
});
