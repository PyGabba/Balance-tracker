import { useState, useEffect } from "react";
import { t } from "../../lib/i18n.js";
import { inputStyle, color, moneyFont, displayFont } from "../../components/ui/styles.js";

export function TripExpenseForm({ trip, onAdd, categorie, lang = "it" }) {
  const [importo, setImporto] = useState("");
  const [descrizione, setDescrizione] = useState("");
  const [categoria, setCategoria] = useState("altro");
  const [pagatoDa, setPagatoDa] = useState(trip.partecipanti?.[0]?.id || "");
  const [splits, setSplits] = useState([]);
  const [data, setData] = useState(new Date().toISOString().slice(0, 10));
  const allPars = [...(trip.partecipanti || [])];

  useEffect(() => {
    if (allPars.length > 0) {
      setPagatoDa(allPars[0].id);
      const each = Math.round(100 / allPars.length);
      setSplits(allPars.map((p, i) => ({ personaId: p.id, quota: i === allPars.length - 1 ? 100 - each * (allPars.length - 1) : each })));
    }
  }, [trip.id]);

  async function handleAdd() {
    const val = parseFloat(importo.replace(",", "."));
    if (!val || val <= 0) return;
    await onAdd({ importo: val, descrizione: descrizione.trim(), categoria, pagatoDa, data, splits: splits.filter(s => s.quota > 0) });
    setImporto(""); setDescrizione(""); setCategoria("altro");
  }

  return (
    <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${color.border}` }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <input type="number" inputMode="decimal" value={importo} onChange={e => setImporto(e.target.value)} placeholder="€" style={{ ...inputStyle, flex: 1, fontFamily: moneyFont }} />
        <select value={pagatoDa} onChange={e => setPagatoDa(e.target.value)} style={{ ...inputStyle, flex: 1, fontFamily: displayFont }}>
          {allPars.map(p => <option key={p.id} value={p.id}>{p.nome}</option>)}
        </select>
      </div>
      <input type="text" value={descrizione} onChange={e => setDescrizione(e.target.value)} placeholder={t(lang, "viaggi.expenseDescriptionPlaceholder")} style={{ ...inputStyle, marginBottom: 8 }} />
      <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
        {categorie.map(c => (
          <button key={c.id} onClick={() => setCategoria(c.id)} style={{ padding: "6px 10px", borderRadius: 8, border: categoria === c.id ? `2px solid ${c.colore}` : `1px solid ${color.border}`, background: categoria === c.id ? c.colore + "22" : color.surface, color: categoria === c.id ? c.colore : color.textMuted, fontSize: 11, fontFamily: displayFont, cursor: "pointer" }}>
            {c.emoji} {c.nome}
          </button>
        ))}
      </div>
      <button onClick={handleAdd} disabled={!importo} style={{ width: "100%", padding: "10px", background: importo ? color.accent : color.border, border: "none", borderRadius: 10, color: "#fff", fontSize: 13, fontWeight: 700, fontFamily: displayFont, cursor: importo ? "pointer" : "default" }}>{t(lang, "viaggi.addExpense")}</button>
    </div>
  );
}
