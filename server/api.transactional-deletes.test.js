import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import request from "supertest";
import { Collection } from "mongodb";
import { startTestServer, stopTestServer, getDb } from "./testUtils.js";

// Regression: household deletion, account-reference detachment, and manual
// price replacement each touch multiple collections/documents as one
// logical operation. Before withTransaction (server/index.js), a crash or
// DB error partway through left the database in neither the old nor the
// new state (e.g. a household's transactions deleted but the household
// document itself still present). These tests force a failure on the LAST
// write of each sequence and verify EVERYTHING rolled back — not just that
// the failing write didn't happen.
//
// Failure is injected by monkey-patching the shared mongodb driver
// Collection.prototype for one specific collection name, so the app code
// under test is completely unaware — this proves the transaction boundary
// itself, not a code path built specifically to be testable.

let app;

beforeAll(async () => {
  app = await startTestServer();
}, 60000);

afterAll(async () => {
  await stopTestServer();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function failOnceForCollection(methodName, targetCollectionName) {
  const original = Collection.prototype[methodName];
  vi.spyOn(Collection.prototype, methodName).mockImplementation(function (...args) {
    if (this.collectionName === targetCollectionName) return Promise.reject(new Error("injected failure"));
    return original.apply(this, args);
  });
}

describe("household deletion is atomic", () => {
  it("a failure on the final delete (the household doc itself) rolls back everything already deleted in the transaction", async () => {
    const agent = request.agent(app);
    const reg = await agent.post("/api/auth/register")
      .send({ nome: "Atomic Delete Household", persone: ["Gabriele"], pin: "914728" });
    expect(reg.status).toBe(201);
    const householdId = reg.body.householdId;

    const tx = await agent.post("/api/transactions").send({ tipo: "uscita", importo: 10, data: "2026-08-01" });
    expect(tx.status).toBe(201);

    failOnceForCollection("deleteOne", "households");

    const del = await agent.delete("/api/auth/household").send({ pin: "914728" });
    expect(del.status).toBe(500);

    // Everything must still be there — including the transaction deleted
    // EARLIER in the same sequence, before the injected failure.
    const db = getDb();
    const household = await db.collection("households").findOne({ householdId });
    expect(household).toBeTruthy();
    const txCount = await db.collection("transactions").countDocuments({ householdId });
    expect(txCount).toBe(1);
  });
});

describe("account deletion + reference detachment is atomic", () => {
  it("a failure detaching goals rolls back the account delete and the transaction detachments too", async () => {
    const agent = request.agent(app);
    const reg = await agent.post("/api/auth/register")
      .send({ nome: "Atomic Account Household", persone: ["Gabriele"], pin: "627193" });
    expect(reg.status).toBe(201);

    const acc = await agent.post("/api/accounts").send({ nome: "Conto" });
    expect(acc.status).toBe(201);
    const accountId = acc.body.id;

    const tx = await agent.post("/api/transactions").send({ tipo: "uscita", importo: 5, data: "2026-08-01", contoId: accountId });
    expect(tx.status).toBe(201);
    const goal = await agent.post("/api/goals").send({ nome: "Meta", targetAmount: 100, contoId: accountId });
    expect(goal.status).toBe(201);

    failOnceForCollection("updateMany", "goals");

    const del = await agent.delete(`/api/accounts/${accountId}`);
    expect(del.status).toBe(500);

    const db = getDb();
    // The account itself must still exist — not deleted while its
    // reference-detachment (which failed) never completed.
    const { ObjectId } = await import("mongodb");
    const accountDoc = await db.collection("accounts").findOne({ _id: new ObjectId(accountId) });
    expect(accountDoc).toBeTruthy();
    // The transaction's contoId must NOT have been detached either — that
    // write happened earlier in the same transaction as the failed one.
    const txDoc = await db.collection("transactions").findOne({ _id: new ObjectId(tx.body.id) });
    expect(txDoc.contoId).toBe(accountId);
  });
});

describe("manual price replacement is atomic", () => {
  it("a failure partway through the upserts rolls back the earlier delete of existing prices", async () => {
    const agent = request.agent(app);
    const reg = await agent.post("/api/auth/register")
      .send({ nome: "Atomic Prices Household", persone: ["Gabriele"], pin: "385291" });
    expect(reg.status).toBe(201);
    const householdId = reg.body.householdId;

    const first = await agent.put("/api/positions/prices").send({ manualPrices: { AAPL: 150 } });
    expect(first.status).toBe(200);

    failOnceForCollection("updateOne", "quotes_cache");

    const second = await agent.put("/api/positions/prices").send({ manualPrices: { MSFT: 300 } });
    expect(second.status).toBe(500);

    // The old price must still be there — not wiped out by the delete that
    // ran before the failed upsert, in the same rolled-back transaction.
    const db = getDb();
    const doc = await db.collection("quotes_cache").findOne({ householdId, ticker: "AAPL" });
    expect(doc).toBeTruthy();
    expect(doc.manualPrice).toBe(150);
  });
});
