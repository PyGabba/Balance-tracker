// ─── Offline outbox — pure decision logic (MOD-003) ───
// No IndexedDB, no fetch, no React — just plain data in, plain data out, so
// the rules that matter most (nothing lost, nothing duplicated, nothing
// sent out of order) can be unit-tested in isolation. See outboxLogic.test.js.
// The IndexedDB/fetch wiring lives in offlineDb.js and syncEngine.js.

export const ENTITY_TYPES = ["transactions", "accounts", "goals", "trips", "positions"];

export function isTempId(id) {
  return typeof id === "string" && id.startsWith("local:");
}

export function makeTempId(idGen = () => crypto.randomUUID()) {
  return `local:${idGen()}`;
}

/**
 * A queued write. `entityId` is a temp id ("local:...") for an entity
 * created offline and not yet acknowledged by the server, or the real
 * server id otherwise. `payload` is null for a delete.
 */
export function makeOperation({ entityType, entityId, operation, payload, householdId, now = Date.now(), idGen = () => crypto.randomUUID() }) {
  return {
    operationId: idGen(),
    entityType, entityId, operation, householdId,
    payload: payload ? { ...payload } : null,
    createdAt: now,
    attempts: 0,
    lastError: null,
    status: "pending", // "pending" (will auto-retry) | "failed" (stopped — needs attention)
  };
}

// An operation is safe to fold another write into if it has never actually
// been sent — folding after a send was attempted risks losing track of
// what the server has already seen.
const unsent = (op) => op.attempts === 0;
const sameEntity = (op, newOp) => op.entityType === newOp.entityType && op.entityId === newOp.entityId;

// When an unsent create is dropped (the entity it would have created never
// existed as far as the server knows), its temp id can NEVER get a
// real-id alias — nothing will ever call recordIdAlias for it. Any other
// still-queued operation whose payload references that temp id (e.g. a
// transaction's contoId pointing at an account created — then deleted —
// in the same offline session) would otherwise sit in isOpReady's
// unresolvedRef limbo forever, since the reference it's waiting on can
// never resolve.
//
// A trip expense is structurally incapable of existing without its trip
// (there's no standalone /api/tripExpenses — the URL itself is
// /api/trips/:tripId/expenses), so an unsent tripExpenses op referencing
// the dead id cascades away with it, exactly like the parent create being
// dropped. Any other reference (accounts, the only other cross-entity
// temp-id reference in this app — contoId/contoDa/contoA on transactions,
// contoId on goals) is optional at the API level, so the dangling
// reference is just cleared instead of losing the whole operation.
function cascadeRemoveTempId(outboxOps, deadTempId) {
  const survivors = [];
  const toCascade = [];
  let changed = false;
  for (const op of outboxOps) {
    const references = op.payload ? Object.values(op.payload).some(v => v === deadTempId) : false;
    if (!references) { survivors.push(op); continue; }
    changed = true;
    if (op.entityType === "tripExpenses" && unsent(op)) {
      toCascade.push(op.entityId); // its own temp id may in turn be referenced elsewhere
      continue;
    }
    const payload = { ...op.payload };
    for (const [k, v] of Object.entries(payload)) if (v === deadTempId) payload[k] = null;
    survivors.push({ ...op, payload });
  }
  if (!changed) return outboxOps;
  return toCascade.reduce((ops, id) => cascadeRemoveTempId(ops, id), survivors);
}

/**
 * Applied every time a new write is queued. Keeps the outbox minimal and
 * resolves same-entity ordering locally instead of ever sending
 * contradictory operations to the server:
 *  - update folded into a still-unsent create for the same entity
 *  - update folded into a still-unsent update for the same entity
 *  - delete of an entity whose create was never sent removes both — there
 *    is nothing to sync, the entity never existed as far as the server
 *    knows — and cascades that removal to anything else in the outbox
 *    that referenced it (see cascadeRemoveTempId above), so no other
 *    operation is left permanently waiting on an id that will never exist
 *  - delete of an otherwise-known entity drops any queued updates for it
 *    (moot) and queues the delete
 */
