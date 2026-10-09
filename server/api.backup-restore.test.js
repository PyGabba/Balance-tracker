import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import request from "supertest";
import { Collection } from "mongodb";
import { startTestServer, stopTestServer, getDb } from "./testUtils.js";

// Regression: POST /api/backup/restore used to insert accounts, goals,
// trips, positions, manual prices and transactions in five separate
// unguarded loops. A failure partway through (bad data, a dropped
// connection, a crash) left the household with a half-restored backup —
// some collections populated, others not — with no way to tell from the
// response, which itself never arrived (the request just 500'd). It's now
// one Mongo transaction (withTransaction, server/index.js) so either every
// collection ends up restored or none of them do.
//
// Failure is injected by monkey-patching the shared mongodb driver
// Collection.prototype for one specific collection name, same technique as
// api.transactional-deletes.test.js — the app code under test is completely
// unaware, so this proves the transaction boundary itself.

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

function sampleBackup() {
  return {
    formato: "balance-tracker-backup",
    versione: 1,
    creato: new Date().toISOString(),
    household: { nome: "Restored", persone: [], categorieUscita: null },
    accounts: [{ id: "old-acc-1", nome: "Conto Ripristinato", icona: "🏦", saldoIniziale: 100 }],
    goals: [],
    trips: [],
    positions: [],
    transactions: [{ id: "old-tx-1", tipo: "uscita", importo: 42, data: "2026-08-01", descrizione: "Spesa ripristinata" }],
    manualPrices: {},
  };
}

describe("POST /api/backup/restore happy path", () => {
  it("restores accounts and transactions, remapping the account id", async () => {
    const agent = request.agent(app);
    const reg = await agent.post("/api/auth/register")
      .send({ nome: "Backup Restore Household", persone: ["Gabriele"], pin: "204857" });
    expect(reg.status).toBe(201);

    const res = await agent.post("/api/backup/restore").send(sampleBackup());
    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({ transactions: 1, accounts: 1, goals: 0, trips: 0, positions: 0, manualPrices: 0, portfolioSnapshots: 0 });

    const accRes = await agent.get("/api/accounts");
    expect(accRes.status).toBe(200);
    expect(accRes.body.length).toBe(1);
    expect(accRes.body[0].nome).toBe("Conto Ripristinato");

    const txRes = await agent.get("/api/transactions");
    expect(txRes.status).toBe(200);
    expect(txRes.body.transactions.length).toBe(1);
    expect(txRes.body.transactions[0].importo).toBe(42);
  });
});

describe("POST /api/backup/restore is atomic", () => {
  it("a failure restoring transactions (the last collection) rolls back the earlier account insert too", async () => {
    const agent = request.agent(app);
    const reg = await agent.post("/api/auth/register")
      .send({ nome: "Atomic Restore Household", persone: ["Gabriele"], pin: "739462" });
    expect(reg.status).toBe(201);
    const householdId = reg.body.householdId;

    failOnceForCollection("insertOne", "transactions");

    const res = await agent.post("/api/backup/restore").send(sampleBackup());
    expect(res.status).toBe(500);

    const db = getDb();
    // The account was inserted successfully BEFORE the injected failure —
    // it must not survive the rollback.
    const accountCount = await db.collection("accounts").countDocuments({ householdId });
    expect(accountCount).toBe(0);
    const txCount = await db.collection("transactions").countDocuments({ householdId });
    expect(txCount).toBe(0);
    // No partial audit log entry either.
    const auditCount = await db.collection("audit_log").countDocuments({ householdId, action: "backup_restore" });
    expect(auditCount).toBe(0);
  });

  it("a failure on the audit log write rolls back every collection restored before it", async () => {
    const agent = request.agent(app);
    const reg = await agent.post("/api/auth/register")
      .send({ nome: "Atomic Restore Audit Household", persone: ["Gabriele"], pin: "159384" });
    expect(reg.status).toBe(201);
    const householdId = reg.body.householdId;

    failOnceForCollection("insertOne", "audit_log");

    const res = await agent.post("/api/backup/restore").send(sampleBackup());
    expect(res.status).toBe(500);

    const db = getDb();
    const accountCount = await db.collection("accounts").countDocuments({ householdId });
    expect(accountCount).toBe(0);
    const txCount = await db.collection("transactions").countDocuments({ householdId });
    expect(txCount).toBe(0);
  });
});
