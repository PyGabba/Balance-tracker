import { useState } from "react";
import { downloadBackup, restoreBackup } from "../../api.js";
import { t } from "../../lib/i18n.js";
import { toast } from "../../components/Toast.jsx";
import { color, alpha, displayFont } from "../../components/ui/styles.js";

// ─── Full backup / restore ───
// Extracted so both ExportView ("Backup e ripristino" at the bottom of
// Esporta) and ImpostazioniView (the "Backup e ripristino" settings row)
// share one implementation instead of two copies drifting apart.
export function BackupSection({ lang = "it" }) {
  const [backupBusy, setBackupBusy] = useState(false);
  const [restorePreview, setRestorePreview] = useState(null);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreDone, setRestoreDone] = useState(null);

  async function handleDownloadBackup() {
    setBackupBusy(true);
    try {
      const data = await downloadBackup();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `backup-finanza-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) { toast(`${t(lang, "toast.errorBackupPrefix")} ${e.message}`, "error"); }
    setBackupBusy(false);
  }

  async function handleRestoreFile(file) {
    setRestoreDone(null);
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (data.formato !== "balance-tracker-backup") { toast(t(lang, "toast.notABackupFile"), "error"); return; }
      setRestorePreview({ data, counts: {
        transazioni: (data.transactions || []).length,
        conti: (data.accounts || []).length,
        obiettivi: (data.goals || []).length,
        viaggi: (data.trips || []).length,
        posizioni: (data.positions || []).length,
        prezzi: Object.keys(data.manualPrices || {}).length,
      }});
    } catch (e) { toast(`${t(lang, "toast.fileUnreadablePrefix")} ${e.message}`, "error"); }
  }

  async function handleConfirmRestore() {
    if (!restorePreview) return;
    setRestoreBusy(true);
    try {
      const res = await restoreBackup(restorePreview.data);
      setRestoreDone(res.counts);
      setRestorePreview(null);
      setTimeout(() => window.location.reload(), 2500);
    } catch (e) { toast(`${t(lang, "toast.errorRestorePrefix")} ${e.message}`, "error"); }
    setRestoreBusy(false);
  }

  return (
    <div>
      <div style={{ fontSize: 13, color: color.textSecondary, marginBottom: 16 }}>
        {t(lang, "export.backupHint")}
      </div>
      <button onClick={handleDownloadBackup} disabled={backupBusy} style={{
        width: "100%", padding: "14px", border: `1px solid ${alpha(color.positive, 0.33)}`, borderRadius: 14, cursor: "pointer",
        fontSize: 14, fontWeight: 700, background: `${alpha(color.positive, 0.07)}`, color: color.positive,
        fontFamily: displayFont, marginBottom: 12, opacity: backupBusy ? 0.6 : 1,
      }}>{backupBusy ? t(lang, "export.preparing") : t(lang, "export.downloadBackup")}</button>

      <label style={{
        display: "block", padding: "14px 16px", borderRadius: 14, cursor: "pointer",
        border: `1px dashed ${color.border}`, background: color.surface, textAlign: "center",
        color: color.textSecondary, fontSize: 13, marginBottom: 12,
      }}>
        {t(lang, "export.restoreFromBackup")}
        <input type="file" accept=".json,application/json" style={{ display: "none" }}
          onChange={e => { const f = e.target.files?.[0]; if (f) handleRestoreFile(f); e.target.value = ""; }} />
      </label>

      {restorePreview && (
        <div style={{ background: color.surface, borderRadius: 16, padding: 16, marginBottom: 16, border: `1px solid ${alpha(color.warn, 0.33)}` }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: color.warn, marginBottom: 8 }}>{t(lang, "export.backupContents")}{restorePreview.data.creato ? ` (${restorePreview.data.creato.slice(0, 10)})` : ""}</div>
          <div style={{ fontSize: 12, color: color.textSecondary, lineHeight: 1.7 }}>
            {restorePreview.counts.transazioni} {t(lang, "export.transactions")} · {restorePreview.counts.conti} {t(lang, "export.accounts")} · {restorePreview.counts.obiettivi} {t(lang, "export.goals")} · {restorePreview.counts.viaggi} {t(lang, "export.trips")} · {restorePreview.counts.posizioni} {t(lang, "export.portfolioTrades")} · {restorePreview.counts.prezzi} {t(lang, "export.manualPrices")}
          </div>
          <div style={{ fontSize: 11, color: color.warn, marginTop: 10 }}>
            {t(lang, "export.restoreWarning")}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button onClick={() => setRestorePreview(null)} style={{ padding: "10px 14px", background: "none", border: `1px solid ${color.borderStrong}`, borderRadius: 10, color: color.textSecondary, fontSize: 13, cursor: "pointer" }}>{t(lang, "common.cancel")}</button>
            <button onClick={handleConfirmRestore} disabled={restoreBusy} style={{ flex: 1, padding: "10px", background: color.warn, border: "none", borderRadius: 10, color: color.bg, fontSize: 13, fontWeight: 700, cursor: "pointer", opacity: restoreBusy ? 0.6 : 1 }}>
              {restoreBusy ? t(lang, "export.restoring") : t(lang, "export.confirmRestore")}
            </button>
          </div>
        </div>
      )}

      {restoreDone && (
        <div style={{ background: `${alpha(color.positive, 0.07)}`, borderRadius: 16, padding: 16, marginBottom: 16, border: `1px solid ${alpha(color.positive, 0.33)}`, fontSize: 13, color: color.positive }}>
          {t(lang, "export.restoreComplete")}: {restoreDone.transactions} {t(lang, "export.transactions")}, {restoreDone.accounts} {t(lang, "export.accounts")}, {restoreDone.goals} {t(lang, "export.goals")}, {restoreDone.trips} {t(lang, "export.trips")}, {restoreDone.positions} {t(lang, "export.trades")}. {t(lang, "export.reloadingApp")}
        </div>
      )}
    </div>
  );
}
