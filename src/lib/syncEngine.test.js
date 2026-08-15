// Integration tests for the sync engine (MOD-015): exercises the real
// IndexedDB code path (via fake-indexeddb, an in-memory reimplementation —
// no browser needed) with a mocked fetch, covering the offline-sync
// scenarios called out in the modification plan: create/update/delete while
// offline, a server snapshot arriving while a local change is pending,
// retry after failure, and duplicate acks not creating duplicates.

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

async function freshModules() {
  vi.resetModules();
  globalThis.indexedDB = new IDBFactory(); // start each test with an empty database
  const syncEngine = await import("./syncEngine.js");
  const offlineDb = await import("./offlineDb.js");
  return { syncEngine, offlineDb };
}

function makeCtx({ householdId = "h1", apiBase = "https://api.test" } = {}) {
  return () => ({ householdId, apiBase, authHeaders: () => ({ "Content-Type": "application/json" }) });
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, clone() { return this; } };
}

describe("syncEngine — enqueueWrite", () => {
  let syncEngine, offlineDb, ctx;
  beforeEach(async () => {
    ({ syncEngine, offlineDb } = await freshModules());
    ctx = makeCtx();
    vi.restoreAllMocks();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("persists the operation to the outbox before returning, even offline", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    const result = await syncEngine.enqueueWrite(ctx, {
      entityType: "transactions", operation: "create", payload: { tipo: "uscita", importo: 10 },
    });
    expect(result.id).toMatch(/^local:/);
    const ops = await offlineDb.getOutboxOps("h1");
    expect(ops).toHaveLength(1);
    expect(ops[0].status).toBe("pending");
    const cached = await offlineDb.getAllEntities("transactions", "h1");
    expect(cached).toHaveLength(1);
  });

  it("resolves with the real server entity when online and the immediate send succeeds", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(201, { id: "real1", tipo: "uscita", importo: 10 })));
    const result = await syncEngine.enqueueWrite(ctx, {
      entityType: "transactions", operation: "create", payload: { tipo: "uscita", importo: 10 },
    });
    expect(result.id).toBe("real1");
    expect(await offlineDb.getOutboxOps("h1")).toHaveLength(0); // acknowledged — nothing left queued
  });

  it("throws immediately when the server synchronously rejects the write (validation), instead of pretending success", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(400, { error: { code: "SPLIT_TOTAL_NOT_100", message: "le quote non sommano a 100" } })));
    await expect(syncEngine.enqueueWrite(ctx, {
      entityType: "transactions", operation: "create", payload: { tipo: "uscita", importo: 10, splits: [{ personaId: "g", quota: 40 }] },
    })).rejects.toThrow(/le quote non sommano a 100/);
    // Still visible in the outbox afterward — nothing silently dropped.
    const ops = await offlineDb.getOutboxOps("h1");
    expect(ops).toHaveLength(1);
    expect(ops[0].status).toBe("failed");
  });

  it("does NOT throw when the immediate attempt fails for a transient/network reason — it just queues", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(503, { error: "unavailable" })));
    const result = await syncEngine.enqueueWrite(ctx, {
      entityType: "transactions", operation: "create", payload: { tipo: "uscita", importo: 10 },
    });
    expect(result.id).toMatch(/^local:/); // optimistic entity, no throw
    const ops = await offlineDb.getOutboxOps("h1");
    expect(ops[0].status).toBe("pending");
  });

  it("a transaction created while offline survives across a simulated reload (data persisted, not in memory)", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    await syncEngine.enqueueWrite(ctx, { entityType: "transactions", operation: "create", payload: { tipo: "uscita", importo: 5 } });

    // Simulate an app restart: fresh module graph, but the SAME underlying
    // fake IndexedDB instance (a real reload keeps the browser's IndexedDB).
    vi.resetModules();
    const offlineDb2 = await import("./offlineDb.js");
    const ops = await offlineDb2.getOutboxOps("h1");
    expect(ops).toHaveLength(1);
    expect(ops[0].payload.importo).toBe(5);
  });

  it("an offline edit is not lost: update queued while offline is still pending", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    await syncEngine.enqueueWrite(ctx, { entityType: "accounts", operation: "update", entityId: "acc1", payload: { nome: "Nuovo nome" } });
    const cached = await offlineDb.getAllEntities("accounts", "h1");
    expect(cached.find(a => a.id === "acc1").nome).toBe("Nuovo nome");
    expect(await offlineDb.getOutboxOps("h1")).toHaveLength(1);
  });

  it("a delete queued while offline removes the entity locally and queues the operation", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    await offlineDb.putEntity("goals", "h1", { id: "g1", nome: "Vacanza" });
    await syncEngine.enqueueWrite(ctx, { entityType: "goals", operation: "delete", entityId: "g1", payload: null });
    expect(await offlineDb.getAllEntities("goals", "h1")).toHaveLength(0);
    const ops = await offlineDb.getOutboxOps("h1");
    expect(ops).toHaveLength(1);
    expect(ops[0].operation).toBe("delete");
  });
});

