import { describe, it, expect, vi } from "vitest";
import {
  isTempId, makeTempId, makeOperation, compactEnqueue, sortForSync,
  resolveReferences, isOpReady, resolveOperationForSend, applyIdPromotion,
  recordIdAlias, nextBackoffMs, isRetryableStatus, summarizeOutbox,
  mergeServerSnapshot, mergeTripExpenses,
} from "./outboxLogic.js";

let idCounter = 0;
const idGen = () => `id${++idCounter}`;
function op(overrides = {}) {
  const base = makeOperation({ entityType: "transactions", entityId: makeTempId(idGen), operation: "create", payload: { importo: 10 }, householdId: "h1", now: 1000, idGen });
  return { ...base, ...overrides };
}

describe("isTempId / makeTempId", () => {
  it("recognizes a local temp id", () => {
    expect(isTempId("local:abc")).toBe(true);
    expect(isTempId("507f1f77bcf86cd799439011")).toBe(false);
    expect(isTempId(null)).toBe(false);
  });
  it("generates ids with the local: prefix", () => {
    expect(makeTempId(() => "xyz")).toBe("local:xyz");
  });
});

describe("compactEnqueue", () => {
  it("appends a create as-is", () => {
    const c = op({ operation: "create" });
    expect(compactEnqueue([], c)).toEqual([c]);
  });

  it("folds an update into a still-unsent create for the same entity", () => {
    const c = op({ operation: "create", entityId: "local:a", payload: { nome: "X" } });
    const u = op({ operation: "update", entityId: "local:a", payload: { nome: "Y" } });
    const result = compactEnqueue([c], u);
    expect(result).toHaveLength(1);
    expect(result[0].operation).toBe("create");
    expect(result[0].payload).toEqual({ nome: "Y" });
  });

  it("folds a second update into a still-unsent update for the same entity", () => {
    const u1 = op({ operation: "update", entityId: "acc1", payload: { nome: "X" } });
    const u2 = op({ operation: "update", entityId: "acc1", payload: { icona: "🏠" } });
    const result = compactEnqueue([u1], u2);
    expect(result).toHaveLength(1);
    expect(result[0].payload).toEqual({ nome: "X", icona: "🏠" });
  });

  it("does NOT fold an update into a create that has already been attempted", () => {
    const c = op({ operation: "create", entityId: "local:a", payload: { nome: "X" }, attempts: 1 });
    const u = op({ operation: "update", entityId: "local:a", payload: { nome: "Y" } });
    const result = compactEnqueue([c], u);
    expect(result).toHaveLength(2);
  });

  it("removes both create and delete when an entity is deleted before its create ever synced", () => {
    const c = op({ operation: "create", entityId: "local:a" });
    const d = op({ operation: "delete", entityId: "local:a", payload: null });
    const result = compactEnqueue([c], d);
    expect(result).toEqual([]);
  });

  it("drops queued updates and keeps the delete for an already-known entity", () => {
    const u = op({ operation: "update", entityId: "acc1", payload: { nome: "X" } });
    const d = op({ operation: "delete", entityId: "acc1", payload: null });
    const result = compactEnqueue([u], d);
    expect(result).toHaveLength(1);
    expect(result[0].operation).toBe("delete");
  });

  it("leaves unrelated entities' operations untouched", () => {
    const c1 = op({ operation: "create", entityId: "local:a" });
    const u2 = op({ operation: "update", entityId: "acc1", payload: { nome: "X" } });
    const result = compactEnqueue([c1], u2);
    expect(result).toEqual([c1, u2]);
  });
});