export function compactEnqueue(outboxOps, newOp) {
  if (newOp.operation === "update") {
    const pendingCreate = outboxOps.find(op => sameEntity(op, newOp) && op.operation === "create" && unsent(op));
    if (pendingCreate) {
      return outboxOps.map(op => op === pendingCreate ? { ...op, payload: { ...op.payload, ...newOp.payload } } : op);
    }
    const pendingUpdate = outboxOps.find(op => sameEntity(op, newOp) && op.operation === "update" && unsent(op));
    if (pendingUpdate) {
      return outboxOps.map(op => op === pendingUpdate
        ? { ...op, payload: { ...op.payload, ...newOp.payload }, createdAt: newOp.createdAt }
        : op);
    }
    return [...outboxOps, newOp];
  }

  if (newOp.operation === "delete") {
    const pendingCreate = outboxOps.find(op => sameEntity(op, newOp) && op.operation === "create" && unsent(op));
    if (pendingCreate) {
      return cascadeRemoveTempId(outboxOps.filter(op => !sameEntity(op, newOp)), newOp.entityId);
    }
    return [...outboxOps.filter(op => !(sameEntity(op, newOp) && op.operation === "update")), newOp];
  }

  // create: entityId is always a freshly-generated temp id, nothing to fold into.
  return [...outboxOps, newOp];
}

// Deterministic send order (MOD-003: "send operations in deterministic
// order"). operationId as a tiebreaker keeps it stable even if two writes
// land in the same millisecond.
export function sortForSync(outboxOps) {
  return [...outboxOps].sort((a, b) => a.createdAt - b.createdAt || a.operationId.localeCompare(b.operationId));
}

// Scans a payload's string fields for temp-id references (e.g. a
// transaction's contoId pointing at an account created offline in the same
// batch) and rewrites any that are already resolved. `unresolvedRef` is set
// to the first temp id that has no known alias yet — the caller must defer
// this operation until that referenced entity's create has synced.
export function resolveReferences(payload, idAliases) {
  if (!payload) return { payload, unresolvedRef: null };
  let unresolvedRef = null;
  const out = { ...payload };
  for (const [k, v] of Object.entries(out)) {
    if (typeof v === "string" && isTempId(v)) {
      if (idAliases[v]) out[k] = idAliases[v];
      else if (!unresolvedRef) unresolvedRef = v;
    }
  }
  return { payload: out, unresolvedRef };
}

// True if this operation can be sent right now. An update/delete targeting
// a not-yet-acknowledged create (entityId still a temp id) must wait for
// that create to resolve first. A create's own entityId is ALWAYS a fresh,
// as-yet-unresolved temp id by definition — that's what this send is going
// to resolve — so that check only applies to update/delete. Either way,
// every temp-id reference inside the payload must already be resolved.
export function isOpReady(op, idAliases) {
  if (op.operation !== "create" && isTempId(op.entityId) && !idAliases[op.entityId]) return false;
  return resolveReferences(op.payload, idAliases).unresolvedRef == null;
}

// Produces the operation as it should actually be sent: real entityId and
// payload with every resolvable temp-id reference rewritten.
export function resolveOperationForSend(op, idAliases) {
  const entityId = isTempId(op.entityId) ? (idAliases[op.entityId] || op.entityId) : op.entityId;
  const { payload } = resolveReferences(op.payload, idAliases);
  return { ...op, entityId, payload };
}

// After a create is acknowledged (tempId -> realId), every other queued
// operation that referenced tempId — either as its own entityId or as a
// payload field — must be rewritten so the next sync pass can resolve it.
export function applyIdPromotion(outboxOps, tempId, realId) {
  return outboxOps.map(op => {
    let next = op;
    if (next.entityId === tempId) next = { ...next, entityId: realId };
    if (next.payload) {
      let changed = false;
      const payload = { ...next.payload };
      for (const [k, v] of Object.entries(payload)) {
        if (v === tempId) { payload[k] = realId; changed = true; }
      }
      if (changed) next = { ...next, payload };
    }
    return next;
  });
}

export function recordIdAlias(idAliases, tempId, realId) {
  return { ...idAliases, [tempId]: realId };
}

// Exponential backoff with a cap and jitter, for retrying a failed send
// (MOD-003: "retry failed operations with exponential backoff").
export function nextBackoffMs(attempts, { base = 2000, cap = 5 * 60 * 1000, rng = Math.random } = {}) {
  const raw = base * 2 ** Math.max(0, attempts - 1);
  const capped = Math.min(raw, cap);
  return Math.round(capped * (0.75 + rng() * 0.5)); // ±25% jitter, avoids a thundering herd on reconnect
}

// HTTP statuses worth auto-retrying (transient/server-side). Anything else
// — validation, auth, not-found, conflict — is presumed to need a person's
// attention rather than being retried forever; the operation still stays
// in the outbox (nothing is silently dropped), just marked "failed" so a
// UI can surface it. `status === null` means a network-level failure
// (fetch threw), which is always retryable.
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
export function isRetryableStatus(status) {
  return status == null || RETRYABLE_STATUSES.has(status);
}