describe("syncEngine — runSync", () => {
  let syncEngine, offlineDb, ctx;
  beforeEach(async () => {
    ({ syncEngine, offlineDb } = await freshModules());
    ctx = makeCtx();
    vi.restoreAllMocks();
    vi.stubGlobal("navigator", { onLine: true });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("retries after a transient failure and eventually succeeds, without duplicating", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls++;
      if (calls === 1) return jsonResponse(503, { error: "temporarily unavailable" });
      return jsonResponse(201, { id: "real1", tipo: "uscita", importo: 10 });
    }));
    vi.stubGlobal("navigator", { onLine: false }); // queue without the immediate-send attempt firing yet
    await syncEngine.enqueueWrite(ctx, { entityType: "transactions", operation: "create", payload: { tipo: "uscita", importo: 10 } });
    expect(calls).toBe(0);

    vi.stubGlobal("navigator", { onLine: true });
    await syncEngine.runSync(ctx); // attempt 1: fails (503) — stays pending with backoff
    expect(calls).toBe(1);
    let ops = await offlineDb.getOutboxOps("h1");
    expect(ops).toHaveLength(1);
    expect(ops[0].status).toBe("pending");
    expect(ops[0].attempts).toBe(1);
    expect(ops[0].nextAttemptAt).toBeGreaterThan(Date.now()); // backing off — a sync right now must not hit the network again

    await syncEngine.runSync(ctx); // still backing off: no new attempt
    expect(calls).toBe(1);

    // Fast-forward past the backoff window and retry.
    ops = await offlineDb.getOutboxOps("h1");
    await offlineDb.putOutboxOp({ ...ops[0], nextAttemptAt: 0 });
    await syncEngine.runSync(ctx); // attempt 2: succeeds
    expect(calls).toBe(2);
    expect(await offlineDb.getOutboxOps("h1")).toHaveLength(0);
    const cached = await offlineDb.getAllEntities("transactions", "h1");
    expect(cached).toHaveLength(1);
    expect(cached[0].id).toBe("real1");
  });

  it("stops auto-retrying a validation rejection (400) but keeps it visible as failed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(400, { error: { code: "INVALID_AMOUNT", message: "bad amount" } })));
    vi.stubGlobal("navigator", { onLine: false });
    await syncEngine.enqueueWrite(ctx, { entityType: "transactions", operation: "create", payload: { tipo: "uscita", importo: -1 } });
    vi.stubGlobal("navigator", { onLine: true });
    await syncEngine.runSync(ctx);
    const ops = await offlineDb.getOutboxOps("h1");
    expect(ops).toHaveLength(1);
    expect(ops[0].status).toBe("failed");
    expect(ops[0].lastError).toMatch(/bad amount/);

    // A further sync pass must not call fetch again for a "failed" op.
    const fetchMock = fetch;
    await syncEngine.runSync(ctx);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("promotes a temp id and resolves a dependent operation's foreign key in the same sync pass", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    const account = await syncEngine.enqueueWrite(ctx, { entityType: "accounts", operation: "create", payload: { nome: "Conto nuovo" } });
    expect(account.id).toMatch(/^local:/);
    await syncEngine.enqueueWrite(ctx, {
      entityType: "transactions", operation: "create", payload: { tipo: "uscita", importo: 20, contoId: account.id },
    });

    let accountCreateSeen = false;
    vi.stubGlobal("fetch", vi.fn(async (url, opts) => {
      if (url.includes("/api/accounts")) { accountCreateSeen = true; return jsonResponse(201, { id: "acc-real", nome: "Conto nuovo" }); }
      if (url.includes("/api/transactions")) {
        const body = JSON.parse(opts.body);
        expect(accountCreateSeen).toBe(true); // must not have been sent before its dependency resolved
        expect(body.contoId).toBe("acc-real"); // rewritten from the temp id
        return jsonResponse(201, { id: "tx-real", tipo: "uscita", importo: 20, contoId: "acc-real" });
      }
      throw new Error(`unexpected fetch ${url}`);
    }));
    vi.stubGlobal("navigator", { onLine: true });
    await syncEngine.runSync(ctx);

    expect(await offlineDb.getOutboxOps("h1")).toHaveLength(0);
    const txs = await offlineDb.getAllEntities("transactions", "h1");
    expect(txs[0].contoId).toBe("acc-real");
  });

  it("treats a 404 on a delete retry as success (already gone) instead of failing forever", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    await offlineDb.putEntity("goals", "h1", { id: "g1", nome: "X" });
    await syncEngine.enqueueWrite(ctx, { entityType: "goals", operation: "delete", entityId: "g1", payload: null });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(404, { error: "not found" })));
    vi.stubGlobal("navigator", { onLine: true });
    await syncEngine.runSync(ctx);
    expect(await offlineDb.getOutboxOps("h1")).toHaveLength(0);
  });
});

