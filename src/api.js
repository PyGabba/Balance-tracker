// ─── API Client with household auth ───

import {
  enqueueWrite, fetchAndMergeSnapshot, getCachedEntities, cacheEntityOnly,
  startAutoSync, stopAutoSync, getSyncStatus, onSyncStatusChange as onSyncStatusChangeImpl,
  discardOperation, retryOperation, getFailedOperations, clearOfflineData,
} from "./lib/syncEngine.js";

// Production: always use relative paths so Vercel proxy forwards /api/* to Render (same-origin, Safari-safe)
// Development: use VITE_API_URL or fall back to localhost
const API_BASE = import.meta.env.PROD ? "" : (import.meta.env.VITE_API_URL || "http://localhost:3001");

let apiAvailable = null;
let currentHousehold = null; // { householdId, nome, persone }

// Fresh context for the sync engine on every call (never a stale closure —
// currentHousehold can change between login/logout during the app's life).
function syncCtx() {
  return { apiBase: API_BASE, householdId: currentHousehold?.householdId || null, authHeaders };
}

// Shared GET path for the four entity types that don't need a special
// two-phase callback (transactions' fetchTransactions above does its own
// thing since it also drives the recurring-transaction generator on load).
// Returns the cached snapshot immediately on any failure/offline; merges
// and re-caches on success (MOD-003: pending local changes always win over
// a stale server value — see mergeServerSnapshot in lib/outboxLogic.js).
async function fetchAndCacheEntities(entityType, path) {
  const cached = await getCachedEntities(syncCtx, entityType);
  if (!(await checkAPI()) || !currentHousehold) return cached;
  try {
    const res = await fetch(`${API_BASE}${path}`, { headers: authHeaders(), credentials: "include" });
    if (await checkAuthError(res)) return cached;
    if (!res.ok) return cached;
    const serverData = await res.json();
    apiAvailable = true;
    return await fetchAndMergeSnapshot(syncCtx, entityType, serverData);
  } catch (err) {
    console.error(`fetch${entityType}:`, err);
    apiAvailable = false;
    return cached;
  }
}

