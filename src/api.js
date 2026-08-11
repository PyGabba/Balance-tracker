// ─── API Client with household auth ───

// Production: always use relative paths so Vercel proxy forwards /api/* to Render (same-origin, Safari-safe)
// Development: use VITE_API_URL or fall back to localhost
const API_BASE = import.meta.env.PROD ? "" : (import.meta.env.VITE_API_URL || "http://localhost:3001");

let apiAvailable = null;
let currentHousehold = null; // { householdId, nome, persone }

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
if (saved) currentHousehold = saved;

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

// ─── localStorage fallback (scoped by household) ───
function lsKey() {
  return `finanza-tx-${currentHousehold?.householdId || "default"}`;
}
function lsLoad() {
  try { const raw = localStorage.getItem(lsKey()); return raw ? JSON.parse(raw) : []; } catch { return []; }
}
function lsSave(txs) {
  try { localStorage.setItem(lsKey(), JSON.stringify(txs)); } catch {}
}

// ─── Auth ───

// Fast login: tries server with 6s timeout. If server is slow/down but a
// cached session with matching PIN hash exists, logs in immediately from cache
// and syncs in background. This eliminates the 10-20s Render cold-start wait.
const LS_PIN_HASH_KEY = "finanza-pin-hash";
async function hashPin(pin) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pin));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}
function savePinHash(pin) {
  hashPin(pin).then(h => { try { localStorage.setItem(LS_PIN_HASH_KEY, h); } catch {} });
}
async function checkPinMatchesCache(pin) {
  try {
    const stored = localStorage.getItem(LS_PIN_HASH_KEY);
    if (!stored) return false;
    return (await hashPin(pin)) === stored;
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
      serverError = new Error(err.error || "Login fallito");
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
    return sessionData;
  }

  // Server failed or timed out: try cached session if PIN matches
  if (hasCacheForFallback) {
    currentHousehold = cached;
    saveSession(cached);
    apiAvailable = false;
    wakeupServer();
    return { ...cached, _fromCache: true };
  }

  // No cache or wrong PIN
  throw serverError || new Error("Login fallito");
}

export async function register({ nome, persone, pin }) {
  const res = await fetch(`${API_BASE}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ nome, persone, pin }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || "Registrazione fallita");
  }
  const raw = await res.json();
  const { token: _token, ...data } = raw; // token is in httpOnly cookie
  currentHousehold = data;
  saveSession(data);
  savePersistentSession(data);
  savePinHash(pin);
  apiAvailable = true;
  return data;
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
    throw new Error(err.error || "Aggiornamento PIN fallito");
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

// Returns localStorage data immediately (fast), then syncs from server in background.
// Pass onSync callback to update UI when background sync completes.
export async function fetchTransactions(onSync) {
  const localData = lsLoad();

  // If we know API is up (or unknown), try to sync in background
  if (currentHousehold) {
    const syncFromServer = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/transactions`, {
          headers: authHeaders(),
          credentials: "include",
          signal: AbortSignal.timeout(15000),
        });
        if (await checkAuthError(res)) return;
        if (!res.ok) return;
        const serverData = await res.json();
        apiAvailable = true;
        lsSave(serverData);
        if (onSync) onSync(serverData);
      } catch {
        apiAvailable = false;
      }
    };

    if (apiAvailable === false) {
      // Known offline: just return local, no background attempt
    } else {
      // Unknown or online: sync in background without blocking
      syncFromServer();
    }
  }

  return localData;
}

export async function addTransaction(tx) {
  if (await checkAPI() && currentHousehold) {
    try {
      const res = await fetch(`${API_BASE}/api/transactions`, {
        method: "POST", headers: authHeaders(), credentials: "include", body: JSON.stringify(tx),
      });
      if (!res.ok) throw new Error(res.status);
      return await res.json();
    } catch (err) {
      console.error("addTransaction:", err);
      apiAvailable = false;
    }
  }
  const all = lsLoad();
  const newTx = { ...tx, id: tx.id || Date.now().toString(36) + Math.random().toString(36).slice(2, 7) };
  all.push(newTx);
  lsSave(all);
  return newTx;
}

export async function deleteTransaction(id) {
  if (await checkAPI() && currentHousehold) {
    try {
      const res = await fetch(`${API_BASE}/api/transactions/${id}`, { method: "DELETE", headers: authHeaders(), credentials: "include" });
      if (!res.ok) throw new Error(res.status);
      return true;
    } catch (err) {
      console.error("deleteTransaction:", err);
      apiAvailable = false;
    }
  }
  const all = lsLoad().filter(t => t.id !== id);
  lsSave(all);
  return true;
}

