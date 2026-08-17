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

  it("a partial batch failure doesn't block a sibling operation from syncing in the same pass", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    await syncEngine.enqueueWrite(ctx, { entityType: "transactions", operation: "create", payload: { tipo: "uscita", importo: 10 } });
    await syncEngine.enqueueWrite(ctx, { entityType: "goals", operation: "create", payload: { nome: "Vacanza", targetAmount: -5 } }); // will be rejected

    vi.stubGlobal("fetch", vi.fn(async (url) => {
      if (url.includes("/api/transactions")) return jsonResponse(201, { id: "tx-real", tipo: "uscita", importo: 10 });
      if (url.includes("/api/goals")) return jsonResponse(400, { error: { code: "INVALID_FIELD", message: "targetAmount deve essere positivo" } });
      throw new Error(`unexpected fetch ${url}`);
    }));
    vi.stubGlobal("navigator", { onLine: true });
    await syncEngine.runSync(ctx);

    const ops = await offlineDb.getOutboxOps("h1");
    expect(ops).toHaveLength(1); // the transaction synced and left the outbox; only the rejected goal remains
    expect(ops[0].entityType).toBe("goals");
    expect(ops[0].status).toBe("failed");

    const txs = await offlineDb.getAllEntities("transactions", "h1");
    expect(txs[0].id).toBe("tx-real"); // promoted to the real server id despite its sibling op failing
  });

  it("an operation queued offline, surviving a simulated browser restart, still syncs successfully once reconnected", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    await syncEngine.enqueueWrite(ctx, { entityType: "accounts", operation: "create", payload: { nome: "Conto vacanze" } });

    // Simulate the app being fully closed and reopened: fresh module graph,
    // same underlying fake IndexedDB (a real reload keeps the browser's).
    vi.resetModules();
    const syncEngine2 = await import("./syncEngine.js");
    const offlineDb2 = await import("./offlineDb.js");

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(201, { id: "acc-real", nome: "Conto vacanze" })));
    vi.stubGlobal("navigator", { onLine: true });
    await syncEngine2.runSync(ctx);

    expect(await offlineDb2.getOutboxOps("h1")).toHaveLength(0);
    const accounts = await offlineDb2.getAllEntities("accounts", "h1");
    expect(accounts[0].id).toBe("acc-real");
  });
});

