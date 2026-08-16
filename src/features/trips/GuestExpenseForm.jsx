import { useState } from "react";
import { addSharedTripExpense } from "../../api.js";
import { t } from "../../lib/i18n.js";
import { toast } from "../../components/Toast.jsx";
import { inputStyle } from "../../components/ui/styles.js";

export function GuestExpenseForm({ trip, me, token, categorie, onAdded, lang = "it" }) {
  const [importo, setImporto] = useState("");
  const [descrizione, setDescrizione] = useState("");
  const [categoria, setCategoria] = useState("altro");
  const [busy, setBusy] = useState(false);
  const allPars = trip.partecipanti || [];

  async function handleAdd() {
    const val = parseFloat(importo.replace(",", "."));
    if (!val || val <= 0) return;
    setBusy(true);
    try {
      const each = Math.round(100 / allPars.length);
      const splits = allPars.map((p, i) => ({ personaId: p.id, quota: i === allPars.length - 1 ? 100 - each * (allPars.length - 1) : each }));
      await addSharedTripExpense(token, {
        importo: val, descrizione: descrizione.trim(), categoria,
        pagatoDa: me.id, data: new Date().toISOString().slice(0, 10), splits,
      });
      setImporto(""); setDescrizione(""); setCategoria("altro");
      await onAdded();
    } catch (e) { toast(`${t(lang, "toast.errorPrefix")} ${e.message}`, "error"); }
    setBusy(false);
  }

  return (
    <div style={{ background: "#1a1a28", borderRadius: 16, padding: 16, border: "1px solid #252538" }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: "#eee", marginBottom: 10 }}>{t(lang, "guest.addExpensePaidByYou")}</div>
      <input type="number" inputMode="decimal" value={importo} onChange={e => setImporto(e.target.value)} placeholder="€" style={{ ...inputStyle, marginBottom: 8, fontFamily: "'Space Mono',monospace" }} />
      <input type="text" value={descrizione} onChange={e => setDescrizione(e.target.value)} placeholder={t(lang, "viaggi.expenseDescriptionPlaceholder")} style={{ ...inputStyle, marginBottom: 8 }} />
      <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
        {categorie.map(c => (
          <button key={c.id} onClick={() => setCategoria(c.id)} style={{ padding: "6px 10px", borderRadius: 8, border: categoria === c.id ? `2px solid ${c.colore}` : "1px solid #252538", background: categoria === c.id ? c.colore + "22" : "#111119", color: categoria === c.id ? c.colore : "#666", fontSize: 11, cursor: "pointer" }}>
            {c.emoji} {c.nome}
          </button>
        ))}
      </div>
      <button onClick={handleAdd} disabled={!importo || busy} style={{ width: "100%", padding: "12px", background: importo ? "#6C5CE7" : "#252538", border: "none", borderRadius: 12, color: "#fff", fontSize: 14, fontWeight: 700, cursor: importo ? "pointer" : "default" }}>
        {busy ? "..." : t(lang, "viaggi.addExpense")}
      </button>
    </div>
  );
}
