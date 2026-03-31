// ─── API Client with household auth ───

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:3001";

let apiAvailable = null;
let currentHousehold = null; // { householdId, nome, persone }

// ─── Session persistence ───
function saveSession(data) {
  try { localStorage.setItem("finanza-session", JSON.stringify(data)); } catch {}
}
function loadSession() {
  try { const raw = localStorage.getItem("finanza-session"); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function clearSession() {
  try { localStorage.removeItem("finanza-session"); } catch {}
  currentHousehold = null;
}

// ─── Init: restore session ───
const saved = loadSession();
if (saved) currentHousehold = saved;

// ─── API check ───
async function checkAPI() {
  if (apiAvailable !== null) return apiAvailable;
  try {
    const res = await fetch(`${API_BASE}/api/health`, { signal: AbortSignal.timeout(3000) });
    apiAvailable = res.ok;
  } catch { apiAvailable = false; }
  return apiAvailable;
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
export async function login(pin) {
  const res = await fetch(`${API_BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || "Login fallito");
  }
  const data = await res.json();
  currentHousehold = data;
  saveSession(data);
  apiAvailable = true;
  return data;
}

export function logout() {
  clearSession();
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
export async function fetchTransactions() {
  if (await checkAPI() && currentHousehold) {
    try {
      const res = await fetch(`${API_BASE}/api/transactions`, { headers: authHeaders() });
      if (res.status === 401) { clearSession(); throw new Error("Sessione scaduta"); }
      if (!res.ok) throw new Error(res.status);
      return await res.json();
    } catch (err) {
      if (err.message === "Sessione scaduta") throw err;
      console.error("fetchTransactions:", err);
      apiAvailable = false;
      return lsLoad();
    }
  }
  return lsLoad();
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