// Two browser sessions ("devices") sharing one household but never talking
// to each other directly — each only sees the server through its own sync
// pass. This is the same "pending local change always wins over an
// incoming server value" rule already proven for a single device
// (fetchAndMergeSnapshot tests above), but exercised across two entirely
// separate IndexedDB instances to confirm the resolution is actually
// deterministic end-to-end: whichever device's sync reaches the server
// LAST determines the final value, not whichever edited first — there is
// no field-level merge, no "most recent timestamp wins" logic, just
// "local pending beats server snapshot, until it's synced and there's no
// longer anything pending."
describe("syncEngine — two devices editing the same entity", () => {
  it("device B's pending edit overrides device A's already-synced value, and syncing device B updates the server accordingly", async () => {
    let serverAccount = { id: "acc1", nome: "Nome originale" };

    // Device A: makes an offline edit, then syncs it to the server.
    {
      globalThis.indexedDB = new IDBFactory();
      vi.resetModules();
      const syncEngineA = await import("./syncEngine.js");
      const offlineDbA = await import("./offlineDb.js");
      const ctxA = makeCtx();

      vi.stubGlobal("navigator", { onLine: false });
      await offlineDbA.putEntity("accounts", "h1", serverAccount);
      await syncEngineA.enqueueWrite(ctxA, { entityType: "accounts", operation: "update", entityId: "acc1", payload: { nome: "Da Device A" } });

      vi.stubGlobal("fetch", vi.fn(async (url, opts) => {
        serverAccount = { ...serverAccount, ...JSON.parse(opts.body) };
        return jsonResponse(200, serverAccount);
      }));
      vi.stubGlobal("navigator", { onLine: true });
      await syncEngineA.runSync(ctxA);
      expect(serverAccount.nome).toBe("Da Device A");
    }

    // Device B: independent IndexedDB, still holding its own stale local
    // copy plus its own pending edit made before it ever saw Device A's
    // change (i.e. genuinely concurrent, not "B saw A's edit and reverted it").
    globalThis.indexedDB = new IDBFactory();
    vi.resetModules();
    const syncEngineB = await import("./syncEngine.js");
    const offlineDbB = await import("./offlineDb.js");
    const ctxB = makeCtx();

    vi.stubGlobal("navigator", { onLine: false });
    await offlineDbB.putEntity("accounts", "h1", { id: "acc1", nome: "Nome originale" });
    await syncEngineB.enqueueWrite(ctxB, { entityType: "accounts", operation: "update", entityId: "acc1", payload: { nome: "Da Device B" } });

    // Device B refreshes and sees Device A's already-synced server value —
    // its own pending edit still wins locally (same rule as a single device).
    const beforeStatus = await syncEngineB.getSyncStatus("h1");
    const merged = await syncEngineB.fetchAndMergeSnapshot(ctxB, "accounts", [serverAccount]);
    expect(merged.find(a => a.id === "acc1").nome).toBe("Da Device B");
    const afterStatus = await syncEngineB.getSyncStatus("h1");
    expect(afterStatus.syncConflictsObserved).toBe(beforeStatus.syncConflictsObserved + 1); // a genuine two-writer conflict, and it's counted

    // Device B finally syncs — its edit, being the one that reaches the
    // server last, wins overall. Deterministic: re-running this exact
    // sequence always ends with "Da Device B" server-side, never a merge
    // of both edits and never a race-dependent outcome.
    vi.stubGlobal("fetch", vi.fn(async (url, opts) => {
      serverAccount = { ...serverAccount, ...JSON.parse(opts.body) };
      return jsonResponse(200, serverAccount);
    }));
    vi.stubGlobal("navigator", { onLine: true });
    await syncEngineB.runSync(ctxB);
    expect(serverAccount.nome).toBe("Da Device B");
    expect(await offlineDbB.getOutboxOps("h1")).toHaveLength(0);
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

describe("syncEngine — enqueueTripExpenseWrite (trip-expense outbox gap closed)", () => {
  let syncEngine, offlineDb, ctx;
  beforeEach(async () => {
    ({ syncEngine, offlineDb } = await freshModules());
    ctx = makeCtx();
    vi.restoreAllMocks();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("persists a durable outbox operation for an expense added while offline (the original gap)", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    await offlineDb.putEntity("trips", "h1", { id: "trip1", nome: "Roma", expenses: [] });
    const result = await syncEngine.enqueueTripExpenseWrite(ctx, {
      operation: "create", tripId: "trip1", payload: { pagatoDa: "g", importo: 20 },
    });
    expect(result.id).toMatch(/^local:/);

    const ops = await offlineDb.getOutboxOps("h1");
    expect(ops).toHaveLength(1);
    expect(ops[0].entityType).toBe("tripExpenses");
    expect(ops[0].payload.tripId).toBe("trip1"); // present even though this is (effectively) the create case

    const trips = await offlineDb.getAllEntities("trips", "h1");
    expect(trips[0].expenses).toHaveLength(1);
  });

  it("survives a simulated browser restart (durable, not just an in-memory cache write)", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    await offlineDb.putEntity("trips", "h1", { id: "trip1", nome: "Roma", expenses: [] });
    await syncEngine.enqueueTripExpenseWrite(ctx, { operation: "create", tripId: "trip1", payload: { pagatoDa: "g", importo: 5 } });

    vi.resetModules();
    const offlineDb2 = await import("./offlineDb.js");
    const ops = await offlineDb2.getOutboxOps("h1");
    expect(ops).toHaveLength(1);
    expect(ops[0].payload.importo).toBe(5);
  });

  it("resolves with the real server expense when online and the immediate send succeeds", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    await offlineDb.putEntity("trips", "h1", { id: "trip1", nome: "Roma", expenses: [] });
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      expect(url).toBe("https://api.test/api/trips/trip1/expenses");
      return jsonResponse(201, { id: "real-exp-1", pagatoDa: "g", importo: 20 });
    }));
    const result = await syncEngine.enqueueTripExpenseWrite(ctx, {
      operation: "create", tripId: "trip1", payload: { pagatoDa: "g", importo: 20 },
    });
    expect(result.id).toBe("real-exp-1");
    expect(await offlineDb.getOutboxOps("h1")).toHaveLength(0);
    const trips = await offlineDb.getAllEntities("trips", "h1");
    expect(trips[0].expenses).toEqual([{ id: "real-exp-1", pagatoDa: "g", importo: 20 }]);
  });

  it("does not send tripId in the request body — only in the URL", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    await offlineDb.putEntity("trips", "h1", { id: "trip1", expenses: [] });
    vi.stubGlobal("fetch", vi.fn(async (url, opts) => {
      const body = JSON.parse(opts.body);
      expect(body.tripId).toBeUndefined();
      expect(body.pagatoDa).toBe("g");
      return jsonResponse(201, { id: "real1", pagatoDa: "g", importo: 1 });
    }));
    await syncEngine.enqueueTripExpenseWrite(ctx, { operation: "create", tripId: "trip1", payload: { pagatoDa: "g", importo: 1 } });
  });

  it("a delete queued while offline removes the expense locally and queues the operation", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    await offlineDb.putEntity("trips", "h1", { id: "trip1", expenses: [{ id: "exp1", pagatoDa: "g", importo: 5 }] });
    await syncEngine.enqueueTripExpenseWrite(ctx, { operation: "delete", tripId: "trip1", expenseId: "exp1", payload: null });

    const trips = await offlineDb.getAllEntities("trips", "h1");
    expect(trips[0].expenses).toHaveLength(0);
    const ops = await offlineDb.getOutboxOps("h1");
    expect(ops).toHaveLength(1);
    expect(ops[0].operation).toBe("delete");
    expect(ops[0].payload.tripId).toBe("trip1"); // needed to build the DELETE URL later
  });

  it("cancels a create+delete pair for the same offline-created expense that never reached the server", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    await offlineDb.putEntity("trips", "h1", { id: "trip1", expenses: [] });
    const created = await syncEngine.enqueueTripExpenseWrite(ctx, { operation: "create", tripId: "trip1", payload: { pagatoDa: "g", importo: 5 } });
    await syncEngine.enqueueTripExpenseWrite(ctx, { operation: "delete", tripId: "trip1", expenseId: created.id, payload: null });
    expect(await offlineDb.getOutboxOps("h1")).toHaveLength(0);
    const trips = await offlineDb.getAllEntities("trips", "h1");
    expect(trips[0].expenses).toHaveLength(0);
  });

  it("promotes a trip created offline in the same batch, then syncs the dependent expense with the real tripId", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    const trip = await syncEngine.enqueueWrite(ctx, { entityType: "trips", operation: "create", payload: { nome: "Roma", expenses: [] } });
    expect(trip.id).toMatch(/^local:/);
    await syncEngine.enqueueTripExpenseWrite(ctx, { operation: "create", tripId: trip.id, payload: { pagatoDa: "g", importo: 20 } });

    let tripCreateSeen = false;
    vi.stubGlobal("fetch", vi.fn(async (url, opts) => {
      if (url === "https://api.test/api/trips") { tripCreateSeen = true; return jsonResponse(201, { id: "trip-real", nome: "Roma", expenses: [] }); }
      if (url === "https://api.test/api/trips/trip-real/expenses") {
        expect(tripCreateSeen).toBe(true);
        const body = JSON.parse(opts.body);
        expect(body.pagatoDa).toBe("g");
        return jsonResponse(201, { id: "exp-real", pagatoDa: "g", importo: 20 });
      }
      throw new Error(`unexpected fetch ${url}`);
    }));
    vi.stubGlobal("navigator", { onLine: true });
    await syncEngine.runSync(ctx);

    expect(await offlineDb.getOutboxOps("h1")).toHaveLength(0);
    const trips = await offlineDb.getAllEntities("trips", "h1");
    expect(trips[0].id).toBe("trip-real");
    expect(trips[0].expenses).toEqual([{ id: "exp-real", pagatoDa: "g", importo: 20 }]);
  });

  it("throws immediately on a synchronous validation rejection, while keeping the operation visible in the outbox", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    await offlineDb.putEntity("trips", "h1", { id: "trip1", expenses: [] });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(400, { error: { code: "UNKNOWN_TRIP_PARTICIPANT", message: "partecipante non valido" } })));
    await expect(syncEngine.enqueueTripExpenseWrite(ctx, {
      operation: "create", tripId: "trip1", payload: { pagatoDa: "mallory", importo: 20 },
    })).rejects.toThrow(/partecipante non valido/);
    const ops = await offlineDb.getOutboxOps("h1");
    expect(ops).toHaveLength(1);
    expect(ops[0].status).toBe("failed");
  });
});