export async function updateTransaction(id, updates) {
  if (await checkAPI() && currentHousehold) {
    try {
      const res = await fetch(`${API_BASE}/api/transactions/${id}`, {
        method: "PUT", headers: authHeaders(), credentials: "include", body: JSON.stringify(updates),
      });
      if (!res.ok) throw new Error(res.status);
      return await res.json();
    } catch (err) {
      console.error("updateTransaction:", err);
      apiAvailable = false;
    }
  }
  const all = lsLoad().map(t => t.id === id ? { ...t, ...updates } : t);
  lsSave(all);
  return all.find(t => t.id === id);
}

export function isAPIConnected() {
  return apiAvailable === true;
}

export function resetAPICheck() {
  apiAvailable = null;
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
    throw new Error(err.error || "Eliminazione fallita");
  }
  return true;
}

// ─── Stock Positions ───
export async function fetchPositions() {
  if (await checkAPI() && currentHousehold) {
    try {
      const res = await fetch(`${API_BASE}/api/positions`, { headers: authHeaders(), credentials: "include" });
      if (await checkAuthError(res)) return [];
      if (!res.ok) throw new Error(res.status);
      return await res.json();
    } catch (err) { console.error("fetchPositions:", err); }
  }
  return [];
}

export async function addPosition(pos) {
  if (await checkAPI() && currentHousehold) {
    try {
      const res = await fetch(`${API_BASE}/api/positions`, {
        method: "POST", headers: authHeaders(), credentials: "include", body: JSON.stringify(pos),
      });
      if (!res.ok) throw new Error(res.status);
      return await res.json();
    } catch (err) { console.error("addPosition:", err); }
  }
  return { ...pos, id: Date.now().toString(36) };
}

export async function deletePosition(id) {
  if (await checkAPI() && currentHousehold) {
    try {
      const res = await fetch(`${API_BASE}/api/positions/${id}`, { method: "DELETE", headers: authHeaders(), credentials: "include" });
      if (!res.ok) throw new Error(res.status);
      return true;
    } catch (err) { console.error("deletePosition:", err); }
  }
  return true;
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

// ─── Savings Goals ───
export async function fetchGoals() {
  if (await checkAPI() && currentHousehold) {
    try {
      const res = await fetch(`${API_BASE}/api/goals`, { headers: authHeaders(), credentials: "include" });
      if (await checkAuthError(res)) return [];
      if (!res.ok) throw new Error(res.status);
      return await res.json();
    } catch (err) { console.error("fetchGoals:", err); }
  }
  return [];
}

export async function addGoal(goal) {
  if (await checkAPI() && currentHousehold) {
    try {
      const res = await fetch(`${API_BASE}/api/goals`, {
        method: "POST", headers: authHeaders(), credentials: "include", body: JSON.stringify(goal),
      });
      if (!res.ok) throw new Error(res.status);
      return await res.json();
    } catch (err) { console.error("addGoal:", err); }
  }
  return { id: Date.now().toString(36), ...goal, currentAmount: 0 };
}

export async function updateGoal(id, updates) {
  if (await checkAPI() && currentHousehold) {
    try {
      const res = await fetch(`${API_BASE}/api/goals/${id}`, {
        method: "PUT", headers: authHeaders(), credentials: "include", body: JSON.stringify(updates),
      });
      if (!res.ok) throw new Error(res.status);
      return await res.json();
    } catch (err) { console.error("updateGoal:", err); }
  }
  return { ok: true };
}

export async function deleteGoal(id) {
  if (await checkAPI() && currentHousehold) {
    try {
      const res = await fetch(`${API_BASE}/api/goals/${id}`, {
        method: "DELETE", headers: authHeaders(), credentials: "include",
      });
      if (!res.ok) throw new Error(res.status);
      return true;
    } catch (err) { console.error("deleteGoal:", err); }
  }
  return true;
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
    if (!res.ok) throw new Error(json.error || "Errore " + res.status);
    return json;
  }
  throw new Error("Server non raggiungibile");
}

// ─── Accounts (conti) ───
export async function fetchAccounts() {
  if (await checkAPI() && currentHousehold) {
    try {
      const res = await fetch(`${API_BASE}/api/accounts`, { headers: authHeaders(), credentials: "include" });
      if (await checkAuthError(res)) return [];
      if (!res.ok) throw new Error(res.status);
      return await res.json();
    } catch (err) { console.error("fetchAccounts:", err); }
  }
  return [];
}

export async function addAccount(account) {
  if (await checkAPI() && currentHousehold) {
    try {
      const res = await fetch(`${API_BASE}/api/accounts`, {
        method: "POST", headers: authHeaders(), credentials: "include", body: JSON.stringify(account),
      });
      if (!res.ok) throw new Error(res.status);
      return await res.json();
    } catch (err) { console.error("addAccount:", err); }
  }
  return { id: Date.now().toString(36), ...account };
}

