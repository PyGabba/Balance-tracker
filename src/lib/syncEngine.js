// ─── Sync engine (MOD-003) ───
// Wires outboxLogic.js (pure rules) to offlineDb.js (IndexedDB) and the
// network. api.js calls this instead of talking to fetch directly for
// every write on transactions/accounts/goals/trips/positions, so every one
// of those entity types gets the same durability guarantees:
//   - a write is persisted to the outbox BEFORE any UI-visible state changes
//   - a retry can't create a duplicate (Idempotency-Key = operationId)
//   - a fresh server snapshot never silently overwrites a pending local edit
//   - failed sends retry with backoff; likely-permanent failures are
//     flagged instead of retried forever
//
// api.js supplies a `ctxProvider()` — a zero-arg function returning
// { apiBase, householdId, authHeaders } fresh on every call — so this
// module never needs to import api.js and there's no circular dependency.

import {
  makeOperation, makeTempId, compactEnqueue, sortForSync, isOpReady,
  resolveOperationForSend, applyIdPromotion, recordIdAlias, nextBackoffMs,
  isRetryableStatus, summarizeOutbox, mergeServerSnapshot,
} from "./outboxLogic.js";
import {
  getAllEntities, putEntity, deleteEntity, replaceAllEntities,
  getOutboxOps, putOutboxOp, deleteOutboxOp, replaceOutbox,
  getMeta, setMeta, clearHouseholdData,
} from "./offlineDb.js";

const ENTITY_ENDPOINTS = {
  transactions: { base: "/api/transactions", hasUpdate: true },
  accounts: { base: "/api/accounts", hasUpdate: true },
  goals: { base: "/api/goals", hasUpdate: true },
  trips: { base: "/api/trips", hasUpdate: true },
  positions: { base: "/api/positions", hasUpdate: false },
};

let syncing = false;
const statusListeners = new Set();
function notifyStatus() { for (const cb of statusListeners) { try { cb(); } catch {} } }
export function onSyncStatusChange(cb) { statusListeners.add(cb); return () => statusListeners.delete(cb); }

export async function getSyncStatus(householdId) {
  if (!householdId) return { pending: 0, failed: 0, total: 0, syncing: false };
  const ops = await getOutboxOps(householdId);
  return { ...summarizeOutbox(ops), syncing };
}