// ─── Session (sessionStorage = clears when app/tab is closed) ───
function saveSession(data) {
  try { sessionStorage.setItem("finanza-session", JSON.stringify(data)); } catch {}
}
function loadSession() {
  try { const raw = sessionStorage.getItem("finanza-session"); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function clearSession() {
  try { sessionStorage.removeItem("finanza-session"); } catch {}
  currentHousehold = null;
}

// ─── Persistent session cache (survives tab close, for fast re-login) ───
const LS_SESSION_KEY = "finanza-persistent-session";
function savePersistentSession(data) {
  try { localStorage.setItem(LS_SESSION_KEY, JSON.stringify(data)); } catch {}
}
function loadPersistentSession() {
  try { const raw = localStorage.getItem(LS_SESSION_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function clearPersistentSession() {
  try { localStorage.removeItem(LS_SESSION_KEY); } catch {}
}

// ─── Device ID (persists across sessions, identifies browser/device) ───
const LS_DEVICE_ID_KEY = "finanza-device-id";
function getDeviceId() {
  try {
    let id = localStorage.getItem(LS_DEVICE_ID_KEY);
    if (!id) {
      id = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      localStorage.setItem(LS_DEVICE_ID_KEY, id);
    }
    return id;
  } catch { return null; }
}

// ─── Init: restore session (sessionStorage first, then persistent) ───
const saved = loadSession() || loadPersistentSession();
if (saved) {
  currentHousehold = saved;
  // Resume the offline outbox immediately on load — this is what makes
  // "closing and reopening the browser doesn't lose pending operations"
  // actually true: a reload alone (no explicit login) must still pick the
  // sync loop back up (MOD-003).
  startAutoSync(syncCtx);
}

// ─── API check (non-blocking: returns cached result immediately if known) ───
async function checkAPI() {
  if (apiAvailable !== null) return apiAvailable;
  try {
    const res = await fetch(`${API_BASE}/api/health`, { credentials: "include", signal: AbortSignal.timeout(4000) });
    apiAvailable = res.ok;
  } catch { apiAvailable = false; }
  return apiAvailable;
}

// ─── Background API wakeup: fire-and-forget ping to warm up Render ───
export function wakeupServer() {
  fetch(`${API_BASE}/api/health`, { credentials: "include", signal: AbortSignal.timeout(30000) })
    .then(r => { if (r.ok) apiAvailable = true; })
    .catch(() => {});
}

function authHeaders() {
  return { "Content-Type": "application/json" };
}

// Extracts a human-readable message from either error shape the API can
// return: the older `{ error: "text" }` (most endpoints, for now) or the
// newer `{ error: { code, message, fields } }` (MOD-022 — currently the
// authentication gate and the endpoints touched in the security-hardening
// pass). Lets every call site stay agnostic to which shape a given
// endpoint currently returns, and keeps working once more endpoints move
// to the structured shape over time.
function errorMessageFrom(body, fallback) {
  const e = body?.error;
  if (typeof e === "string" && e) return e;
  if (e && typeof e === "object" && typeof e.message === "string" && e.message) return e.message;
  return fallback;
}

// Thrown when the server actually responded but rejected the request
// (validation error, auth, conflict, etc.) for API calls that don't go
// through the offline outbox (lib/syncEngine.js has its own equivalent —
// SyncRejectedError — for the five entity types that do). Distinguished on
// purpose from a genuine network failure: a rejection is NOT an "offline"
// condition and must reach the caller rather than being silently treated
// as success.
export class ApiRequestError extends Error {
  constructor(status, body) {
    const code = body?.error?.code || null;
    const message = (typeof body?.error === "string" ? body.error : body?.error?.message) || `Richiesta non riuscita (${status})`;
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
    this.fields = body?.error?.fields || null;
  }
}

async function parseErrorBody(res) {
  try { return await res.clone().json(); } catch { return null; }
}

// ─── Central auth-error handler ───
// App.jsx registers a callback so any 401/403 from the server forces re-auth
// regardless of which endpoint fired it (positions, categorie, etc.)
let _authErrorCb = null;
export function setAuthErrorHandler(fn) { _authErrorCb = fn; }

async function onAuthError(res) {
  clearSession();
  clearPersistentSession();
  currentHousehold = null;
  apiAvailable = null;
  try {
    const body = await res.clone().json();
    if (_authErrorCb) _authErrorCb(body.error);
  } catch { if (_authErrorCb) _authErrorCb("auth_error"); }
}

// Returns true if the response was an auth error (caller should return early)
async function checkAuthError(res) {
  if (res.status === 401 || res.status === 403) { await onAuthError(res); return true; }
  return false;
}

// (The old localStorage-array transaction fallback that used to live here
// was replaced by the IndexedDB-backed offline outbox — see
// lib/syncEngine.js and lib/offlineDb.js, MOD-003.)

// ─── Auth ───

// Fast login: tries server with 6s timeout. If server is slow/down but a
// cached session with matching PIN hash exists, logs in immediately from cache
// and syncs in background. This eliminates the 10-20s Render cold-start wait.
// ─── Offline PIN verifier (MOD-010) ───
// This value NEVER proves identity to the server — it only gates whether a
// CACHED session can be used while the server is unreachable (cold start,
// outage, no connectivity). The real credential check always happens
// server-side via bcrypt (server/index.js), completely independent of
// this. Threat model: anyone who can read this device's localStorage
// already has meaningful local access, but a PIN is short (commonly 4-6
// digits), so a single fast unsalted hash — what this used to be — lets
// that value be brute-forced offline in well under a second on ordinary
// hardware. PBKDF2 with a per-device random salt and a high iteration
// count raises that cost by roughly the iteration count (hundreds of
// thousands of times), without changing the UX: the legitimate device
// owner's offline-fallback login works exactly the same. A hash written
// before this change won't verify against the new format — that's fine,
// it just means the offline-fallback path is unavailable until the next
// successful online login rewrites it (savePinHash runs on every login,
// register, and PIN change), which happens transparently.
const LS_PIN_HASH_KEY = "finanza-pin-hash";
const LS_PIN_SALT_KEY = "finanza-pin-salt";
const PIN_KDF_ITERATIONS = 250000;

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}
function getOrCreatePinSalt() {
  try {
    let saltHex = localStorage.getItem(LS_PIN_SALT_KEY);
    if (!saltHex) {
      saltHex = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
      localStorage.setItem(LS_PIN_SALT_KEY, saltHex);
    }
    return saltHex;
  } catch { return null; }
}
async function derivePinVerifier(pin, saltHex) {
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: hexToBytes(saltHex), iterations: PIN_KDF_ITERATIONS, hash: "SHA-256" },
    keyMaterial, 256
  );
  return bytesToHex(new Uint8Array(bits));
}
function savePinHash(pin) {
  const salt = getOrCreatePinSalt();
  if (!salt) return;
  derivePinVerifier(pin, salt)
    .then(h => { try { localStorage.setItem(LS_PIN_HASH_KEY, h); } catch {} })
    .catch(err => console.error("savePinHash:", err));
}
async function checkPinMatchesCache(pin) {
  try {
    const stored = localStorage.getItem(LS_PIN_HASH_KEY);
    const salt = localStorage.getItem(LS_PIN_SALT_KEY);
    if (!stored || !salt) return false;
    return (await derivePinVerifier(pin, salt)) === stored;
  } catch { return false; }
}

export async function login(pin) {
  // Check if we have a cached session we can fall back to
  const cached = loadPersistentSession();
  const hasCacheForFallback = cached && !!(await checkPinMatchesCache(pin).catch(() => false));

  // Use longer timeout when there's no cache fallback (first login / after logout)
  const timeoutMs = hasCacheForFallback ? 6000 : 20000;

  // Race: server login vs timeout
  let serverResult = null;
  let serverError = null;
  try {
    const res = await fetch(`${API_BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ pin, deviceId: getDeviceId() }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) {
      serverResult = await res.json();
    } else {
      const err = await res.json().catch(() => ({}));
      serverError = new Error(errorMessageFrom(err, "Login fallito"));
    }
  } catch (err) {
    // Translate AbortError into a readable message
    if (err.name === "AbortError" || err.name === "TimeoutError") {
      serverError = new Error("Server in avvio, riprova tra qualche secondo");
    } else {
      serverError = err;
    }
  }

  if (serverResult) {
    const { token: _token, ...sessionData } = serverResult; // token is in httpOnly cookie, not stored in JS
    currentHousehold = sessionData;
    saveSession(sessionData);
    savePersistentSession(sessionData);
    savePinHash(pin);
    apiAvailable = true;
    startAutoSync(syncCtx);
    return sessionData;
  }

  // Server failed or timed out: try cached session if PIN matches
  if (hasCacheForFallback) {
    currentHousehold = cached;
    saveSession(cached);
    apiAvailable = false;
    wakeupServer();
    startAutoSync(syncCtx); // will pick up any pending outbox ops once connectivity actually returns
    return { ...cached, _fromCache: true };
  }

  // No cache or wrong PIN
  throw serverError || new Error("Login fallito");
}

export async function register({ nome, persone, pin, email }) {
  const res = await fetch(`${API_BASE}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ nome, persone, pin, email: email || undefined }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(errorMessageFrom(err, "Registrazione fallita"));
  }
  const raw = await res.json();
  const { token: _token, ...data } = raw; // token is in httpOnly cookie
  currentHousehold = data;
  saveSession(data);
  savePersistentSession(data);
  savePinHash(pin);
  apiAvailable = true;
  startAutoSync(syncCtx);
  return data;
}

// ─── Recupero PIN dimenticato ───
export async function requestPinReset(email) {
  let res;
  try {
    res = await fetch(`${API_BASE}/api/auth/forgot-pin/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    if (err.name === "AbortError" || err.name === "TimeoutError") throw new Error("Il server non risponde, riprova tra qualche secondo");
    throw err;
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(errorMessageFrom(json, "Richiesta fallita"));
  return json;
}

export async function confirmPinReset({ email, code, newPin }) {
  let res;
  try {
    res = await fetch(`${API_BASE}/api/auth/forgot-pin/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ email, code, newPin }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    if (err.name === "AbortError" || err.name === "TimeoutError") throw new Error("Il server non risponde, riprova tra qualche secondo");
    throw err;
  }
  const raw = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(errorMessageFrom(raw, "Reimpostazione fallita"));
  const { token: _token, ...sessionData } = raw; // token is in httpOnly cookie
  currentHousehold = sessionData;
  saveSession(sessionData);
  savePersistentSession(sessionData);
  savePinHash(newPin);
  apiAvailable = true;
  return sessionData;
}

export async function setRecoveryEmail(email) {
  const res = await fetch(`${API_BASE}/api/auth/recovery-email`, {
    method: "PUT", headers: authHeaders(), credentials: "include", body: JSON.stringify({ email }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(errorMessageFrom(json, "Errore"));
  return json;
}

export async function fetchHousehold() {
  const res = await fetch(`${API_BASE}/api/household`, { headers: authHeaders(), credentials: "include" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`HTTP ${res.status}${body.error ? " — " + body.error : ""}`);
  }
  return await res.json();
}

export async function updateValutaBase(valutaBase) {
  const res = await fetch(`${API_BASE}/api/household/valuta`, {
    method: "PUT", headers: authHeaders(), credentials: "include", body: JSON.stringify({ valutaBase }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(errorMessageFrom(json, "Errore"));
  if (currentHousehold) {
    currentHousehold = { ...currentHousehold, valutaBase: json.valutaBase };
    saveSession(currentHousehold);
    savePersistentSession(currentHousehold);
  }
  return json;
}

export async function fetchExchangeRates() {
  const res = await fetch(`${API_BASE}/api/exchange-rates`, { headers: authHeaders(), credentials: "include" });
  if (!res.ok) throw new Error("Errore tassi di cambio");
  return await res.json();
}

export async function changePin(newPin) {
  const res = await fetch(`${API_BASE}/api/auth/pin`, {
    method: "PUT",
    headers: authHeaders(),
    credentials: "include",
    body: JSON.stringify({ newPin }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(errorMessageFrom(err, "Aggiornamento PIN fallito"));
  }
  savePinHash(newPin);
  if (currentHousehold) {
    currentHousehold = { ...currentHousehold, requiresPinChange: false };
    saveSession(currentHousehold);
    savePersistentSession(currentHousehold);
  }
  return true;
}

export async function logout() {
  // Best-effort server-side token revocation
  try {
    await fetch(`${API_BASE}/api/auth/logout`, {
      method: "POST",
      headers: authHeaders(),
      credentials: "include",
      signal: AbortSignal.timeout(5000),
    });
  } catch {}
  // Stop the background sync loop, but deliberately leave any queued
  // offline outbox data in IndexedDB — logging out is not "this household
  // no longer exists" (see deleteHousehold below for that case), and a
  // pending operation must survive a logout/login cycle just as it
  // survives a browser restart (MOD-003).
  stopAutoSync();
  clearSession();
  clearPersistentSession();
  try { localStorage.removeItem(LS_PIN_HASH_KEY); } catch {}
  apiAvailable = null;
  currentHousehold = null;
}

export function getSession() {
  return currentHousehold;
}

export function isLoggedIn() {
  return !!currentHousehold;
}

export function getPersone() {
  return currentHousehold?.persone || [];
}

export function getHouseholdName() {
  return currentHousehold?.nome || "";
}

// ─── Transactions ───
// Routed through the offline outbox (MOD-003) — see lib/syncEngine.js.
// Returns cached (IndexedDB) data immediately, then syncs from server in
// background. Pass onSync callback to update UI when the merged server
// snapshot arrives.
// ─── Transactions ───
// Routed through the offline outbox (MOD-003) — see lib/syncEngine.js.
// Returns cached (IndexedDB) data immediately, then syncs from server in
// background. Pass onSync callback to update UI when the merged server
// snapshot arrives.
//
// MOD-006: the server now paginates (cursor-based). Statistics, search,
// and the outbox's mergeServerSnapshot all rely on the local cache holding
// the household's FULL history, so this drains every page rather than
// exposing pagination up to callers — the fix for "500-transaction limit
// while the frontend supports all-history views" is that the limit no
// longer silently truncates what ends up in that cache, not that every
// caller now has to think about pages.
async function fetchAllTransactionPages() {
  let all = [];
  let cursor = null;
  let guard = 0;
  do {
    const params = new URLSearchParams({ limit: "1000" });
    if (cursor) params.set("cursor", cursor);
    const res = await fetch(`${API_BASE}/api/transactions?${params.toString()}`, {
      headers: authHeaders(), credentials: "include", signal: AbortSignal.timeout(15000),
    });
    if (await checkAuthError(res)) return null;
    if (!res.ok) return null;
    const page = await res.json();
    all = all.concat(page.transactions || []);
    cursor = page.hasMore ? page.nextCursor : null;
    guard++;
  } while (cursor && guard < 200); // 200 pages * 1000 = 200k transactions safety cap against a runaway loop
  return all;
}

export async function fetchTransactions(onSync) {
  const cached = await getCachedEntities(syncCtx, "transactions");
  if (currentHousehold && apiAvailable !== false) {
    (async () => {
      try {
        const all = await fetchAllTransactionPages();
        if (all == null) return; // auth error or a page request failed — background sync already logged/handled it
        apiAvailable = true;
        const merged = await fetchAndMergeSnapshot(syncCtx, "transactions", all);
        if (onSync) onSync(merged);
      } catch (err) {
        console.error("fetchTransactions (background sync):", err);
        apiAvailable = false;
      }
    })();
  }
  return cached;
}

export async function addTransaction(tx) {
  return enqueueWrite(syncCtx, { entityType: "transactions", operation: "create", payload: tx });
}

export async function deleteTransaction(id) {
  return enqueueWrite(syncCtx, { entityType: "transactions", operation: "delete", entityId: id, payload: null });
}

export async function fetchTrash() {
  if (!(await checkAPI()) || !currentHousehold) return [];
  try {
    const res = await fetch(`${API_BASE}/api/transactions/trash`, { headers: authHeaders(), credentials: "include" });
    if (!res.ok) throw new Error(res.status);
    return await res.json();
  } catch (err) {
    console.error("fetchTrash:", err);
    return [];
  }
}

export async function restoreTransaction(id) {
  const res = await fetch(`${API_BASE}/api/transactions/${id}/restore`, { method: "POST", headers: authHeaders(), credentials: "include" });
  if (!res.ok) throw new Error(res.status);
  return await res.json();
}

export async function permanentDeleteTransaction(id) {
  const res = await fetch(`${API_BASE}/api/transactions/${id}/permanent`, { method: "DELETE", headers: authHeaders(), credentials: "include" });
  if (!res.ok) throw new Error(res.status);
  return true;
}

export async function emptyTrash() {
  const res = await fetch(`${API_BASE}/api/transactions/trash/empty`, { method: "DELETE", headers: authHeaders(), credentials: "include" });
  if (!res.ok) throw new Error(res.status);
  return await res.json();
}

export async function updateTransaction(id, updates) {
  return enqueueWrite(syncCtx, { entityType: "transactions", operation: "update", entityId: id, payload: updates });
}

export function isAPIConnected() {
  return apiAvailable === true;
}

export function resetAPICheck() {
  apiAvailable = null;
}

// ─── Offline outbox status (MOD-003) — for a sync indicator in the UI ───
export async function fetchSyncStatus() {
  return getSyncStatus(currentHousehold?.householdId);
}
export function onSyncStatusChange(cb) {
  return onSyncStatusChangeImpl(cb);
}
export async function fetchFailedSyncOperations() {
  return getFailedOperations(currentHousehold?.householdId);
}
export async function discardSyncOperation(operationId) {
  return discardOperation(currentHousehold?.householdId, operationId);
}
export async function retrySyncOperation(operationId) {
  return retryOperation(syncCtx, operationId);
}

export async function deleteHousehold(pin) {
  const res = await fetch(`${API_BASE}/api/auth/household`, {
    method: "DELETE",
    headers: authHeaders(),
    credentials: "include",
    body: JSON.stringify({ pin }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(errorMessageFrom(err, "Eliminazione fallita"));
  }
  // The household is gone server-side, so any offline outbox entries still
  // queued for it are now moot garbage rather than "pending" — clear them
  // rather than have them sit around retrying forever against an account
  // that no longer exists.
  stopAutoSync();
  await clearOfflineData(currentHousehold?.householdId);
  return true;
}

// ─── Stock Positions ─── (MOD-003: routed through the offline outbox; no update endpoint exists for positions)
export async function fetchPositions() {
  return fetchAndCacheEntities("positions", "/api/positions");
}

export async function addPosition(pos) {
  return enqueueWrite(syncCtx, { entityType: "positions", operation: "create", payload: pos });
}

export async function deletePosition(id) {
  return enqueueWrite(syncCtx, { entityType: "positions", operation: "delete", entityId: id, payload: null });
}

// ─── Custom Categories ───
// Stored in the household session — populated on login, updated on change.
// Dynamic households: persisted in the household document in MongoDB.
// Static households: persisted in a separate categorie collection.

export function getCategorieUscita() {
  return currentHousehold?.categorieUscita || null;
}

export async function fetchCategorie() {
  if (!currentHousehold) return null;
  try {
    const res = await fetch(`${API_BASE}/api/categorie`, {
      headers: authHeaders(),
      credentials: "include",
      signal: AbortSignal.timeout(10000),
    });
    if (await checkAuthError(res)) return null;
    if (res.ok) {
      const data = await res.json();
      if (data.categorie) {
        currentHousehold = { ...currentHousehold, categorieUscita: data.categorie };
        saveSession(currentHousehold);
        savePersistentSession(currentHousehold);
        return data.categorie;
      }
    }
  } catch {}
  return currentHousehold.categorieUscita || null;
}

export async function saveCategorie(cats) {
  if (!currentHousehold) return;
  // Update session immediately (optimistic)
  currentHousehold = { ...currentHousehold, categorieUscita: cats };
  saveSession(currentHousehold);
  savePersistentSession(currentHousehold);
  // Persist to server
  try {
    await fetch(`${API_BASE}/api/categorie`, {
      method: "PUT",
      headers: authHeaders(),
      credentials: "include",
      body: JSON.stringify({ categorie: cats }),
      signal: AbortSignal.timeout(20000),
    });
  } catch {}
}

export async function fetchManualPrices() {
  if (!currentHousehold) return {};
  try {
    const res = await fetch(`${API_BASE}/api/positions/prices`, {
      headers: authHeaders(),
      credentials: "include",
      signal: AbortSignal.timeout(10000),
    });
    if (await checkAuthError(res)) return {};
    if (res.ok) return (await res.json()).manualPrices || {};
  } catch {}
  return {};
}

export async function saveManualPricesRemote(prices) {
  if (!currentHousehold) return;
  try {
    await fetch(`${API_BASE}/api/positions/prices`, {
      method: "PUT",
      headers: authHeaders(),
      credentials: "include",
      body: JSON.stringify({ manualPrices: prices }),
      signal: AbortSignal.timeout(10000),
    });
  } catch {}
}

// fetchQuotes removed — Yahoo API disabled, use manual prices only

// ─── Savings Goals ─── (MOD-003: routed through the offline outbox)
export async function fetchGoals() {
  return fetchAndCacheEntities("goals", "/api/goals");
}

export async function addGoal(goal) {
  return enqueueWrite(syncCtx, { entityType: "goals", operation: "create", payload: goal });
}

export async function updateGoal(id, updates) {
  return enqueueWrite(syncCtx, { entityType: "goals", operation: "update", entityId: id, payload: updates });
}

export async function deleteGoal(id) {
  return enqueueWrite(syncCtx, { entityType: "goals", operation: "delete", entityId: id, payload: null });
}

// ─── Categorie viaggi (sincronizzate) ───
export async function fetchTripCategories() {
  if (await checkAPI() && currentHousehold) {
    try {
      const res = await fetch(`${API_BASE}/api/trip-categories`, { headers: authHeaders(), credentials: "include" });
      if (await checkAuthError(res)) return null;
      if (!res.ok) throw new Error(res.status);
      const json = await res.json();
      return json.categorie || null;
    } catch (err) { console.error("fetchTripCategories:", err); }
  }
  return null;
}

export async function saveTripCategories(categorie) {
  if (await checkAPI() && currentHousehold) {
    try {
      const res = await fetch(`${API_BASE}/api/trip-categories`, {
        method: "PUT", headers: authHeaders(), credentials: "include", body: JSON.stringify({ categorie }),
      });
      if (!res.ok) throw new Error(res.status);
      return true;
    } catch (err) { console.error("saveTripCategories:", err); }
  }
  return false;
}

// ─── Widget key ───
export async function createWidgetKey() {
  const res = await fetch(`${API_BASE}/api/widget-key`, { method: "POST", headers: authHeaders(), credentials: "include" });
  if (!res.ok) throw new Error("Errore " + res.status);
  const json = await res.json();
  return json.key;
}

export async function revokeWidgetKey() {
  const res = await fetch(`${API_BASE}/api/widget-key`, { method: "DELETE", headers: authHeaders(), credentials: "include" });
  if (!res.ok) throw new Error("Errore " + res.status);
  return true;
}

export async function createCalendarKey() {
  const res = await fetch(`${API_BASE}/api/calendar-key`, { method: "POST", headers: authHeaders(), credentials: "include" });
  if (!res.ok) throw new Error("Errore " + res.status);
  const json = await res.json();
  return json.key;
}

export async function revokeCalendarKey() {
  const res = await fetch(`${API_BASE}/api/calendar-key`, { method: "DELETE", headers: authHeaders(), credentials: "include" });
  if (!res.ok) throw new Error("Errore " + res.status);
  return true;
}

export function getApiBase() { return API_BASE || window.location.origin; }

// ─── Backup completo ───
export async function downloadBackup() {
  if (await checkAPI() && currentHousehold) {
    const res = await fetch(`${API_BASE}/api/backup`, { headers: authHeaders(), credentials: "include" });
    if (!res.ok) throw new Error("Errore " + res.status);
    return await res.json();
  }
  throw new Error("Server non raggiungibile");
}

export async function restoreBackup(data) {
  if (await checkAPI() && currentHousehold) {
    const res = await fetch(`${API_BASE}/api/backup/restore`, {
      method: "POST", headers: authHeaders(), credentials: "include", body: JSON.stringify(data),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(errorMessageFrom(json, "Errore " + res.status));
    return json;
  }
  throw new Error("Server non raggiungibile");
}

// ─── Accounts (conti) ─── (MOD-003: routed through the offline outbox)
export async function fetchAccounts() {
  return fetchAndCacheEntities("accounts", "/api/accounts");
}

export async function addAccount(account) {
  return enqueueWrite(syncCtx, { entityType: "accounts", operation: "create", payload: account });
}

export async function updateAccount(id, updates) {
  return enqueueWrite(syncCtx, { entityType: "accounts", operation: "update", entityId: id, payload: updates });
}

export async function deleteAccount(id) {
  return enqueueWrite(syncCtx, { entityType: "accounts", operation: "delete", entityId: id, payload: null });
}

// ─── Trips API ───
// MOD-003: trip create/update/delete routed through the offline outbox,
// same as the other four entity types. Trip EXPENSES are sub-document
// writes inside a trip's `expenses` array rather than their own top-level
// entity, so they are NOT yet covered by the generic per-entity outbox —
// an expense added while offline is cached locally for display but isn't
// durably queued for later sync (same limitation the old implementation
// had; extending the outbox to sub-document operations is follow-up work).
export async function fetchTrips() {
  return fetchAndCacheEntities("trips", "/api/trips");
}

export async function addTrip(trip) {
  return enqueueWrite(syncCtx, { entityType: "trips", operation: "create", payload: { ...trip, expenses: [], settled: false } });
}

export async function updateTrip(id, updates) {
  return enqueueWrite(syncCtx, { entityType: "trips", operation: "update", entityId: id, payload: updates });
}

export async function deleteTrip(id) {
  return enqueueWrite(syncCtx, { entityType: "trips", operation: "delete", entityId: id, payload: null });
}

export async function addTripExpense(tripId, expense) {
  if (currentHousehold) {
    try {
      const res = await fetch(`${API_BASE}/api/trips/${tripId}/expenses`, {
        method: "POST", headers: authHeaders(), credentials: "include", body: JSON.stringify(expense), signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        apiAvailable = true;
        const newExp = await res.json();
        const trip = (await getCachedEntities(syncCtx, "trips")).find(t => t.id === tripId);
        if (trip) await cacheEntityOnly(syncCtx, "trips", { ...trip, expenses: [...(trip.expenses || []), newExp] });
        return newExp;
      }
    } catch (err) { console.error("addTripExpense:", err); }
  }
  const localExp = { id: `local:${Date.now().toString(36)}`, ...expense };
  const trip = (await getCachedEntities(syncCtx, "trips")).find(t => t.id === tripId);
  if (trip) await cacheEntityOnly(syncCtx, "trips", { ...trip, expenses: [...(trip.expenses || []), localExp] });
  return localExp;
}

export async function deleteTripExpense(tripId, expenseId) {
  if (currentHousehold) {
    try {
      const res = await fetch(`${API_BASE}/api/trips/${tripId}/expenses/${expenseId}`, {
        method: "DELETE", headers: authHeaders(), credentials: "include", signal: AbortSignal.timeout(10000),
      });
      if (res.ok) apiAvailable = true;
    } catch (err) { console.error("deleteTripExpense:", err); }
  }
  const trip = (await getCachedEntities(syncCtx, "trips")).find(t => t.id === tripId);
  if (trip) await cacheEntityOnly(syncCtx, "trips", { ...trip, expenses: (trip.expenses || []).filter(e => e.id !== expenseId) });
  return true;
}

// ─── Trip share links (owner side, authenticated) ───
export async function createTripShareLink(tripId) {
  const res = await fetch(`${API_BASE}/api/trips/${tripId}/share`, { method: "POST", headers: authHeaders(), credentials: "include" });
  if (!res.ok) throw new Error(errorMessageFrom(await res.json().catch(() => ({})), String(res.status)));
  const { token } = await res.json();
  const trip = (await getCachedEntities(syncCtx, "trips")).find(t => t.id === tripId);
  if (trip) await cacheEntityOnly(syncCtx, "trips", { ...trip, shareToken: token });
  return token;
}

export async function revokeTripShareLink(tripId) {
  const res = await fetch(`${API_BASE}/api/trips/${tripId}/share`, { method: "DELETE", headers: authHeaders(), credentials: "include" });
  if (!res.ok) throw new Error(res.status);
  const trip = (await getCachedEntities(syncCtx, "trips")).find(t => t.id === tripId);
  if (trip) await cacheEntityOnly(syncCtx, "trips", { ...trip, shareToken: undefined });
  return true;
}

// ─── Trip share links (guest side, unauthenticated — no household session at all) ───
export async function fetchSharedTrip(token) {
  const res = await fetch(`${API_BASE}/api/trips/shared/${token}`);
  if (!res.ok) throw new Error(errorMessageFrom(await res.json().catch(() => ({})), String(res.status)));
  return await res.json();
}

export async function joinSharedTrip(token, nome) {
  const res = await fetch(`${API_BASE}/api/trips/shared/${token}/join`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nome }),
  });
  if (!res.ok) throw new Error(errorMessageFrom(await res.json().catch(() => ({})), String(res.status)));
  return await res.json();
}

export async function addSharedTripExpense(token, expense) {
  const res = await fetch(`${API_BASE}/api/trips/shared/${token}/expenses`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(expense),
  });
  if (!res.ok) throw new Error(errorMessageFrom(await res.json().catch(() => ({})), String(res.status)));
  return await res.json();
}
