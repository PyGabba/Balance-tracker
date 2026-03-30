// ─── API Client ───
// Talks to Express/MongoDB backend. Falls back to localStorage if API unreachable.

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:3001";

let apiAvailable = null; // null = unknown, true/false after first check

async function checkAPI() {
  if (apiAvailable !== null) return apiAvailable;
  try {
    const res = await fetch(`${API_BASE}/api/health`, { signal: AbortSignal.timeout(3000) });
    apiAvailable = res.ok;
  } catch {
    apiAvailable = false;
  }
  if (!apiAvailable) console.warn("API non raggiungibile — uso localStorage come fallback");
  return apiAvailable;
}

// ─── localStorage fallback ───
function lsLoad() {
  try { const raw = localStorage.getItem("finanza-transactions"); return raw ? JSON.parse(raw) : []; } catch { return []; }
}
function lsSave(txs) {
  try { localStorage.setItem("finanza-transactions", JSON.stringify(txs)); } catch (e) { console.error("localStorage save failed", e); }
}

// ─── Public API ───

export async function fetchTransactions() {
  if (await checkAPI()) {
    try {
      const res = await fetch(`${API_BASE}/api/transactions`);
      if (!res.ok) throw new Error(res.status);
      return await res.json();
    } catch (err) {
      console.error("fetchTransactions API error:", err);
      apiAvailable = false;
      return lsLoad();
    }
  }
  return lsLoad();
}

export async function addTransaction(tx) {
  if (await checkAPI()) {
    try {
      const res = await fetch(`${API_BASE}/api/transactions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(tx),
      });
      if (!res.ok) throw new Error(res.status);
      return await res.json();
    } catch (err) {
      console.error("addTransaction API error:", err);
      apiAvailable = false;
    }
  }
  // Fallback: save to localStorage
  const all = lsLoad();
  const newTx = { ...tx, id: tx.id || Date.now().toString(36) + Math.random().toString(36).slice(2, 7) };
  all.push(newTx);
  lsSave(all);
  return newTx;
}

export async function deleteTransaction(id) {
  if (await checkAPI()) {
    try {
      const res = await fetch(`${API_BASE}/api/transactions/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(res.status);
      return true;
    } catch (err) {
      console.error("deleteTransaction API error:", err);
      apiAvailable = false;
    }
  }
  // Fallback
  const all = lsLoad().filter(t => t.id !== id);
  lsSave(all);
  return true;
}

export async function updateTransaction(id, updates) {
  if (await checkAPI()) {
    try {
      const res = await fetch(`${API_BASE}/api/transactions/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      if (!res.ok) throw new Error(res.status);
      return await res.json();
    } catch (err) {
      console.error("updateTransaction API error:", err);
      apiAvailable = false;
    }
  }
  // Fallback
  const all = lsLoad().map(t => t.id === id ? { ...t, ...updates } : t);
  lsSave(all);
  return all.find(t => t.id === id);
}

// Re-check API availability (e.g. after network recovery)
export function resetAPICheck() {
  apiAvailable = null;
}

export function isAPIConnected() {
  return apiAvailable === true;
}
