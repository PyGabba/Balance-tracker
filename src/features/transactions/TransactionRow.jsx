import { useState, useEffect } from "react";
import { t } from "../../lib/i18n.js";
import { formattaValuta, formattaData } from "../../lib/format.js";
import { splitsTotalOk } from "../../lib/appHelpers.js";
import { toast } from "../../components/Toast.jsx";
import { labelStyle, inputStyle, color, moneyFont, displayFont } from "../../components/ui/styles.js";
import { SplitSelector } from "./components/SplitSelector.jsx";
import { initialSplits } from "./helpers.js";

// ─── Transaction Row with inline edit ───
export function TransactionRow({ t: tx, persone, categorie, conti = [], isEditing, onTap, onDelete, onSave, onCancel, lang = "it" }) {
  const _ENTRATA_CAT = { id: "entrata", nome: t(lang, "cat.entrata"), emoji: "💰", colore: color.positive };
  const cat = tx.tipo === "entrata" ? _ENTRATA_CAT : (categorie.find(c => c.id === tx.categoria) || categorie.find(c => c.id === "altro") || categorie[categorie.length - 1]);
  const persona = persone.find(p => p.id === tx.pagatoDa);

  // Edit state
  const [tipo, setTipo] = useState(tx.tipo);
  const [importo, setImporto] = useState(String(tx.importo));
  const [categoria, setCategoria] = useState(tx.categoria || "altro");
  const [descrizione, setDescrizione] = useState(tx.descrizione || "");
  const [data, setData] = useState(tx.data);
  const [pagatoDa, setPagatoDa] = useState(tx.pagatoDa || persone[0]?.id || "");
  const [splits, setSplits] = useState(() => initialSplits(tx, persone));
  const [extraPersone, setExtraPersone] = useState(tx.extraPersone || []);
  const [intestataA, setIntestataA] = useState(tx.intestataA || persone[0]?.id || "");
  const [eContoId, setEContoId] = useState(tx.contoId || "");
  const [salvato, setSalvato] = useState(false);

  useEffect(() => {
    setTipo(tx.tipo); setImporto(String(tx.importo)); setCategoria(tx.categoria || "altro");
    setDescrizione(tx.descrizione || ""); setData(tx.data);
    setPagatoDa(tx.pagatoDa || persone[0]?.id || "");
    setSplits(initialSplits(tx, persone));
    setExtraPersone(tx.extraPersone || []);
    setIntestataA(tx.intestataA || persone[0]?.id || "");
    setEContoId(tx.contoId || "");
  }, [tx, persone]);

  function handleSave() {
    const val = parseFloat(String(importo).replace(",", "."));
    if (!val || val <= 0) return;
    if (tipo === "uscita" && !splitsTotalOk(splits)) {
      const total = (splits || []).reduce((s, x) => s + (x.quota || 0), 0);
      toast(t(lang, "form.splitTotalError").replace("{total}", String(Math.round(total * 100) / 100)), "error");
      return;
    }
    onSave({
      tipo, importo: val,
      categoria: tipo === "entrata" ? "entrata" : categoria,
      descrizione: descrizione.trim(), data,
      pagatoDa: tipo === "uscita" ? pagatoDa : null,
      splits: tipo === "uscita" ? splits : null,
      extraPersone: tipo === "uscita" && extraPersone.length > 0 ? extraPersone : null,
      intestataA: tipo === "entrata" ? intestataA : null,
      contoId: eContoId || null,
      ...(tx.daVerificare ? { daVerificare: false } : {}),
    });
    setSalvato(true);
    setTimeout(() => setSalvato(false), 1000);
  }

  const personaIntestata = persone.find(p => p.id === tx.intestataA);

  // Transfers: dedicated read-only row (no edit form, only delete)
  if (tx.tipo === "trasferimento") {
    const cDa = conti.find(c => c.id === tx.contoDa);
    const cA = conti.find(c => c.id === tx.contoA);
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 10, background: color.surface, borderRadius: 14, padding: "12px 14px", border: `1px solid ${color.border}` }}>
        <div style={{ width: 40, height: 40, borderRadius: 12, background: `${color.accent}22`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0 }}>⇄</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: color.textPrimary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{tx.descrizione || t(lang, "form.transfer")}</div>
          <div style={{ fontSize: 11, color: color.textMuted }}>
            {formattaData(tx.data)} · {cDa ? `${cDa.icona} ${cDa.nome}` : "?"} → {cA ? `${cA.icona} ${cA.nome}` : "?"}
          </div>
        </div>
        <div style={{ fontSize: 15, fontWeight: 700, fontFamily: moneyFont, fontVariantNumeric: "tabular-nums", color: color.accent, flexShrink: 0 }}>{formattaValuta(tx.importo)}</div>
        <button onClick={() => { if (confirm(t(lang, "form.deleteTransferConfirm"))) onDelete(); }} style={{ background: "none", border: "none", color: `${color.negative}55`, cursor: "pointer", fontSize: 14, padding: "0 2px", flexShrink: 0 }}>✕</button>
      </div>
    );
  }

  // Compact row
  if (!isEditing) {
    return (
      <div onClick={onTap} style={{ display: "flex", alignItems: "center", gap: 10, background: color.surface, borderRadius: 14, padding: "12px 14px", border: `1px solid ${color.border}`, cursor: "pointer", transition: "background 0.2s" }}>
        <div style={{ width: 40, height: 40, borderRadius: 12, background: cat.colore + "22", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0 }}>
          {cat.emoji}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: color.textPrimary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {tx.descrizione || cat.nome}
            {tx.ricorrenza && <span style={{ fontSize: 10, marginLeft: 5, color: color.accent }}>🔁</span>}
            {tx.daVerificare && <span title={t(lang, "form.checkAmountTitle")} style={{ fontSize: 10, marginLeft: 5, color: color.warn }}>⚠️</span>}
          </div>
          <div style={{ fontSize: 11, color: color.textMuted, display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
            {formattaData(tx.data)}
            {(() => { const c = conti.find(x => x.id === tx.contoId); return c ? <span title={c.nome} style={{ fontSize: 10 }}>{c.icona}</span> : null; })()}
            {persona && tx.tipo === "uscita" && (() => {
              // Ottieni lista partecipanti con quote
              let participants = [];
              if (tx.splits && Array.isArray(tx.splits) && tx.splits.length > 0) {
                participants = tx.splits.map(s => ({
                  id: s.personaId,
                  quota: s.quota,
                  persona: persone.find(p => p.id === s.personaId) || { id: s.personaId, nome: s.personaId, emoji: "👤", colore: color.textMuted }
                }));
              } else if (tx.splitPagante != null && tx.splitPagante !== 100) {
                // Vecchio formato a 2 persone
                const otherId = persone.find(p => p.id !== tx.pagatoDa)?.id;
                if (otherId) {
                  participants = [
                    { id: tx.pagatoDa, quota: tx.splitPagante, persona },
                    { id: otherId, quota: 100 - tx.splitPagante, persona: persone.find(p => p.id === otherId) }
                  ];
                }
              }
            
              const totalParticipants = participants.length;
              const payerIndex = participants.findIndex(p => p.id === tx.pagatoDa);
              const isEqualSplit = totalParticipants === 2 && participants[0]?.quota === 50 && participants[1]?.quota === 50;
            
              // Costruisci label concisa
              let splitLabel = "";
              if (totalParticipants === 2 && isEqualSplit) {
                // 50/50: mostra solo l'altra persona
                const other = participants.find(p => p.id !== tx.pagatoDa);
                splitLabel = ` · ${other?.persona.emoji}`;
              } else if (totalParticipants === 2 && !isEqualSplit) {
                // Due persone con quote diverse: mostra entrambe le percentuali
                const [p1, p2] = participants;
                splitLabel = ` · ${p1.quota}% / ${p2.quota}%`;
              } else if (totalParticipants > 2) {
                // Più di 2: mostra solo il numero di partecipanti
                splitLabel = ` · 👥 ${totalParticipants}`;
              }
            
              return (
                <span style={{
                  background: persona.colore + "33",
                  color: persona.colore,
                  borderRadius: 6,
                  padding: "1px 6px",
                  fontSize: 10,
                  fontWeight: 600,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                }}>
                  {persona.emoji} {persona.nome}{splitLabel}
                </span>
              );
            })()}
            {personaIntestata && tx.tipo === "entrata" && <span style={{ background: personaIntestata.colore + "33", color: personaIntestata.colore, borderRadius: 6, padding: "1px 5px", fontSize: 10, fontWeight: 600 }}>{personaIntestata.emoji}</span>}
          </div>
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700, fontFamily: moneyFont, fontVariantNumeric: "tabular-nums", color: tx.tipo === "entrata" ? color.positive : color.negative }}>{tx.tipo === "entrata" ? "+" : "-"}{formattaValuta(tx.importo)}</div>
          {tx.valuta && <div style={{ fontSize: 10, color: color.textMuted, fontFamily: moneyFont, fontVariantNumeric: "tabular-nums" }}>{tx.importoOriginale} {tx.valuta}</div>}
        </div>
      </div>
    );
  }

  // Expanded edit form
  return (
    <div style={{ background: color.surface, borderRadius: 16, padding: "16px", border: `2px solid ${color.accent}`, position: "relative", zIndex: 10, overflow: "hidden" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: color.textPrimary }}>{t(lang, "form.editTransaction")}</div>
        <button onClick={onCancel} style={{ background: "none", border: "none", color: color.textMuted, fontSize: 18, cursor: "pointer" }}>✕</button>
      </div>

      {/* Tipo */}
      <div style={{ display: "flex", background: color.bg, borderRadius: 12, padding: 3, marginBottom: 14, border: `1px solid ${color.border}` }}>
        {["uscita", "entrata"].map(tp => (
          <button key={tp} onClick={() => setTipo(tp)} style={{
            flex: 1, padding: "8px 0", border: "none", borderRadius: 10, cursor: "pointer",
            fontSize: 13, fontWeight: 600,
            background: tipo === tp ? (tp === "uscita" ? `${color.negative}22` : `${color.positive}22`) : "transparent",
            color: tipo === tp ? (tp === "uscita" ? color.negative : color.positive) : color.textMuted,
          }}>{tp === "uscita" ? t(lang, "type.expense") : t(lang, "type.income")}</button>
        ))}
      </div>

      {/* Importo */}
      <div style={{ marginBottom: 12 }}>
        <label style={labelStyle}>{t(lang, "home.filterAmount")} (€)</label>
        <input type="number" inputMode="decimal" value={importo} onChange={e => setImporto(e.target.value)}
          style={{ ...inputStyle, fontSize: 22, fontWeight: 800, fontFamily: moneyFont, fontVariantNumeric: "tabular-nums", textAlign: "center", color: tipo === "uscita" ? color.negative : color.positive, background: color.bg }} />
      </div>

      {/* Categoria */}
      {tipo === "uscita" && (
        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>{t(lang, "home.filterCategory")}</label>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 5 }}>
            {categorie.map(c => (
              <button key={c.id} onClick={() => setCategoria(c.id)} style={{
                background: categoria === c.id ? c.colore + "33" : color.bg,
                border: categoria === c.id ? `2px solid ${c.colore}88` : `2px solid ${color.border}`,
                borderRadius: 10, padding: "6px 2px", cursor: "pointer",
                display: "flex", flexDirection: "column", alignItems: "center", gap: 2,
              }}>
                <span style={{ fontSize: 16 }}>{c.emoji}</span>
                <span style={{ fontSize: 8, color: categoria === c.id ? c.colore : color.textMuted, fontWeight: 600 }}>{c.nome}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Chi ha pagato + split */}
      {tipo === "uscita" && (
        <SplitSelector pagatoDa={pagatoDa} setPagatoDa={setPagatoDa} splits={splits} setSplits={setSplits} persone={persone} importo={importo} extraPersone={extraPersone} setExtraPersone={setExtraPersone} lang={lang} />
      )}

      {/* Entrata di chi */}
      {tipo === "entrata" && (
        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>{t(lang, "form.whoseIncome")}</label>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {persone.map(p => (
              <button key={p.id} onClick={() => setIntestataA(p.id)} style={{
                flex: "1 1 auto", minWidth: 0, padding: "10px 6px", border: intestataA === p.id ? `2px solid ${p.colore}` : `2px solid ${color.border}`,
                borderRadius: 12, cursor: "pointer", background: intestataA === p.id ? p.colore + "22" : color.bg,
                display: "flex", alignItems: "center", justifyContent: "center", gap: 6, transition: "all 0.2s",
              }}>
                <span style={{ fontSize: 18 }}>{p.emoji}</span>
                <span style={{ fontSize: 12, fontWeight: 700, color: intestataA === p.id ? p.colore : color.textMuted }}>{p.nome}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Descrizione */}
      <div style={{ marginBottom: 12 }}>
        <label style={labelStyle}>{t(lang, "form.description")}</label>
        <input type="text" value={descrizione} onChange={e => setDescrizione(e.target.value)} placeholder={t(lang, "form.descriptionPlaceholder")} style={{ ...inputStyle, background: color.bg }} />
      </div>

      {/* Data */}
      <div style={{ marginBottom: 16 }}>
        <label style={labelStyle}>{t(lang, "form.date")}</label>
        <input type="date" value={data} onChange={e => setData(e.target.value)} style={{ ...inputStyle, background: color.bg, colorScheme: "dark" }} />
      </div>
      {/* Conto */}
      {conti.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <label style={labelStyle}>{t(lang, "home.filterAccount")}</label>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button onClick={() => setEContoId("")} style={{
              padding: "6px 10px", borderRadius: 8, cursor: "pointer", fontSize: 11, fontWeight: 600, fontFamily: displayFont,
              background: eContoId === "" ? `${color.accent}22` : color.bg,
              border: eContoId === "" ? `1px solid ${color.accent}` : `1px solid ${color.border}`,
              color: eContoId === "" ? color.accent : color.textMuted,
            }}>{t(lang, "form.none")}</button>
            {conti.map(c => (
              <button key={c.id} onClick={() => setEContoId(c.id)} style={{
                padding: "6px 10px", borderRadius: 8, cursor: "pointer", fontSize: 11, fontWeight: 600, fontFamily: displayFont,
                background: eContoId === c.id ? `${color.accent}22` : color.bg,
                border: eContoId === c.id ? `1px solid ${color.accent}` : `1px solid ${color.border}`,
                color: eContoId === c.id ? color.accent : color.textMuted,
              }}>{c.icona} {c.nome}</button>
            ))}
          </div>
        </div>
      )}

      {/* Actions */}
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={() => { if (confirm(t(lang, "form.deleteTransactionConfirm"))) onDelete(); }} style={{
          padding: "12px", border: "1px solid #FF6B6B44", borderRadius: 12, cursor: "pointer",
          background: `${color.negative}11`, color: color.negative, fontSize: 13, fontWeight: 600, flexShrink: 0,
        }}>{t(lang, "common.delete")}</button>
        <button onClick={handleSave} style={{
          flex: 1, padding: "12px", border: "none", borderRadius: 12, cursor: "pointer",
          fontSize: 14, fontWeight: 700, color: "#fff",
          background: salvato ? "linear-gradient(135deg, #4ECDC4, #3ab8b0)" : "linear-gradient(135deg, #6C5CE7, #a855f7)",
          boxShadow: "0 4px 16px #6C5CE744",
        }}>{salvato ? t(lang, "form.saved") : t(lang, "form.saveChanges")}</button>
      </div>
    </div>
  );
}
