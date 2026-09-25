import { useState } from "react";
import { addSharedTripExpense } from "../../api.js";
import { t } from "../../lib/i18n.js";
import { toast } from "../../components/Toast.jsx";
import { inputStyle, color, moneyFont } from "../../components/ui/styles.js";
import { equalQuotas } from "../../lib/appHelpers.js";

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
      const quotas = equalQuotas(allPars.length);
      const splits = allPars.map((p, i) => ({ personaId: p.id, quota: quotas[i] }));
      await addSharedTripExpense(token, {
        importo: val, descrizione: descrizione.trim(), categoria,
        pagatoDa: me.id, data: new Date().toISOString().slice(0, 10), splits,
        guestToken: me.guestToken, // server derives pagatoDa from this, not from the field above
      });
      setImporto(""); setDescrizione(""); setCategoria("altro");
      await onAdded();
    } catch (e) { toast(`${t(lang, "toast.errorPrefix")} ${e.message}`, "error"); }
    setBusy(false);
  }

  return (
    <div style={{ background: color.surface, borderRadius: 16, padding: 16, border: `1px solid ${color.border}` }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: color.textPrimary, marginBottom: 10 }}>{t(lang, "guest.addExpensePaidByYou")}</div>
      <input type="number" inputMode="decimal" value={importo} onChange={e => setImporto(e.target.value)} placeholder="€" style={{ ...inputStyle, marginBottom: 8, fontFamily: moneyFont }} />
      <input type="text" value={descrizione} onChange={e => setDescrizione(e.target.value)} placeholder={t(lang, "viaggi.expenseDescriptionPlaceholder")} style={{ ...inputStyle, marginBottom: 8 }} />
      <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
        {categorie.map(c => (
          <button key={c.id} onClick={() => setCategoria(c.id)} style={{ padding: "6px 10px", borderRadius: 8, border: categoria === c.id ? `2px solid ${c.colore}` : `1px solid ${color.border}`, background: categoria === c.id ? c.colore + "22" : color.bg, color: categoria === c.id ? c.colore : color.textMuted, fontSize: 11, cursor: "pointer" }}>
            {c.emoji} {c.nome}
          </button>
        ))}
      </div>
      <button onClick={handleAdd} disabled={!importo || busy} style={{ width: "100%", padding: "12px", background: importo ? color.accent : color.border, border: "none", borderRadius: 12, color: "#fff", fontSize: 14, fontWeight: 700, cursor: importo ? "pointer" : "default" }}>
        {busy ? "..." : t(lang, "viaggi.addExpense")}
      </button>
    </div>
  );
}
