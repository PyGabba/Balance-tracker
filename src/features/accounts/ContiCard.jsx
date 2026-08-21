import { useState } from "react";
import { t } from "../../lib/i18n.js";
import { formattaValuta } from "../../lib/format.js";
import { calcolaSaldiConti } from "../../lib/finance.js";
import { toast } from "../../components/Toast.jsx";

export function ContiCard({ conti, transazioni, goals = [], onAdd, onUpdate, onDelete, valutaBase = "EUR", lang = "it" }) {
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState(null);
  const [nome, setNome] = useState("");
  const [icona, setIcona] = useState("🏦");
  const [saldoIniziale, setSaldoIniziale] = useState("");
  const [saving, setSaving] = useState(false);
  const ICONE = ["🏦", "💳", "💵", "🐖", "📱", "💰"];

  // Saldo (person-to-person) transactions are intentionally excluded.
  const saldi = calcolaSaldiConti(conti, transazioni, valutaBase);
  const totale = conti.reduce((s, c) => s + (saldi[c.id] || 0), 0);
  // Amount earmarked in savings goals linked to each account
  const accantonati = {};
  for (const g of goals) {
    if (g.contoId && saldi[g.contoId] !== undefined) accantonati[g.contoId] = (accantonati[g.contoId] || 0) + (g.currentAmount || 0);
  }

  function openAdd() { setEditId(null); setNome(""); setIcona("🏦"); setSaldoIniziale(""); setShowAdd(true); }
  function openEdit(c) { setShowAdd(false); setEditId(c.id); setNome(c.nome); setIcona(c.icona || "🏦"); setSaldoIniziale(String(c.saldoIniziale ?? 0)); }
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
    if (!confirm(`${t(lang, "confirm.deleteAccountPrefix")} "${c.nome}"?${nTx > 0 ? `\n${nTx} ${t(lang, "confirm.deleteAccountTxWarning")}` : ""}`)) return;
    await onDelete(c.id);
    closeForm();
  }

  const formOpen = showAdd || editId;

  return (
    <div style={{ background: "#1a1a28", borderRadius: 20, padding: 16, marginBottom: 16, border: "1px solid #252538" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: conti.length > 0 || formOpen ? 10 : 0 }}>
        <div style={{ fontSize: 11, color: "#999", letterSpacing: 0.5, textTransform: "uppercase" }}>{t(lang, "conti.title")}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {conti.length > 1 && (
            <span style={{ fontSize: 12, fontWeight: 700, fontFamily: "'Space Mono',monospace", color: totale >= 0 ? "#4ECDC4" : "#FF6B6B" }}>{formattaValuta(totale)}</span>
          )}
          <button onClick={() => formOpen ? closeForm() : openAdd()} style={{
            background: formOpen ? "#6C5CE722" : "none", border: formOpen ? "1px solid #6C5CE7" : "1px solid #252538",
            borderRadius: 8, cursor: "pointer", color: formOpen ? "#6C5CE7" : "#888", fontSize: 14, padding: "2px 8px",
          }}>{formOpen ? "✕" : "+"}</button>
        </div>
      </div>

      {conti.length === 0 && !formOpen && (
        <div style={{ fontSize: 12, color: "#555", marginTop: 8 }}>{t(lang, "conti.empty")}</div>
      )}

      {conti.map(c => (
        <div key={c.id} onClick={() => editId === c.id ? null : openEdit(c)} style={{
          display: "flex", alignItems: "center", gap: 10, padding: "9px 10px", borderRadius: 12, cursor: "pointer",
          background: editId === c.id ? "#6C5CE711" : "#120f16", marginBottom: 6,
          border: editId === c.id ? "1px solid #6C5CE755" : "1px solid transparent",
        }}>
          <span style={{ fontSize: 16 }}>{c.icona || "🏦"}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#ccc", fontFamily: "'DM Sans',sans-serif", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.nome}</div>
            {(accantonati[c.id] || 0) > 0 && (
              <div style={{ fontSize: 10, color: "#888", marginTop: 1 }}>
                🎯 {formattaValuta(accantonati[c.id])} {t(lang, "conti.inGoals")} · <span style={{ color: "#aaa" }}>{formattaValuta((saldi[c.id] || 0) - accantonati[c.id])} {t(lang, "conti.free")}</span>
              </div>
            )}
          </div>
          <span style={{ fontSize: 13, fontWeight: 700, fontFamily: "'Space Mono',monospace", color: (saldi[c.id] || 0) >= 0 ? "#4ECDC4" : "#FF6B6B", flexShrink: 0 }}>
            {formattaValuta(saldi[c.id] || 0)}
          </span>
        </div>
      ))}

      {formOpen && (
        <div style={{ marginTop: 10, padding: 12, background: "#120f16", borderRadius: 12, border: "1px solid #6C5CE733" }}>
          <div style={{ fontSize: 11, color: "#a78bfa", fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 10 }}>
            {editId ? t(lang, "conti.editAccount") : t(lang, "conti.newAccount")}
          </div>
          <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
            {ICONE.map(ic => (
              <button key={ic} onClick={() => setIcona(ic)} style={{
                fontSize: 16, padding: "6px 8px", borderRadius: 8, cursor: "pointer",
                background: icona === ic ? "#6C5CE722" : "transparent",
                border: icona === ic ? "1px solid #6C5CE7" : "1px solid #252538",
              }}>{ic}</button>
            ))}
          </div>
          <input type="text" value={nome} onChange={e => setNome(e.target.value)} placeholder={t(lang, "conti.namePlaceholder")}
            style={{ width: "100%", padding: "10px 12px", background: "#1a1a28", border: "1px solid #252538", borderRadius: 10, color: "#eee", fontSize: 14, fontFamily: "'DM Sans',sans-serif", outline: "none", boxSizing: "border-box", marginBottom: 8 }} />
          <input type="text" inputMode="decimal" value={saldoIniziale} onChange={e => setSaldoIniziale(e.target.value)} placeholder={t(lang, "conti.initialBalancePlaceholder")}
            style={{ width: "100%", padding: "10px 12px", background: "#1a1a28", border: "1px solid #252538", borderRadius: 10, color: "#eee", fontSize: 14, fontFamily: "'Space Mono',monospace", outline: "none", boxSizing: "border-box", marginBottom: 10 }} />
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={handleSave} disabled={saving || !nome.trim()} style={{
              flex: 1, padding: "10px", background: nome.trim() ? "linear-gradient(135deg, #6C5CE7, #a855f7)" : "#252538", border: "none",
              borderRadius: 10, color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", opacity: saving ? 0.6 : 1,
            }}>{saving ? t(lang, "conti.saving") : t(lang, "common.save")}</button>
            {editId && (
              <button onClick={() => handleDelete(conti.find(c => c.id === editId))} style={{
                padding: "10px 14px", background: "none", border: "1px solid #FF6B6B55", borderRadius: 10,
                color: "#FF6B6B", fontSize: 13, cursor: "pointer", fontFamily: "'DM Sans',sans-serif",
              }}>{t(lang, "common.delete")}</button>
            )}
          </div>
          {editId && <div style={{ fontSize: 10, color: "#555", marginTop: 8 }}>{t(lang, "conti.balanceHint")}</div>}
        </div>
      )}
    </div>
  );
}