describe("syncEngine — fetchAndMergeTripsSnapshot (trip-level + expense-level reconciliation)", () => {
  let syncEngine, offlineDb, ctx;
  beforeEach(async () => {
    ({ syncEngine, offlineDb } = await freshModules());
    ctx = makeCtx();
    vi.restoreAllMocks();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("keeps a not-yet-synced offline expense visible after a server refresh", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    await offlineDb.putEntity("trips", "h1", { id: "trip1", nome: "Roma", expenses: [] });
    await syncEngine.enqueueTripExpenseWrite(ctx, { operation: "create", tripId: "trip1", payload: { pagatoDa: "g", importo: 20 } });

    const merged = await syncEngine.fetchAndMergeTripsSnapshot(ctx, [{ id: "trip1", nome: "Roma", expenses: [] }]);
    expect(merged[0].expenses).toHaveLength(1);
    expect(merged[0].expenses[0]._pendingSync).toBe(true);
  });

  it("hides an expense with a pending delete from the merged snapshot", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    await offlineDb.putEntity("trips", "h1", { id: "trip1", expenses: [{ id: "exp1", importo: 5 }] });
    await syncEngine.enqueueTripExpenseWrite(ctx, { operation: "delete", tripId: "trip1", expenseId: "exp1", payload: null });

    const merged = await syncEngine.fetchAndMergeTripsSnapshot(ctx, [{ id: "trip1", expenses: [{ id: "exp1", importo: 5 }] }]);
    expect(merged[0].expenses).toHaveLength(0);
  });

  it("also applies the trip-level merge (a pending trip rename survives a refresh)", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    await offlineDb.putEntity("trips", "h1", { id: "trip1", nome: "Vecchio nome", expenses: [] });
    await syncEngine.enqueueWrite(ctx, { entityType: "trips", operation: "update", entityId: "trip1", payload: { nome: "Nuovo nome" } });

    const merged = await syncEngine.fetchAndMergeTripsSnapshot(ctx, [{ id: "trip1", nome: "Vecchio nome (dal server)", expenses: [] }]);
    expect(merged[0].nome).toBe("Nuovo nome");
  });
});

