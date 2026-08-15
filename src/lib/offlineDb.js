// ─── IndexedDB adapter (MOD-003) ───
// Thin promise wrapper around IndexedDB. Deliberately dumb: no business
// rules live here (those are in outboxLogic.js) — just get/put/delete for
// each store, scoped by householdId so switching households on the same
// device/browser can't see each other's cached data.
//
// One fixed database shared by every household on this device; every
// record and outbox entry carries a `householdId` field and reads are
// filtered to the current one via an index.

import { ENTITY_TYPES } from "./outboxLogic.js";

const DB_NAME = "balance-tracker-offline";
const DB_VERSION = 1;
const OUTBOX_STORE = "outbox";
const META_STORE = "meta";

function supportsIndexedDb() {
  return typeof indexedDB !== "undefined";
}

let dbPromise = null;
function openDb() {
  if (!supportsIndexedDb()) return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const type of ENTITY_TYPES) {
        if (!db.objectStoreNames.contains(type)) {
          const store = db.createObjectStore(type, { keyPath: "id" });
          store.createIndex("householdId", "householdId");
        }
      }
      if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
        const store = db.createObjectStore(OUTBOX_STORE, { keyPath: "operationId" });
        store.createIndex("householdId", "householdId");
        store.createIndex("createdAt", "createdAt");
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch(err => {
    console.error("offlineDb: failed to open IndexedDB", err);
    dbPromise = null;
    return null;
  });
  return dbPromise;
}

function promisifyRequest(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(storeName, mode, fn) {
  const db = await openDb();
  if (!db) return null; // IndexedDB unavailable (very old browser, private-mode restriction, etc.) — caller falls back gracefully
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let result;
    Promise.resolve(fn(store))
      .then(r => { result = r; })
      .catch(reject);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
  });
}

// ─── Entity stores (transactions/accounts/goals/trips/positions) ───

export async function getAllEntities(entityType, householdId) {
  const rows = await withStore(entityType, "readonly", (store) =>
    promisifyRequest(store.index("householdId").getAll(IDBKeyRange.only(householdId)))
  );
  return rows || [];
}

export async function putEntity(entityType, householdId, entity) {
  return withStore(entityType, "readwrite", (store) => promisifyRequest(store.put({ ...entity, householdId })));
}

export async function putEntities(entityType, householdId, entities) {
  return withStore(entityType, "readwrite", (store) => {
    for (const e of entities) store.put({ ...e, householdId });
  });
}

export async function deleteEntity(entityType, id) {
  return withStore(entityType, "readwrite", (store) => promisifyRequest(store.delete(id)));
}

// Replaces the full cached snapshot for a household's entity collection —
// used after mergeServerSnapshot produces the authoritative merged list.
export async function replaceAllEntities(entityType, householdId, entities) {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(entityType, "readwrite");
    const store = tx.objectStore(entityType);
    const idx = store.index("householdId");
    const cursorReq = idx.openCursor(IDBKeyRange.only(householdId));
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) { cursor.delete(); cursor.continue(); }
      else { for (const e of entities) store.put({ ...e, householdId }); }
    };
    cursorReq.onerror = () => reject(cursorReq.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ─── Outbox ───

export async function getOutboxOps(householdId) {
  const rows = await withStore(OUTBOX_STORE, "readonly", (store) =>
    promisifyRequest(store.index("householdId").getAll(IDBKeyRange.only(householdId)))
  );
  return rows || [];
}

export async function putOutboxOp(op) {
  return withStore(OUTBOX_STORE, "readwrite", (store) => promisifyRequest(store.put(op)));
}

export async function putOutboxOps(ops) {
  return withStore(OUTBOX_STORE, "readwrite", (store) => { for (const op of ops) store.put(op); });
}

export async function deleteOutboxOp(operationId) {
  return withStore(OUTBOX_STORE, "readwrite", (store) => promisifyRequest(store.delete(operationId)));
}

// Replaces the full outbox for a household in one transaction — used after
// compaction/promotion produce a new authoritative outbox array, so partial
// writes can't leave stale entries behind.
export async function replaceOutbox(householdId, ops) {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OUTBOX_STORE, "readwrite");
    const store = tx.objectStore(OUTBOX_STORE);
    const idx = store.index("householdId");
    const cursorReq = idx.openCursor(IDBKeyRange.only(householdId));
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) { cursor.delete(); cursor.continue(); }
      else { for (const op of ops) store.put(op); }
    };
    cursorReq.onerror = () => reject(cursorReq.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ─── Meta (id aliases, last-synced timestamps) ───

function metaKey(householdId, key) { return `${householdId}:${key}`; }

export async function getMeta(householdId, key, fallback = null) {
  const row = await withStore(META_STORE, "readonly", (store) => promisifyRequest(store.get(metaKey(householdId, key))));
  return row ? row.value : fallback;
}

export async function setMeta(householdId, key, value) {
  return withStore(META_STORE, "readwrite", (store) => promisifyRequest(store.put({ key: metaKey(householdId, key), value })));
}

// Clears every store for a household — used on logout / delete-household so
// the next login (possibly a different household on a shared device)
// starts clean.
export async function clearHouseholdData(householdId) {
  for (const type of ENTITY_TYPES) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await getAllEntities(type, householdId);
    // eslint-disable-next-line no-await-in-loop
    await withStore(type, "readwrite", (store) => { for (const r of rows) store.delete(r.id); });
  }
  await replaceOutbox(householdId, []);
  const db = await openDb();
  if (!db) return;
  const keys = await withStore(META_STORE, "readonly", (store) => promisifyRequest(store.getAllKeys()));
  const toDelete = (keys || []).filter(k => k.startsWith(`${householdId}:`));
  if (toDelete.length) await withStore(META_STORE, "readwrite", (store) => { for (const k of toDelete) store.delete(k); });
}