function isOnline() {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

function buildRequest(ctx, op) {
  const cfg = ENTITY_ENDPOINTS[op.entityType];
  if (op.operation === "create") {
    return { url: `${ctx.apiBase}${cfg.base}`, method: "POST", headers: { ...ctx.authHeaders(), "Idempotency-Key": op.operationId } };
  }
  if (op.operation === "update") {
    return { url: `${ctx.apiBase}${cfg.base}/${op.entityId}`, method: "PUT", headers: ctx.authHeaders() };
  }
  return { url: `${ctx.apiBase}${cfg.base}/${op.entityId}`, method: "DELETE", headers: ctx.authHeaders() };
}

async function trySendOperation(ctx, op, idAliases) {
  if (!isOpReady(op, idAliases)) return { ok: false, deferred: true };
  const sendable = resolveOperationForSend(op, idAliases);
  const req = buildRequest(ctx, sendable);
  let res;
  try {
    res = await fetch(req.url, {
      method: req.method, headers: req.headers, credentials: "include",
      body: sendable.payload != null ? JSON.stringify(sendable.payload) : undefined,
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    return { ok: false, status: null, error: err?.message || "network error" };
  }
  if (res.ok) {
    let body = null;
    try { body = await res.json(); } catch {}
    return { ok: true, body };
  }
  // A 404 on an update/delete retry means the entity is already gone
  // (deleted earlier, possibly from another device, or by an earlier
  // attempt of this very operation) — that's the operation's desired end
  // state, not a failure. Treat it as success rather than looping forever.
  if ((op.operation === "delete" || op.operation === "update") && res.status === 404) {
    return { ok: true, body: null, alreadyGone: true };
  }
  let errBody = null;
  try { errBody = await res.json(); } catch {}
  const message = (typeof errBody?.error === "string" ? errBody.error : errBody?.error?.message) || `HTTP ${res.status}`;
  return { ok: false, status: res.status, error: message };
}

// Processes the outbox for the current household: sends every ready
// operation in deterministic order, promotes temp ids on create acks, and
// re-passes until nothing more can progress (an id promotion mid-pass can
// unblock an operation that was deferred earlier in the same pass).
export async function runSync(ctxProvider) {
  const ctx = ctxProvider();
  if (!ctx || !ctx.householdId) return;
  if (syncing) return;
  if (!isOnline()) return;
  syncing = true;
  notifyStatus();
  try {
    let idAliases = await getMeta(ctx.householdId, "idAliases", {});
    let pass = 0, anyProgress = true;
    while (anyProgress && pass < 10) {
      pass++;
      anyProgress = false;
      const ops = sortForSync(await getOutboxOps(ctx.householdId));
      for (const op of ops) {
        if (op.status === "failed") continue; // needs manual attention (see discardOperation/retryOperation)
        if (op.nextAttemptAt && op.nextAttemptAt > Date.now()) continue; // still backing off

        // eslint-disable-next-line no-await-in-loop
        const result = await trySendOperation(ctx, op, idAliases);
        if (result.deferred) continue;

        if (result.ok) {
          anyProgress = true;
          if (op.operation === "create" && !result.alreadyGone && result.body?.id) {
            const realId = result.body.id;
            idAliases = recordIdAlias(idAliases, op.entityId, realId);
            // eslint-disable-next-line no-await-in-loop
            await setMeta(ctx.householdId, "idAliases", idAliases);
            // eslint-disable-next-line no-await-in-loop
            await deleteEntity(op.entityType, op.entityId);
            // eslint-disable-next-line no-await-in-loop
            await putEntity(op.entityType, ctx.householdId, result.body);
          } else if (op.operation === "update" && result.body?.id) {
            // eslint-disable-next-line no-await-in-loop
            await putEntity(op.entityType, ctx.householdId, result.body);
          }
          // eslint-disable-next-line no-await-in-loop
          await deleteOutboxOp(op.operationId);
        } else if (isRetryableStatus(result.status)) {
          const attempts = op.attempts + 1;
          // eslint-disable-next-line no-await-in-loop
          await putOutboxOp({ ...op, attempts, lastError: result.error || null, nextAttemptAt: Date.now() + nextBackoffMs(attempts), status: "pending" });
        } else {
          // Likely-permanent rejection (validation, auth, conflict...) —
          // stop auto-retrying but keep it visible in the outbox so the
          // person can see it and discard or retry manually.
          // eslint-disable-next-line no-await-in-loop
          await putOutboxOp({ ...op, attempts: op.attempts + 1, lastError: result.error || null, status: "failed" });
        }
      }
    }
  } finally {
    syncing = false;
    notifyStatus();
  }
}

/**
 * The single entry point every write (create/update/delete) on any of the
 * five entity types goes through. Durably queues the operation, applies it
 * optimistically to the local cache, then makes one immediate attempt to
 * sync if online — so the common case (online, normal use) resolves with
 * the real server entity just like a direct fetch would, while the offline
 * case falls back to the optimistic local entity and a background retry.
 */
export async function enqueueWrite(ctxProvider, { entityType, operation, entityId, payload }) {
  const ctx = ctxProvider();
  if (!ctx || !ctx.householdId) throw new Error("Nessuna casa attiva");
  const householdId = ctx.householdId;
  const finalEntityId = entityId || makeTempId();
  const newOp = makeOperation({ entityType, entityId: finalEntityId, operation, payload, householdId });

  // 1) Durable BEFORE any UI-visible state changes (MOD-003).
  const compacted = compactEnqueue(await getOutboxOps(householdId), newOp);
  await replaceOutbox(householdId, compacted);

  // 2) Optimistic local cache update.
  if (operation === "delete") {
    await deleteEntity(entityType, finalEntityId);
  } else {
    const existing = (await getAllEntities(entityType, householdId)).find(e => e.id === finalEntityId);
    await putEntity(entityType, householdId, { ...(existing || {}), ...payload, id: finalEntityId });
  }
  notifyStatus();

  // 3) Best-effort immediate sync.
  if (isOnline()) {
    try { await runSync(ctxProvider); } catch (e) { console.error("syncEngine: immediate sync attempt failed", e); }
  }

  // If the immediate attempt above ran synchronously and the server
  // rejected THIS write outright (validation, auth, conflict — anything
  // classified non-retryable, not a transient/network failure), surface
  // that to the caller right away instead of silently pretending it
  // succeeded — this is what lets the UI show an immediate error for bad
  // input (MOD-002) even though writes are otherwise optimistic. The
  // operation stays in the outbox regardless (MOD-003: nothing is
  // silently dropped), so it's still visible/resolvable later even if the
  // caller ignores this thrown error.
  const [thisOp] = (await getOutboxOps(householdId)).filter(o => o.entityType === entityType && o.entityId === finalEntityId);
  if (thisOp?.status === "failed") {
    const err = new Error(thisOp.lastError || "Richiesta rifiutata dal server");
    err.name = "SyncRejectedError";
    err.operationId = thisOp.operationId;
    throw err;
  }

  if (operation === "delete") return true;
  const idAliases = await getMeta(householdId, "idAliases", {});
  const resolvedId = idAliases[finalEntityId] || finalEntityId;
  const stored = (await getAllEntities(entityType, householdId)).find(e => e.id === resolvedId);
  return stored || { id: finalEntityId, ...payload };
}

// Merges a fresh server snapshot with whatever's still pending for this
// entity type (MOD-003: never let a refresh clobber a pending local
// change) and makes the merged result the new local cache.
export async function fetchAndMergeSnapshot(ctxProvider, entityType, serverEntities) {
  const ctx = ctxProvider();
  if (!ctx || !ctx.householdId) return serverEntities;
  const ops = (await getOutboxOps(ctx.householdId)).filter(o => o.entityType === entityType);
  const merged = mergeServerSnapshot(serverEntities, ops);
  await replaceAllEntities(entityType, ctx.householdId, merged);
  return merged;
}

export async function getCachedEntities(ctxProvider, entityType) {
  const ctx = ctxProvider();
  if (!ctx || !ctx.householdId) return [];
  return getAllEntities(entityType, ctx.householdId);
}

// Writes an entity straight to the local cache without touching the
// outbox. Used for sub-document writes (trip expenses live inside a trip's
// `expenses` array, not as their own top-level entity) that aren't yet
// covered by the generic per-entity outbox above — see api.js.
export async function cacheEntityOnly(ctxProvider, entityType, entity) {
  const ctx = ctxProvider();
  if (!ctx?.householdId) return;
  await putEntity(entityType, ctx.householdId, entity);
  notifyStatus();
}

// ─── Manual control over a "failed" (stopped-retrying) operation ───
export async function getFailedOperations(householdId) {
  if (!householdId) return [];
  const ops = await getOutboxOps(householdId);
  return ops
    .filter(o => o.status === "failed")
    .map(o => ({ operationId: o.operationId, entityType: o.entityType, operation: o.operation, lastError: o.lastError }));
}

export async function discardOperation(householdId, operationId) {
  await deleteOutboxOp(operationId);
  notifyStatus();
}
export async function retryOperation(ctxProvider, operationId) {
  const ctx = ctxProvider();
  if (!ctx?.householdId) return;
  const ops = await getOutboxOps(ctx.householdId);
  const target = ops.find(o => o.operationId === operationId);
  if (!target) return;
  await putOutboxOp({ ...target, status: "pending", nextAttemptAt: 0 });
  notifyStatus();
  await runSync(ctxProvider);
}

// ─── Background loop lifecycle ───
let autoSyncInterval = null;
let onlineListenerAttached = false;
const POLL_MS = 20000;

export function startAutoSync(ctxProvider) {
  if (typeof window === "undefined") return;
  if (!onlineListenerAttached) {
    window.addEventListener("online", () => { runSync(ctxProvider); });
    onlineListenerAttached = true;
  }
  if (autoSyncInterval) clearInterval(autoSyncInterval);
  autoSyncInterval = setInterval(() => { runSync(ctxProvider); }, POLL_MS);
  runSync(ctxProvider); // pick up anything left over from a previous session
}

export function stopAutoSync() {
  if (autoSyncInterval) { clearInterval(autoSyncInterval); autoSyncInterval = null; }
}

export async function clearOfflineData(householdId) {
  if (!householdId) return;
  await clearHouseholdData(householdId);
  notifyStatus();
}
