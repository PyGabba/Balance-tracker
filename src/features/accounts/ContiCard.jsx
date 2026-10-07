import { useState } from "react";
import { IconX, IconPlus, IconTarget, IconWallet } from "@tabler/icons-react";
import { t } from "../../lib/i18n.js";
import { formattaValuta } from "../../lib/format.js";
import { calcolaSaldiConti } from "../../lib/finance.js";
import { toast } from "../../components/Toast.jsx";
import { color, alpha, accentGradient, moneyFont, displayFont } from "../../components/ui/styles.js";
import { AccountIcon, ACCOUNT_ICON_KEYS } from "../../components/ui/AccountIcon.jsx";
import { confirmDialog } from "../../components/ui/Dialog.jsx";
import { EmptyState } from "../../components/ui/EmptyState.jsx";

export function ContiCard({ conti, transazioni, goals = [], onAdd, onUpdate, onDelete, valutaBase = "EUR", lang = "it" }) {
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState(null);
  const [nome, setNome] = useState("");
  const [icona, setIcona] = useState("bank");
  const [saldoIniziale, setSaldoIniziale] = useState("");
  const [saving, setSaving] = useState(false);

  // Saldo (person-to-person) transactions are intentionally excluded.
  const saldi = calcolaSaldiConti(conti, transazioni, valutaBase);
  const totale = conti.reduce((s, c) => s + (saldi[c.id] || 0), 0);
  // Amount earmarked in savings goals linked to each account
  const accantonati = {};
  for (const g of goals) {
    if (g.contoId && saldi[g.contoId] !== undefined) accantonati[g.contoId] = (accantonati[g.contoId] || 0) + (g.currentAmount || 0);
  }

  function openAdd() { setEditId(null); setNome(""); setIcona("bank"); setSaldoIniziale(""); setShowAdd(true); }
  function openEdit(c) { setShowAdd(false); setEditId(c.id); setNome(c.nome); setIcona(c.icona || "bank"); setSaldoIniziale(String(c.saldoIniziale ?? 0)); }
  function closeForm() { setShowAdd(false); setEditId(null); }

  async function handleSave() {
    if (!nome.trim()) return;
    setSaving(true);
    try {
      const payload = { nome: nome.trim(), icona, saldoIniziale: parseFloat(saldoIniziale.replace(",", ".")) || 0 };
      if (editId) await onUpdate(editId, payload);
      else await onAdd(payload);
      closeForm();
    } catch (e) { toast(`${t(lang, "toast.errorPrefix")} ${e.message}`, "error"); }
    setSaving(false);
  }

  async function handleDelete(c) {
    const nTx = transazioni.filter(t => t.contoId === c.id).length;
    if (!(await confirmDialog({ message: `${t(lang, "confirm.deleteAccountPrefix")} "${c.nome}"?${nTx > 0 ? `\n${nTx} ${t(lang, "confirm.deleteAccountTxWarning")}` : ""}`, danger: true, lang }))) return;
    await onDelete(c.id);
    closeForm();
  }

  const formOpen = showAdd || editId;

  return (
    <div style={{ background: color.surface, borderRadius: 20, padding: 16, marginBottom: 16, border: `1px solid ${color.border}` }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: conti.length > 0 || formOpen ? 10 : 0 }}>
        <div style={{ fontSize: 11, color: color.textSecondary, letterSpacing: 0.5, textTransform: "uppercase" }}>{t(lang, "conti.title")}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {conti.length > 1 && (
            <span style={{ fontSize: 12, fontWeight: 700, fontFamily: moneyFont, color: totale >= 0 ? color.positive : color.negative }}>{formattaValuta(totale)}</span>
          )}
          <button onClick={() => formOpen ? closeForm() : openAdd()} style={{
            background: formOpen ? color.accentSoft : "none", border: formOpen ? `1px solid ${color.accent}` : `1px solid ${color.border}`,
            borderRadius: 8, cursor: "pointer", color: formOpen ? color.accent : color.textSecondary, display: "flex", alignItems: "center", padding: "4px 7px",
          }}>{formOpen ? <IconX size={14} /> : <IconPlus size={14} />}</button>
        </div>
      </div>

      {conti.length === 0 && !formOpen && (
        <EmptyState compact icon={IconWallet} title={t(lang, "conti.empty")} />
      )}

      {conti.map(c => (
        <div key={c.id} onClick={() => editId === c.id ? null : openEdit(c)} style={{
          display: "flex", alignItems: "center", gap: 10, padding: "9px 10px", borderRadius: 12, cursor: "pointer",
          background: editId === c.id ? color.accentSoft : color.bg, marginBottom: 6,
          border: editId === c.id ? `1px solid ${alpha(color.accent, 0.33)}` : "1px solid transparent",
        }}>
          <AccountIcon icona={c.icona} size={18} color={color.textSecondary} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: color.textSecondary, fontFamily: displayFont, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.nome}</div>
            {(accantonati[c.id] || 0) > 0 && (
              <div style={{ fontSize: 10, color: color.textMuted, marginTop: 1, display: "flex", alignItems: "center", gap: 3 }}>
                <IconTarget size={11} /> {formattaValuta(accantonati[c.id])} {t(lang, "conti.inGoals")} · <span style={{ color: color.textSecondary }}>{formattaValuta((saldi[c.id] || 0) - accantonati[c.id])} {t(lang, "conti.free")}</span>
              </div>
            )}
          </div>
          <span style={{ fontSize: 13, fontWeight: 700, fontFamily: moneyFont, color: (saldi[c.id] || 0) >= 0 ? color.positive : color.negative, flexShrink: 0 }}>
            {formattaValuta(saldi[c.id] || 0)}
          </span>
        </div>
      ))}

      {formOpen && (
        <div style={{ marginTop: 10, padding: 12, background: color.bg, borderRadius: 12, border: `1px solid ${alpha(color.accent, 0.2)}` }}>
          <div style={{ fontSize: 11, color: color.accent, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 10 }}>
            {editId ? t(lang, "conti.editAccount") : t(lang, "conti.newAccount")}
          </div>
          <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
            {ACCOUNT_ICON_KEYS.map(key => (
              <button key={key} onClick={() => setIcona(key)} style={{
                padding: "7px 9px", borderRadius: 8, cursor: "pointer", display: "flex", alignItems: "center",
                background: icona === key ? color.accentSoft : "transparent",
                border: icona === key ? `1px solid ${color.accent}` : `1px solid ${color.border}`,
                color: icona === key ? color.accent : color.textMuted,
              }}><AccountIcon icona={key} size={18} /></button>
            ))}
          </div>
          <input type="text" value={nome} onChange={e => setNome(e.target.value)} placeholder={t(lang, "conti.namePlaceholder")}
            style={{ width: "100%", padding: "10px 12px", background: color.surface, border: `1px solid ${color.border}`, borderRadius: 10, color: color.textPrimary, fontSize: 14, fontFamily: displayFont, outline: "none", boxSizing: "border-box", marginBottom: 8 }} />
          <input type="text" inputMode="decimal" value={saldoIniziale} onChange={e => setSaldoIniziale(e.target.value)} placeholder={t(lang, "conti.initialBalancePlaceholder")}
            style={{ width: "100%", padding: "10px 12px", background: color.surface, border: `1px solid ${color.border}`, borderRadius: 10, color: color.textPrimary, fontSize: 14, fontFamily: moneyFont, outline: "none", boxSizing: "border-box", marginBottom: 10 }} />
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={handleSave} disabled={saving || !nome.trim()} style={{
              flex: 1, padding: "10px", background: nome.trim() ? accentGradient : color.border, border: "none",
              borderRadius: 10, color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: displayFont, opacity: saving ? 0.6 : 1,
            }}>{saving ? t(lang, "conti.saving") : t(lang, "common.save")}</button>
            {editId && (
              <button onClick={() => handleDelete(conti.find(c => c.id === editId))} style={{
                padding: "10px 14px", background: "none", border: `1px solid ${alpha(color.negative, 0.33)}`, borderRadius: 10,
                color: color.negative, fontSize: 13, cursor: "pointer", fontFamily: displayFont,
              }}>{t(lang, "common.delete")}</button>
            )}
          </div>
          {editId && <div style={{ fontSize: 10, color: color.textMuted, marginTop: 8 }}>{t(lang, "conti.balanceHint")}</div>}
        </div>
      )}
    </div>
  );
}