export async function updateAccount(id, updates) {
  if (await checkAPI() && currentHousehold) {
    try {
      const res = await fetch(`${API_BASE}/api/accounts/${id}`, {
        method: "PUT", headers: authHeaders(), credentials: "include", body: JSON.stringify(updates),
      });
      if (!res.ok) throw new Error(res.status);
      return await res.json();
    } catch (err) { console.error("updateAccount:", err); }
  }
  return { ok: true };
}

export async function deleteAccount(id) {
  if (await checkAPI() && currentHousehold) {
    try {
      const res = await fetch(`${API_BASE}/api/accounts/${id}`, {
        method: "DELETE", headers: authHeaders(), credentials: "include",
      });
      if (!res.ok) throw new Error(res.status);
      return true;
    } catch (err) { console.error("deleteAccount:", err); }
  }
  return true;
}

// ─── Trips API ───
let cachedTrips = [];
export async function fetchTrips() {
  if (await checkAPI() && currentHousehold) {
    try {
      const res = await fetch(`${API_BASE}/api/trips`, { headers: authHeaders(), credentials: "include" });
      if (await checkAuthError(res)) return cachedTrips;
      if (!res.ok) throw new Error(res.status);
      cachedTrips = await res.json();
      try { localStorage.setItem("trips", JSON.stringify(cachedTrips)); } catch {}
      return cachedTrips;
    } catch (err) { console.error("fetchTrips:", err); }
  }
  try { cachedTrips = JSON.parse(localStorage.getItem("trips") || "[]"); } catch {}
  return cachedTrips;
}

export async function addTrip(trip) {
  if (currentHousehold) {
    try {
      const res = await fetch(`${API_BASE}/api/trips`, {
        method: "POST", headers: authHeaders(), credentials: "include", body: JSON.stringify(trip), signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        apiAvailable = true;
        const newTrip = await res.json();
        cachedTrips = [newTrip, ...cachedTrips];
        try { localStorage.setItem("trips", JSON.stringify(cachedTrips)); } catch {}
        return newTrip;
      }
    } catch (err) { console.error("addTrip:", err); }
  }
  const localTrip = { id: Date.now().toString(36), ...trip, expenses: [], settled: false };
  cachedTrips = [localTrip, ...cachedTrips];
  try { localStorage.setItem("trips", JSON.stringify(cachedTrips)); } catch {}
  return localTrip;
}

export async function updateTrip(id, updates) {
  if (currentHousehold) {
    try {
      const res = await fetch(`${API_BASE}/api/trips/${id}`, {
        method: "PUT", headers: authHeaders(), credentials: "include", body: JSON.stringify(updates), signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        apiAvailable = true;
        const updated = await res.json();
        cachedTrips = cachedTrips.map(t => t.id === id ? { ...t, ...updated } : t);
        try { localStorage.setItem("trips", JSON.stringify(cachedTrips)); } catch {}
        return updated;
      }
    } catch (err) { console.error("updateTrip:", err); }
  }
  cachedTrips = cachedTrips.map(t => t.id === id ? { ...t, ...updates } : t);
  try { localStorage.setItem("trips", JSON.stringify(cachedTrips)); } catch {}
  return { ok: true };
}

export async function deleteTrip(id) {
  // Always try server first, don't skip if offline
  if (currentHousehold) {
    try {
      const res = await fetch(`${API_BASE}/api/trips/${id}`, {
        method: "DELETE", headers: authHeaders(), credentials: "include", signal: AbortSignal.timeout(10000),
      });
      if (res.ok) apiAvailable = true;
    } catch (err) { console.error("deleteTrip:", err); }
  }
  cachedTrips = cachedTrips.filter(t => t.id !== id);
  try { localStorage.setItem("trips", JSON.stringify(cachedTrips)); } catch {}
  return true;
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
        cachedTrips = cachedTrips.map(t => t.id === tripId ? { ...t, expenses: [...(t.expenses || []), newExp] } : t);
        try { localStorage.setItem("trips", JSON.stringify(cachedTrips)); } catch {}
        return newExp;
      }
    } catch (err) { console.error("addTripExpense:", err); }
  }
  const localExp = { id: Date.now().toString(36), ...expense };
  cachedTrips = cachedTrips.map(t => t.id === tripId ? { ...t, expenses: [...(t.expenses || []), localExp] } : t);
  try { localStorage.setItem("trips", JSON.stringify(cachedTrips)); } catch {}
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
  cachedTrips = cachedTrips.map(t => t.id === tripId ? { ...t, expenses: (t.expenses || []).filter(e => e.id !== expenseId) } : t);
  try { localStorage.setItem("trips", JSON.stringify(cachedTrips)); } catch {}
  return true;
}