describe("sortForSync", () => {
  it("orders by createdAt ascending", () => {
    const a = op({ createdAt: 300, operationId: "a" });
    const b = op({ createdAt: 100, operationId: "b" });
    const c = op({ createdAt: 200, operationId: "c" });
    expect(sortForSync([a, b, c]).map(x => x.operationId)).toEqual(["b", "c", "a"]);
  });
  it("breaks createdAt ties by operationId for determinism", () => {
    const a = op({ createdAt: 100, operationId: "b" });
    const b = op({ createdAt: 100, operationId: "a" });
    expect(sortForSync([a, b]).map(x => x.operationId)).toEqual(["a", "b"]);
  });
  it("does not mutate the input array", () => {
    const arr = [op({ createdAt: 2 }), op({ createdAt: 1 })];
    const copy = [...arr];
    sortForSync(arr);
    expect(arr).toEqual(copy);
  });
});

describe("resolveReferences", () => {
  it("passes through a payload with no temp-id fields", () => {
    const { payload, unresolvedRef } = resolveReferences({ nome: "Spesa", importo: 10 }, {});
    expect(payload).toEqual({ nome: "Spesa", importo: 10 });
    expect(unresolvedRef).toBeNull();
  });
  it("rewrites a resolved temp-id reference", () => {
    const { payload, unresolvedRef } = resolveReferences({ contoId: "local:acc" }, { "local:acc": "acc-real" });
    expect(payload.contoId).toBe("acc-real");
    expect(unresolvedRef).toBeNull();
  });
  it("flags an unresolved temp-id reference", () => {
    const { unresolvedRef } = resolveReferences({ contoId: "local:acc" }, {});
    expect(unresolvedRef).toBe("local:acc");
  });
  it("passes null payload through unchanged", () => {
    expect(resolveReferences(null, {})).toEqual({ payload: null, unresolvedRef: null });
  });
});

describe("isOpReady", () => {
  it("a create is always ready even though its own entityId is an unresolved temp id (that's expected — this send is what resolves it)", () => {
    expect(isOpReady(op({ operation: "create", entityId: "local:a" }), {})).toBe(true);
  });
  it("is ready when entityId is a real id and payload has no unresolved refs", () => {
    expect(isOpReady(op({ entityId: "acc1", payload: { nome: "X" } }), {})).toBe(true);
  });
  it("an update/delete is NOT ready when its own entityId is an unresolved temp id", () => {
    expect(isOpReady(op({ operation: "update", entityId: "local:a" }), {})).toBe(false);
    expect(isOpReady(op({ operation: "delete", entityId: "local:a", payload: null }), {})).toBe(false);
  });
  it("an update is ready once its temp entityId has a known alias", () => {
    expect(isOpReady(op({ operation: "update", entityId: "local:a" }), { "local:a": "acc1" })).toBe(true);
  });
  it("is NOT ready when the payload references an unresolved temp id, even for a create", () => {
    expect(isOpReady(op({ operation: "create", entityId: "local:tx", payload: { contoId: "local:acc" } }), {})).toBe(false);
  });
});

describe("resolveOperationForSend", () => {
  it("rewrites entityId and payload refs together", () => {
    const o = op({ entityId: "local:a", payload: { contoId: "local:acc" } });
    const idAliases = { "local:a": "tx-real", "local:acc": "acc-real" };
    const sendable = resolveOperationForSend(o, idAliases);
    expect(sendable.entityId).toBe("tx-real");
    expect(sendable.payload.contoId).toBe("acc-real");
  });
});

describe("applyIdPromotion", () => {
  it("rewrites entityId on other operations targeting the same temp id", () => {
    const u = op({ operation: "update", entityId: "local:a", payload: { nome: "X" } });
    const [result] = applyIdPromotion([u], "local:a", "real1");
    expect(result.entityId).toBe("real1");
  });
  it("rewrites payload fields that reference the temp id", () => {
    const tx = op({ entityType: "transactions", entityId: "tx1", payload: { contoId: "local:acc" } });
    const [result] = applyIdPromotion([tx], "local:acc", "acc-real");
    expect(result.payload.contoId).toBe("acc-real");
  });
  it("leaves unrelated operations untouched", () => {
    const other = op({ entityId: "acc2", payload: { nome: "Y" } });
    const [result] = applyIdPromotion([other], "local:acc", "acc-real");
    expect(result).toEqual(other);
  });
});