describe("syncEngine — sync conflict tracking (MOD-023)", () => {
  let syncEngine, offlineDb, ctx;
  beforeEach(async () => {
    ({ syncEngine, offlineDb } = await freshModules());
    ctx = makeCtx();
    vi.restoreAllMocks();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("increments the observed-conflict count when a pending update is overlaid on a server refresh", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    await offlineDb.putEntity("accounts", "h1", { id: "acc1", nome: "Vecchio" });
    await syncEngine.enqueueWrite(ctx, { entityType: "accounts", operation: "update", entityId: "acc1", payload: { nome: "Nuovo" } });

    const before = await syncEngine.getSyncStatus("h1");
    await syncEngine.fetchAndMergeSnapshot(ctx, "accounts", [{ id: "acc1", nome: "Dal server" }]);
    const after = await syncEngine.getSyncStatus("h1");

    expect(after.syncConflictsObserved).toBe(before.syncConflictsObserved + 1);
  });

  it("does NOT increment when there's nothing pending (no genuine conflict)", async () => {
    const before = await syncEngine.getSyncStatus("h1");
    await syncEngine.fetchAndMergeSnapshot(ctx, "accounts", [{ id: "acc1", nome: "Dal server" }]);
    const after = await syncEngine.getSyncStatus("h1");
    expect(after.syncConflictsObserved).toBe(before.syncConflictsObserved);
  });

  it("counts trip-expense conflicts too, via fetchAndMergeTripsSnapshot", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    await offlineDb.putEntity("trips", "h1", { id: "trip1", expenses: [{ id: "exp1", importo: 5 }] });
    await syncEngine.enqueueTripExpenseWrite(ctx, { operation: "delete", tripId: "trip1", expenseId: "exp1", payload: null });

    const before = await syncEngine.getSyncStatus("h1");
    await syncEngine.fetchAndMergeTripsSnapshot(ctx, [{ id: "trip1", expenses: [{ id: "exp1", importo: 5 }] }]);
    const after = await syncEngine.getSyncStatus("h1");

    expect(after.syncConflictsObserved).toBe(before.syncConflictsObserved + 1);
  });
});
