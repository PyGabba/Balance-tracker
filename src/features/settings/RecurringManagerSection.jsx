import { useState } from "react";
import { t } from "../../lib/i18n.js";
import { formattaValuta, formattaData } from "../../lib/format.js";
import { toast } from "../../components/Toast.jsx";
import { color, alpha, displayFont } from "../../components/ui/styles.js";
import { RICORRENZA_IDS } from "../transactions/helpers.js";
import { listRecurringTemplates, skipNextOccurrence } from "../../services/recurringService.js";

const FREQUENZE = RICORRENZA_IDS.filter(id => id !== "no");

// ─── Manage recurring transactions ───
// Collapsible settings section listing every live recurring template
// (transactions still carrying a `ricorrenza` field), with per-row controls
// to change frequency/variable-amount, skip the next occurrence without
// generating a transaction for it, pause it (stop future renewals while
// keeping the transaction history untouched), or delete it outright.
export function RecurringManagerSection({ transazioni, categorie, onEdit, onDelete, lang = "it" }) {
  const [aperto, setAperto] = useState(false);
  const [busyId, setBusyId] = useState(null);

  const templates = listRecurringTemplates(transazioni);

  async function withBusy(id, fn) {
    setBusyId(id);
    try { await fn(); } catch (e) { toast(`${t(lang, "toast.errorPrefix")} ${e.message}`, "error"); }
    setBusyId(null);
  }

  function handleFrequenzaChange(tx, frequenza) {
    withBusy(tx.id, () => onEdit(tx.id, { ricorrenza: { ...tx.ricorrenza, frequenza } }));
  }

  function handleProssimaDataChange(tx, prossimaData) {
    if (!prossimaData) return;
    withBusy(tx.id, () => onEdit(tx.id, { ricorrenza: { ...tx.ricorrenza, prossimaData } }));
  }

  function handleVariabileToggle(tx) {
    withBusy(tx.id, () => onEdit(tx.id, { ricorrenza: { ...tx.ricorrenza, variabile: !tx.ricorrenza.variabile } }));
  }

  function handleSkip(tx) {
    withBusy(tx.id, () => onEdit(tx.id, { ricorrenza: skipNextOccurrence(tx) }));
  }

  function handlePause(tx) {
    if (!confirm(t(lang, "recurManager.confirmPause"))) return;
    withBusy(tx.id, () => onEdit(tx.id, { ricorrenza: null }));
  }

  function handleDelete(tx) {
    if (!confirm(t(lang, "recurManager.confirmDelete"))) return;
    withBusy(tx.id, () => onDelete(tx.id));
  }

  return (
    <div style={{ background: color.surface, borderRadius: 16, padding: 16, border: `1px solid ${color.border}`, marginBottom: 20 }}>
      <div onClick={() => setAperto(a => !a)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer" }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: color.textPrimary }}>
          {t(lang, "recurManager.title")}{templates.length > 0 && <span style={{ color: color.textMuted, fontWeight: 600 }}> ({templates.length})</span>}
        </div>
        <span style={{ fontSize: 13, color: color.textMuted }}>{aperto ? "▲" : "▼"}</span>
      </div>
      {aperto && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 11, color: color.textMuted, marginBottom: 12, lineHeight: 1.5 }}>
            {t(lang, "recurManager.hint")}
          </div>
          {templates.length === 0 ? (
            <div style={{ textAlign: "center", color: color.textMuted, fontSize: 12, padding: 12 }}>{t(lang, "recurManager.empty")}</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {templates.map(tx => {
                const cat = tx.tipo === "entrata" ? { emoji: "💰" } : (categorie.find(c => c.id === tx.categoria) || categorie.find(c => c.id === "altro") || {});
                const busy = busyId === tx.id;
                return (
                  <div key={tx.id} style={{ background: color.bg, borderRadius: 12, padding: "12px", border: `1px solid ${color.border}`, opacity: busy ? 0.5 : 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                      <span style={{ fontSize: 18, flexShrink: 0 }}>{cat.emoji || "📦"}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: color.textSecondary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {tx.descrizione || cat.nome || tx.categoria}
                        </div>
                        <div style={{ fontSize: 10, color: color.textMuted }}>
                          {tx.tipo === "entrata" ? "+" : "-"}{formattaValuta(tx.importo)} · {t(lang, "recurManager.next")} {formattaData(tx.ricorrenza.prossimaData)}
                        </div>
                      </div>
                      <button disabled={busy} onClick={() => handleDelete(tx)} style={{ background: "none", border: "none", color: `${alpha(color.negative, 0.53)}`, fontSize: 16, cursor: busy ? "default" : "pointer", padding: "0 2px" }}>✕</button>
                    </div>

                    {/* Frequency picker */}
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 8 }}>
                      {FREQUENZE.map(id => (
                        <button key={id} disabled={busy} onClick={() => handleFrequenzaChange(tx, id)} style={{
                          padding: "5px 10px", borderRadius: 16, cursor: busy ? "default" : "pointer", fontSize: 11, fontWeight: 600,
                          fontFamily: displayFont,
                          background: tx.ricorrenza.frequenza === id ? `${alpha(color.accent, 0.13)}` : "transparent",
                          border: tx.ricorrenza.frequenza === id ? `1px solid ${color.accent}` : `1px solid ${color.border}`,
                          color: tx.ricorrenza.frequenza === id ? color.accent : color.textMuted,
                        }}>{t(lang, `recur.${id}`)}</button>
                      ))}
                    </div>

                    {/* Next-occurrence date + variable amount */}
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
                      <input type="date" disabled={busy} value={tx.ricorrenza.prossimaData} onChange={e => handleProssimaDataChange(tx, e.target.value)} style={{
                        flex: "1 1 140px", padding: "6px 8px", background: color.surface, border: `1px solid ${color.border}`,
                        borderRadius: 8, color: color.textPrimary, fontSize: 11, fontFamily: displayFont, colorScheme: "dark",
                      }} />
                      <label style={{ display: "flex", alignItems: "center", gap: 5, cursor: busy ? "default" : "pointer" }}>
                        <input type="checkbox" disabled={busy} checked={!!tx.ricorrenza.variabile} onChange={() => handleVariabileToggle(tx)} style={{ width: 14, height: 14, accentColor: color.accent }} />
                        <span style={{ fontSize: 10, color: color.textMuted }}>{t(lang, "recurManager.variable")}</span>
                      </label>
                    </div>

                    {/* Actions */}
                    <div style={{ display: "flex", gap: 6 }}>
                      <button disabled={busy} onClick={() => handleSkip(tx)} style={{
                        flex: 1, padding: "7px", border: `1px solid ${color.border}`, borderRadius: 8, background: "transparent",
                        color: color.textMuted, fontSize: 11, fontWeight: 600, cursor: busy ? "default" : "pointer", fontFamily: displayFont,
                      }}>{t(lang, "recurManager.skip")}</button>
                      <button disabled={busy} onClick={() => handlePause(tx)} style={{
                        flex: 1, padding: "7px", border: `1px solid ${alpha(color.warn, 0.33)}`, borderRadius: 8, background: `${alpha(color.warn, 0.07)}`,
                        color: color.warn, fontSize: 11, fontWeight: 600, cursor: busy ? "default" : "pointer", fontFamily: displayFont,
                      }}>{t(lang, "recurManager.pause")}</button>
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