describe("recordIdAlias", () => {
  it("adds a new alias without mutating the original map", () => {
    const before = { "local:x": "x-real" };
    const after = recordIdAlias(before, "local:y", "y-real");
    expect(after).toEqual({ "local:x": "x-real", "local:y": "y-real" });
    expect(before).toEqual({ "local:x": "x-real" });
  });
});

describe("nextBackoffMs", () => {
  it("grows exponentially with attempts", () => {
    const rng = () => 0.5; // neutral jitter (midpoint of the ±25% range)
    const b1 = nextBackoffMs(1, { rng });
    const b2 = nextBackoffMs(2, { rng });
    const b3 = nextBackoffMs(3, { rng });
    expect(b2).toBeGreaterThan(b1);
    expect(b3).toBeGreaterThan(b2);
  });
  it("never exceeds the cap", () => {
    const rng = () => 1; // max jitter
    expect(nextBackoffMs(20, { cap: 60000, rng })).toBeLessThanOrEqual(60000 * 1.25 + 1);
  });
  it("stays positive for the first attempt", () => {
    expect(nextBackoffMs(1, { rng: () => 0 })).toBeGreaterThan(0);
  });
});

describe("isRetryableStatus", () => {
  it("treats a network failure (null status) as retryable", () => {
    expect(isRetryableStatus(null)).toBe(true);
  });
  it("treats 5xx and 429 as retryable", () => {
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(429)).toBe(true);
  });
  it("treats 400/401/403/404/409/422 as NOT auto-retryable", () => {
    for (const s of [400, 401, 403, 404, 409, 422]) expect(isRetryableStatus(s)).toBe(false);
  });
});

describe("summarizeOutbox", () => {
  it("counts pending vs failed", () => {
    const ops = [op({ status: "pending" }), op({ status: "failed" }), op({ status: "pending" })];
    expect(summarizeOutbox(ops)).toEqual({ pending: 2, failed: 1, total: 3 });
  });
});

describe("mergeServerSnapshot", () => {
  it("returns server entities unchanged when nothing is pending", () => {
    const server = [{ id: "1", nome: "A" }, { id: "2", nome: "B" }];
    expect(mergeServerSnapshot(server, [])).toEqual(server);
  });

  it("hides an entity with a pending delete even though the server still has it", () => {
    const server = [{ id: "1", nome: "A" }];
    const pending = [op({ entityId: "1", operation: "delete", payload: null })];
    expect(mergeServerSnapshot(server, pending)).toEqual([]);
  });

  it("applies a pending update on top of the server version", () => {
    const server = [{ id: "1", nome: "A", saldoIniziale: 0 }];
    const pending = [op({ entityId: "1", operation: "update", payload: { nome: "A-edited" } })];
    expect(mergeServerSnapshot(server, pending)).toEqual([{ id: "1", nome: "A-edited", saldoIniziale: 0 }]);
  });

  it("applies multiple queued updates in order", () => {
    const server = [{ id: "1", nome: "A", icona: "🏦" }];
    const pending = [
      op({ entityId: "1", operation: "update", payload: { nome: "B" }, createdAt: 100 }),
      op({ entityId: "1", operation: "update", payload: { icona: "🏠" }, createdAt: 200 }),
    ];
    expect(mergeServerSnapshot(server, pending)).toEqual([{ id: "1", nome: "B", icona: "🏠" }]);
  });

  it("keeps a not-yet-acknowledged local create visible, flagged as pending", () => {
    const server = [];
    const pending = [op({ entityId: "local:new", operation: "create", payload: { nome: "New" } })];
    const result = mergeServerSnapshot(server, pending);
    expect(result).toEqual([{ nome: "New", id: "local:new", _pendingSync: true }]);
  });

  it("does not resurrect a local create once the server has acknowledged it (temp id no longer relevant)", () => {
    const server = [{ id: "real1", nome: "New" }];
    // The create operation would normally have been removed from the outbox
    // once acknowledged — simulating "somehow still present but pointing at
    // the real id now" to confirm no duplicate appears.
    const pending = [op({ entityId: "real1", operation: "create", payload: { nome: "New" } })];
    const result = mergeServerSnapshot(server, pending);
    expect(result).toEqual([{ id: "real1", nome: "New" }]);
  });
});

