import { useEffect, useState, useCallback, useRef } from "react";
import { fetchSyncStatus, onSyncStatusChange, fetchFailedSyncOperations, discardSyncOperation, retrySyncOperation } from "../api.js";
import { t } from "../lib/i18n.js";

// ─── Offline sync status indicator (MOD-003) ───
// A small header pill that appears only when there's something to say:
// syncing, N changes waiting for connectivity, or N that need attention
// (validation/auth rejections the background loop stopped auto-retrying).
// Tapping it opens a compact panel to retry or dismiss anything stuck.

const ENTITY_LABELS = {
  transactions: { it: "transazione", en: "transaction" },
  accounts: { it: "conto", en: "account" },
  goals: { it: "obiettivo", en: "goal" },
  trips: { it: "viaggio", en: "trip" },
  positions: { it: "posizione", en: "position" },
};

export function SyncStatusBadge({ lang = "it" }) {
  const [status, setStatus] = useState({ pending: 0, failed: 0, syncing: false });
  const [open, setOpen] = useState(false);
  const [failedOps, setFailedOps] = useState([]);
  const [busyOpId, setBusyOpId] = useState(null);
  const [panelTop, setPanelTop] = useState(null);
  const buttonRef = useRef(null);

  const toggleOpen = useCallback(() => {
    setOpen(v => {
      const next = !v;
      if (next && buttonRef.current) setPanelTop(buttonRef.current.getBoundingClientRect().bottom + 8);
      return next;
    });
  }, []);

  const refresh = useCallback(async () => {
    try { setStatus(await fetchSyncStatus()); } catch (e) { console.error("SyncStatusBadge refresh:", e); }
  }, []);

  useEffect(() => {
    refresh();
    const unsubscribe = onSyncStatusChange(refresh);
    const interval = setInterval(refresh, 5000); // catch a state change even if the pub/sub notification was missed (e.g. across a reload)
    return () => { unsubscribe(); clearInterval(interval); };
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const ops = await fetchFailedSyncOperations();
        if (!cancelled) setFailedOps(ops);
      } catch (e) { console.error("SyncStatusBadge failed-ops:", e); }
    })();
    return () => { cancelled = true; };
  }, [open, status.failed]);

  if (status.pending === 0 && status.failed === 0 && !status.syncing) return null;

  const tone = status.failed > 0 ? "#FF6B6B" : status.syncing ? "#6C5CE7" : "#F0A500";
  const icon = status.failed > 0 ? "⚠️" : status.syncing ? "🔄" : "⏳";
  const count = status.failed > 0 ? status.failed : status.pending;
  const label = status.failed > 0
    ? t(lang, "sync.needsAttention")
    : status.syncing
      ? t(lang, "sync.syncing")
      : t(lang, "sync.pending");

  async function handleRetry(operationId) {
    setBusyOpId(operationId);
    try { await retrySyncOperation(operationId); } finally { setBusyOpId(null); }
  }
  async function handleDismiss(operationId) {
    setBusyOpId(operationId);
    try { await discardSyncOperation(operationId); } finally { setBusyOpId(null); }
  }

  return (
    <div style={{ position: "relative" }}>
      <button ref={buttonRef} onClick={toggleOpen} title={label} style={{
        display: "flex", alignItems: "center", gap: 4, padding: "4px 8px",
        background: tone + "18", border: `1px solid ${tone}55`, borderRadius: 8,
        color: tone, fontSize: 11, fontWeight: 700, cursor: "pointer",
        fontFamily: "'DM Sans', sans-serif",
      }}>
        <span style={{ fontSize: 12 }}>{icon}</span>
        <span>{count}</span>
      </button>

      {open && (
        <div style={{
          position: "fixed", top: panelTop ?? "calc(100% + 8px)", left: "50%", transform: "translateX(-50%)",
          width: "min(280px, calc(100vw - 24px))", zIndex: 50,
          background: "#1a1a28", border: "1px solid #252538", borderRadius: 14,
          boxShadow: "0 12px 32px #000a", padding: 12,
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#ddd" }}>{label}</div>
            <button onClick={() => setOpen(false)} style={{ background: "none", border: "none", color: "#888", fontSize: 14, cursor: "pointer" }}>✕</button>
          </div>

          {status.pending > 0 && (
            <div style={{ fontSize: 11, color: "#888", marginBottom: 8, lineHeight: 1.5 }}>
              {t(lang, "sync.pendingExplain").replace("{n}", String(status.pending))}
            </div>
          )}

          {failedOps.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 220, overflowY: "auto" }}>
              {failedOps.map(op => {
                const entityLabel = ENTITY_LABELS[op.entityType]?.[lang] || ENTITY_LABELS[op.entityType]?.it || op.entityType;
                return (
                  <div key={op.operationId} style={{ background: "#120f16", border: "1px solid #252538", borderRadius: 10, padding: "8px 10px" }}>
                    <div style={{ fontSize: 11, color: "#ccc", fontWeight: 600, marginBottom: 2 }}>{entityLabel}</div>
                    <div style={{ fontSize: 10, color: "#FF6B6B", marginBottom: 6, lineHeight: 1.4 }}>{op.lastError || t(lang, "sync.genericError")}</div>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button disabled={busyOpId === op.operationId} onClick={() => handleRetry(op.operationId)} style={{
                        flex: 1, padding: "5px 0", border: "1px solid #6C5CE755", borderRadius: 8, cursor: "pointer",
                        background: "#6C5CE722", color: "#a78bfa", fontSize: 10, fontWeight: 700,
                        opacity: busyOpId === op.operationId ? 0.5 : 1,
                      }}>{t(lang, "sync.retry")}</button>
                      <button disabled={busyOpId === op.operationId} onClick={() => handleDismiss(op.operationId)} style={{
                        flex: 1, padding: "5px 0", border: "1px solid #FF6B6B44", borderRadius: 8, cursor: "pointer",
                        background: "#FF6B6B11", color: "#FF6B6B", fontSize: 10, fontWeight: 700,
                        opacity: busyOpId === op.operationId ? 0.5 : 1,
                      }}>{t(lang, "sync.dismiss")}</button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