export function summarizeOutbox(outboxOps) {
  let pending = 0, failed = 0;
  for (const op of outboxOps) { if (op.status === "failed") failed++; else pending++; }
  return { pending, failed, total: outboxOps.length };
}

/**
 * MOD-003's core reconciliation rule: a fresh server snapshot must never
 * silently overwrite a pending local change.
 *  - an entity with a pending delete is hidden even though the server
 *    still has it
 *  - an entity with one or more pending updates gets those payloads
 *    re-applied on top of the server's version (in queue order)
 *  - an entity with no pending operation takes the server's version
 *    (the server is authoritative once nothing local is pending)
 *  - a pending create the server hasn't acknowledged yet contributes a
 *    local-only entity (flagged _pendingSync) so it doesn't disappear
 *    from the list between creating it and the sync completing
 *
 * `pendingOpsForThisType` must already be filtered to the entity type
 * being merged (the caller merges one collection at a time).
 */
// Counts entities where a pending update/delete was overlaid on top of the
// server's version during a merge — i.e. genuine "local change was still
// pending when a fresh server snapshot arrived" moments (MOD-023: track
// synchronization conflicts). Pending creates aren't counted here since
// there's no server-side value being overridden — nothing to conflict with.
export function countMergeConflicts(pendingOpsForThisType) {
  const seen = new Set();
  let count = 0;
  for (const op of pendingOpsForThisType) {
    if (op.operation === "update" || op.operation === "delete") {
      if (!seen.has(op.entityId)) { seen.add(op.entityId); count++; }
    }
  }
  return count;
}

export function mergeServerSnapshot(serverEntities, pendingOpsForThisType) {
  const pendingOps = sortForSync(pendingOpsForThisType);
  const opsByEntity = new Map();
  for (const op of pendingOps) {
    if (!opsByEntity.has(op.entityId)) opsByEntity.set(op.entityId, []);
    opsByEntity.get(op.entityId).push(op);
  }

  const result = [];
  for (const entity of serverEntities) {
    const ops = opsByEntity.get(entity.id);
    if (!ops || ops.length === 0) { result.push(entity); continue; }
    if (ops.some(op => op.operation === "delete")) continue;
    let merged = entity;
    for (const op of ops) if (op.operation === "update") merged = { ...merged, ...op.payload };
    result.push(merged);
  }

  const knownIds = new Set(serverEntities.map(e => e.id));
  for (const op of pendingOps) {
    if (op.operation === "create" && !knownIds.has(op.entityId)) {
      result.push({ ...op.payload, id: op.entityId, _pendingSync: true });
    }
  }
  return result;
}

// ─── Trip expenses (MOD-003 gap closed) ───
// Trip expenses are sub-documents inside trip.expenses, not their own
// top-level entity — no /api/tripExpenses collection, no dedicated
// IndexedDB store — so mergeServerSnapshot above (built for a flat list of
// top-level entities keyed by id) doesn't directly apply to them. This is
// the analogous reconciliation step for the nested case: run AFTER the
// normal trip-level merge, overlaying any pending "tripExpenses" outbox
// ops onto the right trip's expenses array by matching payload.tripId.
// Same rules as the top-level version: a pending delete hides an expense
// even if the server still has it; a not-yet-acknowledged pending create
// stays visible, flagged _pendingSync, so it doesn't disappear between
// being added and the sync completing.
export function mergeTripExpenses(trips, tripExpenseOps) {
  if (!tripExpenseOps || tripExpenseOps.length === 0) return trips;
  const opsByTrip = new Map();
  for (const op of sortForSync(tripExpenseOps)) {
    const tripId = op.payload?.tripId;
    if (!tripId) continue; // malformed op — nothing sensible to overlay, skip rather than throw
    if (!opsByTrip.has(tripId)) opsByTrip.set(tripId, []);
    opsByTrip.get(tripId).push(op);
  }
  if (opsByTrip.size === 0) return trips;

  return trips.map(trip => {
    const ops = opsByTrip.get(trip.id);
    if (!ops || ops.length === 0) return trip;
    const deletedIds = new Set(ops.filter(op => op.operation === "delete").map(op => op.entityId));
    let expenses = (trip.expenses || []).filter(e => !deletedIds.has(e.id));
    const knownIds = new Set(expenses.map(e => e.id));
    for (const op of ops) {
      if (op.operation === "create" && !knownIds.has(op.entityId)) {
        const { tripId: _tripId, ...expensePayload } = op.payload || {};
        expenses = [...expenses, { ...expensePayload, id: op.entityId, _pendingSync: true }];
        knownIds.add(op.entityId);
      }
    }
    return { ...trip, expenses };
  });
}
