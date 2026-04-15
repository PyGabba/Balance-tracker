// ─── API Client with household auth ───

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:3001";

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

// ─── Init: restore session (sessionStorage first, then persistent) ───
const saved = loadSession() || loadPersistentSession();
if (saved) currentHousehold = saved;

// ─── API check (non-blocking: returns cached result immediately if known) ───
async function checkAPI() {
  if (apiAvailable !== null) return apiAvailable;
  try {
    const res = await fetch(`${API_BASE}/api/health`, { signal: AbortSignal.timeout(4000) });
    apiAvailable = res.ok;
  } catch { apiAvailable = false; }
  return apiAvailable;
}

// ─── Background API wakeup: fire-and-forget ping to warm up Render ───
export function wakeupServer() {
  fetch(`${API_BASE}/api/health`, { signal: AbortSignal.timeout(30000) })
    .then(r => { if (r.ok) apiAvailable = true; })
    .catch(() => {});
}

function authHeaders() {
  const h = { "Content-Type": "application/json" };
  if (currentHousehold?.householdId) h["x-household-id"] = currentHousehold.householdId;
  return h;
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
      body: JSON.stringify({ pin }),
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
    currentHousehold = serverResult;
    saveSession(serverResult);
    savePersistentSession(serverResult);
    savePinHash(pin);
    apiAvailable = true;
    return serverResult;
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
    body: JSON.stringify({ nome, persone, pin }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || "Registrazione fallita");
  }
  const data = await res.json();
  currentHousehold = data;
  saveSession(data);
  savePersistentSession(data);
  savePinHash(pin);
  apiAvailable = true;
  return data;
}

export function logout() {
  clearSession();
  clearPersistentSession();
  try { localStorage.removeItem(LS_PIN_HASH_KEY); } catch {}
  apiAvailable = null;
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
          signal: AbortSignal.timeout(15000),
        });
        if (res.status === 401) { clearSession(); return; }
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
        method: "POST", headers: authHeaders(), body: JSON.stringify(tx),
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
      const res = await fetch(`${API_BASE}/api/transactions/${id}`, { method: "DELETE", headers: authHeaders() });
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
        method: "PUT", headers: authHeaders(), body: JSON.stringify(updates),
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
      const res = await fetch(`${API_BASE}/api/positions`, { headers: authHeaders() });
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
        method: "POST", headers: authHeaders(), body: JSON.stringify(pos),
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
      const res = await fetch(`${API_BASE}/api/positions/${id}`, { method: "DELETE", headers: authHeaders() });
      if (!res.ok) throw new Error(res.status);
      return true;
    } catch (err) { console.error("deletePosition:", err); }
  }
  return true;
}

// ─── Custom Categories ───
const LS_CATEGORIE_KEY_PREFIX = "finanza-categorie-";
function lsCatKey() {
  return `${LS_CATEGORIE_KEY_PREFIX}${currentHousehold?.householdId || "default"}`;
}
export function getCategorieUscita() {
  try {
    const raw = localStorage.getItem(lsCatKey());
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
export function saveCategorieUscita(cats) {
  try { localStorage.setItem(lsCatKey(), JSON.stringify(cats)); } catch {}
}

export async function fetchQuotes(symbols, forceRefresh = false) {
  if (!symbols || symbols.length === 0) return { quotes: {}, cached: false, aggiornamento: " " };
  try {
    const url = `${API_BASE}/api/quotes?symbols=${encodeURIComponent(symbols.join(","))}${forceRefresh ? "&refresh=true" : ""}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(res.status);
    return await res.json(); // { quotes: { TICKER: { prezzo, cambioPct } }, cached, aggiornamento }
  } catch (err) {
    console.error("fetchQuotes:", err);
    return { quotes: {}, cached: false, aggiornamento: " " };
  }
}
