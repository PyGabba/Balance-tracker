import { useState } from "react";
import { t } from "../../../lib/i18n.js";
import { formattaValuta } from "../../../lib/format.js";
import { labelStyle, inputStyle } from "../../../components/ui/styles.js";

// ─── Multi-person split selector ───
const COLORI_EXTRA = ["#E17055", "#74B9FF", "#55EFC4", "#FDCB6E", "#A29BFE", "#FF7675", "#00CEC9", "#FAB1A0"];

export function SplitSelector({ pagatoDa, setPagatoDa, splits, setSplits, persone, importo, extraPersone, setExtraPersone, lang = "it" }) {
  const [showAddExtra, setShowAddExtra] = useState(false);
  const [newName, setNewName] = useState("");

  // All participants = household persone + extra persone
  const allPersone = [...persone, ...(extraPersone || [])];

  function toggleParticipant(pid) {
    const current = splits || [];
    if (current.find(s => s.personaId === pid)) {
      // Remove, redistribute
      const remaining = current.filter(s => s.personaId !== pid);
      if (remaining.length > 0) {
        const each = Math.round(100 / remaining.length);
        const adjusted = remaining.map((s, i) => ({ ...s, quota: i === remaining.length - 1 ? 100 - each * (remaining.length - 1) : each }));
        setSplits(adjusted);
      } else {
        setSplits([]);
      }
    } else {
      // Add with equal split
      const newList = [...current, { personaId: pid, quota: 0 }];
      const each = Math.round(100 / newList.length);
      const adjusted = newList.map((s, i) => ({ ...s, quota: i === newList.length - 1 ? 100 - each * (newList.length - 1) : each }));
      setSplits(adjusted);
    }
  }

  function setQuota(pid, val) {
    setSplits((splits || []).map(s => s.personaId === pid ? { ...s, quota: Math.max(0, Math.min(100, val)) } : s));
  }

  function splitEqual() {
    const current = splits || [];
    if (current.length === 0) return;
    const each = Math.round(100 / current.length);
    setSplits(current.map((s, i) => ({ ...s, quota: i === current.length - 1 ? 100 - each * (current.length - 1) : each })));
  }

  function addExtraPerson() {
    if (!newName.trim()) return;
    const id = newName.trim().toLowerCase().replace(/\s+/g, "_");
    if (allPersone.find(p => p.id === id)) return;
    const ep = { id, nome: newName.trim(), emoji: "👤", colore: COLORI_EXTRA[(extraPersone || []).length % COLORI_EXTRA.length] };
    setExtraPersone([...(extraPersone || []), ep]);
    // Auto-add to split
    const newSplits = [...(splits || []), { personaId: id, quota: 0 }];
    const each = Math.round(100 / newSplits.length);
    setSplits(newSplits.map((s, i) => ({ ...s, quota: i === newSplits.length - 1 ? 100 - each * (newSplits.length - 1) : each })));
    setNewName("");
    setShowAddExtra(false);
  }

  const totalQuota = (splits || []).reduce((s, x) => s + x.quota, 0);
  const val = parseFloat(importo) || 0;

  return (
    <div style={{ marginBottom: 18 }}>
      {/* Who paid */}
      <label style={labelStyle}>{t(lang, "form.whoPaid")}</label>
      <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
        {allPersone.map(p => (
          <button key={p.id} onClick={() => setPagatoDa(p.id)} style={{
            flex: "1 0 auto", minWidth: 80, padding: "10px 8px",
            border: pagatoDa === p.id ? `2px solid ${p.colore}` : "2px solid #252538",
            borderRadius: 12, cursor: "pointer", background: pagatoDa === p.id ? p.colore + "22" : "#1a1a28",
            display: "flex", alignItems: "center", justifyContent: "center", gap: 6, transition: "all 0.2s",
          }}>
            <span style={{ fontSize: 18 }}>{p.emoji}</span>
            <span style={{ fontSize: 12, fontWeight: 700, color: pagatoDa === p.id ? p.colore : "#888" }}>{p.nome}</span>
          </button>
        ))}
      </div>

      {/* Participants */}
      <label style={labelStyle}>{t(lang, "form.whoParticipates")}</label>
      <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
        {allPersone.map(p => {
          const active = (splits || []).find(s => s.personaId === p.id);
          return (
            <button key={p.id} onClick={() => toggleParticipant(p.id)} style={{
              padding: "8px 12px", borderRadius: 10, cursor: "pointer",
              border: active ? `2px solid ${p.colore}` : "2px solid #252538",
              background: active ? p.colore + "22" : "#1a1a28",
              display: "flex", alignItems: "center", gap: 5, transition: "all 0.2s",
            }}>
              <span style={{ fontSize: 14 }}>{p.emoji}</span>
              <span style={{ fontSize: 11, fontWeight: 600, color: active ? p.colore : "#666" }}>{p.nome}</span>
            </button>
          );
        })}
        <button onClick={() => setShowAddExtra(!showAddExtra)} style={{
          padding: "8px 12px", borderRadius: 10, cursor: "pointer",
          border: "2px dashed #333355", background: "#1a1a28",
          color: "#6C5CE7", fontSize: 13, fontWeight: 700,
        }}>{t(lang, "form.addPerson")}</button>
      </div>

      {/* Add extra person */}
      {showAddExtra && (
        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          <input type="text" value={newName} onChange={e => setNewName(e.target.value)}
            onKeyDown={e => e.key === "Enter" && addExtraPerson()}
            placeholder={t(lang, "form.personNamePlaceholder")} style={{ ...inputStyle, flex: 1, padding: "10px 12px", fontSize: 13, background: "#111119" }} />
          <button onClick={addExtraPerson} style={{
            padding: "10px 16px", border: "none", borderRadius: 12, cursor: "pointer",
            background: "#6C5CE7", color: "#fff", fontSize: 12, fontWeight: 700, flexShrink: 0,
          }}>{t(lang, "common.add")}</button>
        </div>
      )}

      {/* Quick split buttons */}
      {(splits || []).length >= 2 && (
        <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
          <button onClick={splitEqual} style={{ flex: 1, padding: "7px 0", border: "2px solid #252538", borderRadius: 10, cursor: "pointer", background: "#1a1a28", color: "#6C5CE7", fontSize: 12, fontWeight: 700 }}>
            {t(lang, "form.splitEqually")}
          </button>
          <button onClick={() => {
            const s = (splits || []);
            if (s.length > 0) setSplits(s.map(x => x.personaId === pagatoDa ? { ...x, quota: 100 } : { ...x, quota: 0 }));
          }} style={{ flex: 1, padding: "7px 0", border: "2px solid #252538", borderRadius: 10, cursor: "pointer", background: "#1a1a28", color: "#888", fontSize: 12, fontWeight: 700 }}>
            {t(lang, "form.payer100")}
          </button>
        </div>
      )}

      {/* Per-person quota inputs */}
      {(splits || []).length > 0 && (
        <div style={{ background: "#111119", borderRadius: 12, padding: "10px 12px", border: "1px solid #252538" }}>
          {(splits || []).map(s => {
            const p = allPersone.find(x => x.id === s.personaId) || { nome: s.personaId, emoji: "👤", colore: "#888" };
            return (
              <div key={s.personaId} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px solid #1e1e2e" }}>
                <span style={{ fontSize: 16 }}>{p.emoji}</span>
                <span style={{ fontSize: 12, color: p.colore, fontWeight: 600, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.nome}</span>
                <input type="number" inputMode="numeric" value={s.quota} onChange={e => setQuota(s.personaId, parseInt(e.target.value) || 0)}
                  style={{ width: 50, padding: "4px 6px", background: "#1a1a28", border: "1px solid #252538", borderRadius: 8, color: "#eee", fontSize: 13, fontWeight: 700, textAlign: "center", fontFamily: "'Space Mono',monospace", outline: "none" }} />
                <span style={{ fontSize: 11, color: "#666", width: 14 }}>%</span>
                {val > 0 && <span style={{ fontSize: 11, color: "#aaa", fontFamily: "'Space Mono',monospace", minWidth: 55, textAlign: "right" }}>{formattaValuta(val * s.quota / Math.max(totalQuota, 1))}</span>}
              </div>
            );
          })}
          {totalQuota !== 100 && (
            <div style={{ fontSize: 11, color: totalQuota > 100 ? "#FF6B6B" : "#F0A500", marginTop: 6, fontWeight: 600 }}>
              {t(lang, "home.total")}: {totalQuota}% {totalQuota !== 100 ? t(lang, "form.shouldBe100") : ""}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
