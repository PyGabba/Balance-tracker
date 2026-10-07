import { useEffect, useState, useCallback, useRef } from "react";
import { IconAlertTriangle, IconRefresh, IconClock, IconX, IconCheck, IconCloudOff } from "@tabler/icons-react";
import { fetchSyncStatus, onSyncStatusChange, fetchFailedSyncOperations, discardSyncOperation, retrySyncOperation } from "../api.js";
import { t } from "../lib/i18n.js";
import { deriveSyncState } from "../lib/syncState.js";
import { color, alpha, displayFont } from "./ui/styles.js";

// ─── Offline sync status indicator (MOD-003) ───
// An always-visible pill so nobody has to wonder whether an expense
// disappeared: ✓ synced / N waiting to sync / syncing / offline (changes
// saved locally) / N need attention (validation/auth rejections the
// background loop stopped auto-retrying). Tapping it opens a compact panel
// that explains the state and lets you retry or dismiss anything stuck.
// The state itself comes from lib/syncState.js; OfflineBanner (below) is the
// louder companion for the offline case.

const ENTITY_LABELS = {
  transactions: { it: "transazione", en: "transaction" },
  accounts: { it: "conto", en: "account" },
  goals: { it: "obiettivo", en: "goal" },
  trips: { it: "viaggio", en: "trip" },
  positions: { it: "posizione", en: "position" },
};

// navigator.onLine, kept live. It only says "no network at all" (it can read
// true behind a captive portal), which is the case worth announcing.
export function useOnline() {
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine !== false);
  useEffect(() => {
    const up = () => setOnline(true), down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => { window.removeEventListener("online", up); window.removeEventListener("offline", down); };
  }, []);
  return online;
}

const STATE_VIEW = {
  synced:  { tone: color.positive, Icon: IconCheck },
  pending: { tone: color.warn, Icon: IconClock },
  syncing: { tone: color.accent, Icon: IconRefresh },
  offline: { tone: color.negative, Icon: IconCloudOff },
  failed:  { tone: color.negative, Icon: IconAlertTriangle },
};

// Slim strip under the header while offline — says it in full, where the pill
// only has room for one word.
export function OfflineBanner({ lang = "it" }) {
  const online = useOnline();
  if (online) return null;
  return (
    <div role="status" style={{
      display: "flex", alignItems: "center", gap: 6, padding: "6px 16px",
      background: alpha(color.negative, 0.09), borderBottom: `1px solid ${alpha(color.negative, 0.25)}`,
      color: color.negative, fontSize: 12, fontWeight: 600, fontFamily: displayFont,
    }}>
      <IconCloudOff size={14} />
      {t(lang, "sync.offlineBanner")}
    </div>
  );
}

export function SyncStatusBadge({ lang = "it" }) {
  const online = useOnline();
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

  const { state, count } = deriveSyncState({ online, ...status });
  const { tone, Icon: StatusIcon } = STATE_VIEW[state];
  // `label` (title/panel heading): the full sentence. `short`: what fits in the pill.
  const nWord = (n) => t(lang, n === 1 ? "sync.changeOne" : "sync.changeMany").replace("{n}", String(n));
  const label = {
    synced: t(lang, "sync.synced"),
    pending: t(lang, "sync.waiting").replace("{changes}", nWord(count)),
    syncing: t(lang, "sync.syncing"),
    offline: t(lang, "sync.offlineBanner"),
    failed: t(lang, "sync.needsAttention"),
  }[state];
  const short = {
    synced: t(lang, "sync.synced"),
    pending: nWord(count),
    syncing: t(lang, "sync.syncingShort"),
    offline: t(lang, "sync.offlineShort"),
    failed: `${count} ${t(lang, "sync.toCheck")}`,
  }[state];

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
        display: "flex", alignItems: "center", gap: 4, padding: "2px 8px 2px 6px",
        background: alpha(tone, 0.09), border: `1px solid ${alpha(tone, 0.33)}`, borderRadius: 999,
        color: tone, fontSize: 10, fontWeight: 700, cursor: "pointer",
        fontFamily: displayFont, whiteSpace: "nowrap",
      }}>
        <span style={{ display: "flex" }}><StatusIcon size={11} /></span>
        <span>{short}</span>
      </button>

      {open && (
        <div style={{
          position: "fixed", top: panelTop ?? "calc(100% + 8px)", left: "50%", transform: "translateX(-50%)",
          width: "min(280px, calc(100vw - 24px))", zIndex: 50,
          background: color.surface, border: `1px solid ${color.border}`, borderRadius: 14,
          boxShadow: "0 12px 32px rgba(0,0,0,.55)", padding: 12,
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: color.textPrimary }}>{label}</div>
            <button onClick={() => setOpen(false)} style={{ background: "none", border: "none", color: color.textSecondary, display: "flex", cursor: "pointer" }}><IconX size={14} /></button>
          </div>

          <div style={{ fontSize: 11, color: color.textSecondary, marginBottom: failedOps.length > 0 ? 8 : 0, lineHeight: 1.5 }}>
            {state === "synced" && t(lang, "sync.syncedExplain")}
            {state === "offline" && (count > 0
              ? t(lang, "sync.offlineExplainPending").replace("{n}", String(count))
              : t(lang, "sync.offlineExplain"))}
            {(state === "pending" || state === "syncing") && t(lang, "sync.pendingExplain").replace("{n}", String(count))}
            {state === "failed" && t(lang, "sync.failedExplain")}
          </div>

          {failedOps.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 220, overflowY: "auto" }}>
              {failedOps.map(op => {
                const entityLabel = ENTITY_LABELS[op.entityType]?.[lang] || ENTITY_LABELS[op.entityType]?.it || op.entityType;
                return (
                  <div key={op.operationId} style={{ background: color.bg, border: `1px solid ${color.border}`, borderRadius: 10, padding: "8px 10px" }}>
                    <div style={{ fontSize: 11, color: color.textSecondary, fontWeight: 600, marginBottom: 2 }}>{entityLabel}</div>
                    <div style={{ fontSize: 10, color: color.negative, marginBottom: 6, lineHeight: 1.4 }}>{op.lastError || t(lang, "sync.genericError")}</div>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button disabled={busyOpId === op.operationId} onClick={() => handleRetry(op.operationId)} style={{
                        flex: 1, padding: "5px 0", border: `1px solid ${alpha(color.accent, 0.33)}`, borderRadius: 8, cursor: "pointer",
                        background: color.accentSoft, color: color.accent, fontSize: 10, fontWeight: 700,
                        opacity: busyOpId === op.operationId ? 0.5 : 1,
                      }}>{t(lang, "sync.retry")}</button>
                      <button disabled={busyOpId === op.operationId} onClick={() => handleDismiss(op.operationId)} style={{
                        flex: 1, padding: "5px 0", border: `1px solid ${alpha(color.negative, 0.27)}`, borderRadius: 8, cursor: "pointer",
                        background: `${alpha(color.negative, 0.07)}`, color: color.negative, fontSize: 10, fontWeight: 700,
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