describe("syncEngine — fetchAndMergeSnapshot (server refresh never clobbers pending local changes)", () => {
  let syncEngine, offlineDb, ctx;
  beforeEach(async () => {
    ({ syncEngine, offlineDb } = await freshModules());
    ctx = makeCtx();
    vi.restoreAllMocks();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("keeps a pending local edit instead of the incoming server value", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    await offlineDb.putEntity("accounts", "h1", { id: "acc1", nome: "Vecchio nome" });
    await syncEngine.enqueueWrite(ctx, { entityType: "accounts", operation: "update", entityId: "acc1", payload: { nome: "Nome locale" } });

    const merged = await syncEngine.fetchAndMergeSnapshot(ctx, "accounts", [{ id: "acc1", nome: "Nome dal server (più vecchio)" }]);
    expect(merged.find(a => a.id === "acc1").nome).toBe("Nome locale");

    const cached = await offlineDb.getAllEntities("accounts", "h1");
    expect(cached.find(a => a.id === "acc1").nome).toBe("Nome locale");
  });

  it("hides an entity with a pending delete from the merged snapshot", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    await offlineDb.putEntity("goals", "h1", { id: "g1", nome: "X" });
    await syncEngine.enqueueWrite(ctx, { entityType: "goals", operation: "delete", entityId: "g1", payload: null });

    const merged = await syncEngine.fetchAndMergeSnapshot(ctx, "goals", [{ id: "g1", nome: "X" }]);
    expect(merged).toHaveLength(0);
  });

  it("keeps a not-yet-acknowledged local create visible alongside the server snapshot", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    const created = await syncEngine.enqueueWrite(ctx, { entityType: "goals", operation: "create", payload: { nome: "Nuovo obiettivo" } });
    const merged = await syncEngine.fetchAndMergeSnapshot(ctx, "goals", [{ id: "g-other", nome: "Esistente" }]);
    expect(merged.map(g => g.id).sort()).toEqual(["g-other", created.id].sort());
  });

  it("takes the server version for entities with nothing pending", async () => {
    const merged = await syncEngine.fetchAndMergeSnapshot(ctx, "accounts", [{ id: "acc1", nome: "Server" }]);
    expect(merged).toEqual([{ id: "acc1", nome: "Server" }]);
  });
});

describe("syncEngine — idempotent retries never duplicate", () => {
  let syncEngine, offlineDb, ctx;
  beforeEach(async () => {
    ({ syncEngine, offlineDb } = await freshModules());
    ctx = makeCtx();
    vi.restoreAllMocks();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("sends the same Idempotency-Key on every retry of the same create", async () => {
    const seenKeys = [];
    let attempt = 0;
    vi.stubGlobal("fetch", vi.fn(async (url, opts) => {
      seenKeys.push(opts.headers["Idempotency-Key"]);
      attempt++;
      if (attempt === 1) return jsonResponse(500, { error: "boom" });
      return jsonResponse(201, { id: "real1" });
    }));
    vi.stubGlobal("navigator", { onLine: false });
    await syncEngine.enqueueWrite(ctx, { entityType: "transactions", operation: "create", payload: { tipo: "uscita", importo: 1 } });
    vi.stubGlobal("navigator", { onLine: true });
    await syncEngine.runSync(ctx);
    let ops = await offlineDb.getOutboxOps("h1");
    await offlineDb.putOutboxOp({ ...ops[0], nextAttemptAt: 0 });
    await syncEngine.runSync(ctx);

    expect(seenKeys).toHaveLength(2);
    expect(seenKeys[0]).toBe(seenKeys[1]);
    expect(seenKeys[0]).toBeTruthy();
  });
});