describe("mergeTripExpenses", () => {
  function expenseOp(overrides) {
    return op({ entityType: "tripExpenses", operation: "create", payload: { tripId: "trip1", importo: 10 }, ...overrides });
  }

  it("returns trips unchanged when there are no pending expense ops", () => {
    const trips = [{ id: "trip1", expenses: [{ id: "e1", importo: 5 }] }];
    expect(mergeTripExpenses(trips, [])).toBe(trips);
  });

  it("keeps a not-yet-acknowledged local expense visible, flagged pending", () => {
    const trips = [{ id: "trip1", expenses: [] }];
    const ops = [expenseOp({ entityId: "local:exp1", payload: { tripId: "trip1", importo: 20, pagatoDa: "g" } })];
    const result = mergeTripExpenses(trips, ops);
    expect(result[0].expenses).toEqual([{ id: "local:exp1", importo: 20, pagatoDa: "g", _pendingSync: true }]);
  });

  it("hides an expense with a pending delete even though the server still has it", () => {
    const trips = [{ id: "trip1", expenses: [{ id: "e1", importo: 5 }] }];
    // Trip expense deletes carry { tripId } in payload (not null like
    // generic entity deletes) — the routing/reconciliation code needs
    // tripId even for a delete, since there's no top-level /api/tripExpenses
    // resource to infer it from.
    const ops = [expenseOp({ entityId: "e1", operation: "delete", payload: { tripId: "trip1" } })];
    const result = mergeTripExpenses(trips, ops);
    expect(result[0].expenses).toEqual([]);
  });

  it("only affects the trip the expense belongs to", () => {
    const trips = [
      { id: "trip1", expenses: [] },
      { id: "trip2", expenses: [{ id: "e2", importo: 1 }] },
    ];
    const ops = [expenseOp({ entityId: "local:exp1", payload: { tripId: "trip1", importo: 20 } })];
    const result = mergeTripExpenses(trips, ops);
    expect(result[0].expenses).toHaveLength(1);
    expect(result[1].expenses).toEqual([{ id: "e2", importo: 1 }]); // untouched
  });

  it("does not duplicate an expense the server has already acknowledged", () => {
    const trips = [{ id: "trip1", expenses: [{ id: "real-exp", importo: 20 }] }];
    // Simulates the rare case where the outbox op still references the
    // now-resolved real id (e.g. read just after promotion, before the op
    // was removed) — must not add a second copy.
    const ops = [expenseOp({ entityId: "real-exp", payload: { tripId: "trip1", importo: 20 } })];
    const result = mergeTripExpenses(trips, ops);
    expect(result[0].expenses).toEqual([{ id: "real-exp", importo: 20 }]);
  });

  it("skips a malformed op with no tripId rather than throwing", () => {
    const trips = [{ id: "trip1", expenses: [] }];
    const ops = [expenseOp({ entityId: "local:exp1", payload: { importo: 20 } })];
    expect(() => mergeTripExpenses(trips, ops)).not.toThrow();
    expect(mergeTripExpenses(trips, ops)[0].expenses).toEqual([]);
  });

  it("a delete op without a resolvable tripId in its payload is a bug, not a valid no-op — regression guard", () => {
    // If a delete's payload were ever null/tripId-less (the generic entity
    // convention), the delete would silently be dropped by the tripId
    // lookup above instead of hiding the expense. This asserts the correct
    // shape (tripId present even on delete) actually takes effect.
    const trips = [{ id: "trip1", expenses: [{ id: "e1", importo: 5 }] }];
    const withTripId = mergeTripExpenses(trips, [expenseOp({ entityId: "e1", operation: "delete", payload: { tripId: "trip1" } })]);
    expect(withTripId[0].expenses).toEqual([]);
  });
});
