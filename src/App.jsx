import { useState, useEffect, useCallback } from "react";
import { fetchTransactions, addTransaction, deleteTransaction, updateTransaction, isAPIConnected, login, logout, isLoggedIn, getSession, getPersone, getHouseholdName, fetchPositions, addPosition, deletePosition, fetchQuotes } from "./api.js";

const CATEGORIE = [
  { id: "cibo", nome: "Cibo", emoji: "🍕", colore: "#FF6B6B" },
  { id: "trasporti", nome: "Trasporti", emoji: "🚗", colore: "#4ECDC4" },
  { id: "casa", nome: "Casa", emoji: "🏠", colore: "#45B7D1" },
  { id: "salute", nome: "Salute", emoji: "💊", colore: "#96CEB4" },
  { id: "svago", nome: "Svago", emoji: "🎮", colore: "#FFEAA7" },
  { id: "shopping", nome: "Shopping", emoji: "🛍️", colore: "#DDA0DD" },
  { id: "bollette", nome: "Bollette", emoji: "💡", colore: "#F0A500" },
  { id: "altro", nome: "Altro", emoji: "📦", colore: "#A8A8A8" },
  { id: "entrata", nome: "Entrata", emoji: "💰", colore: "#4ECDC4" },
];

// PERSONE is now dynamic — loaded from session after login
// Fallback for offline/localStorage mode
const DEFAULT_PERSONE = [
  { id: "persona1", nome: "Persona 1", emoji: "👤", colore: "#E84393" },
  { id: "persona2", nome: "Persona 2", emoji: "👤", colore: "#0984E3" },
];

const SPLIT_PRESETS = [
  { label: "50/50", value: 50 },
  { label: "70/30", value: 70 },
  { label: "100%", value: 100 },
];

const MESI = ["Gen","Feb","Mar","Apr","Mag","Giu","Lug","Ago","Set","Ott","Nov","Dic"];

function generaId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function formattaValuta(n) { return new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" }).format(n); }
function formattaData(d) { return new Date(d).toLocaleDateString("it-IT", { day: "numeric", month: "short" }); }

// Storage is now handled by src/api.js (MongoDB + localStorage fallback)

// ─── Multi-person debt calculator ───
// Returns array: [{ da: personaId, a: personaId, importo: number }]
function calcolaDebitiMatrix(transazioni, persone) {
  const balances = {};
  for (const t of transazioni) {
    if (t.tipo !== "uscita" || !t.pagatoDa) continue;
    const payer = t.pagatoDa;
    let shares = [];

    if (t.splits && Array.isArray(t.splits) && t.splits.length > 0) {
      shares = t.splits;
    } else if (t.splitPagante != null) {
      // Old format backward compat
      const other = persone.find(p => p.id !== payer);
      if (other) shares = [{ personaId: payer, quota: t.splitPagante }, { personaId: other.id, quota: 100 - t.splitPagante }];
    }
    if (!shares.length) continue;
    const totalQ = shares.reduce((s, sh) => s + (sh.quota || 0), 0);
    if (totalQ === 0) continue;
    for (const sh of shares) {
      if (sh.personaId === payer) continue;
      const owed = t.importo * (sh.quota / totalQ);
      const key = `${sh.personaId}->${payer}`;
      balances[key] = (balances[key] || 0) + owed;
    }
  }
  // Net out pairs
  const pairs = new Set(), debiti = [];
  for (const key of Object.keys(balances)) {
    const [da, a] = key.split("->");
    const pk = [da, a].sort().join(":");
    if (pairs.has(pk)) continue; pairs.add(pk);
    const ab = balances[`${da}->${a}`] || 0;
    const ba = balances[`${a}->${da}`] || 0;
    const net = ab - ba;
    if (Math.abs(net) > 0.01) debiti.push(net > 0 ? { da, a, importo: Math.round(net * 100) / 100 } : { da: a, a: da, importo: Math.round(Math.abs(net) * 100) / 100 });
  }
  return debiti;
}

// Convenience: get all known people from transactions (household + extras)
function getAllPersone(transazioni, householdPersone) {
  const known = new Map(householdPersone.map(p => [p.id, p]));
  for (const t of transazioni) {
    if (t.extraPersone && Array.isArray(t.extraPersone)) {
      for (const ep of t.extraPersone) {
        if (!known.has(ep.id)) known.set(ep.id, ep);
      }
    }
    if (t.splits && Array.isArray(t.splits)) {
      for (const s of t.splits) {
        if (!known.has(s.personaId)) known.set(s.personaId, { id: s.personaId, nome: s.personaId, emoji: "👤", colore: "#888" });
      }
    }
  }
  return Array.from(known.values());
}

// ─── Multi-person split selector ───
const COLORI_EXTRA = ["#E17055", "#74B9FF", "#55EFC4", "#FDCB6E", "#A29BFE", "#FF7675", "#00CEC9", "#FAB1A0"];

function SplitSelector({ pagatoDa, setPagatoDa, splits, setSplits, persone, importo, extraPersone, setExtraPersone }) {
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
      <label style={labelStyle}>Chi ha pagato?</label>
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
      <label style={labelStyle}>Chi partecipa alla spesa?</label>
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
        }}>+ Persona</button>
      </div>

      {/* Add extra person */}
      {showAddExtra && (
        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          <input type="text" value={newName} onChange={e => setNewName(e.target.value)}
            onKeyDown={e => e.key === "Enter" && addExtraPerson()}
            placeholder="Nome persona..." style={{ ...inputStyle, flex: 1, padding: "10px 12px", fontSize: 13, background: "#111119" }} />
          <button onClick={addExtraPerson} style={{
            padding: "10px 16px", border: "none", borderRadius: 12, cursor: "pointer",
            background: "#6C5CE7", color: "#fff", fontSize: 12, fontWeight: 700, flexShrink: 0,
          }}>Aggiungi</button>
        </div>
      )}

      {/* Quick split buttons */}
      {(splits || []).length >= 2 && (
        <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
          <button onClick={splitEqual} style={{ flex: 1, padding: "7px 0", border: "2px solid #252538", borderRadius: 10, cursor: "pointer", background: "#1a1a28", color: "#6C5CE7", fontSize: 12, fontWeight: 700 }}>
            Dividi equamente
          </button>
          <button onClick={() => {
            const s = (splits || []);
            if (s.length > 0) setSplits(s.map(x => x.personaId === pagatoDa ? { ...x, quota: 100 } : { ...x, quota: 0 }));
          }} style={{ flex: 1, padding: "7px 0", border: "2px solid #252538", borderRadius: 10, cursor: "pointer", background: "#1a1a28", color: "#888", fontSize: 12, fontWeight: 700 }}>
            100% pagante
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
              Totale: {totalQuota}% {totalQuota !== 100 ? `(dovrebbe essere 100%)` : ""}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Charts ───
function MiniChart({ dati, maxVal }) {
  if (!dati.length) return null;
  const mx = maxVal || Math.max(...dati.map(d => d.valore), 1);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 100 }}>
      {dati.map((d, i) => (
        <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: 1 }}>
          <div style={{ width: "100%", maxWidth: 28, height: Math.max(2, (d.valore / mx) * 80),
            background: `linear-gradient(180deg, ${d.colore||"#6C5CE7"} 0%, ${d.colore||"#6C5CE7"}88 100%)`,
            borderRadius: "4px 4px 0 0", transition: "height 0.5s cubic-bezier(.4,0,.2,1)" }} />
          <span style={{ fontSize: 9, color: "#888", marginTop: 4 }}>{d.label}</span>
        </div>
      ))}
    </div>
  );
}

function DonutChart({ segmenti }) {
  const total = segmenti.reduce((s, x) => s + x.valore, 0) || 1;
  let accum = 0;
  const archi = segmenti.map(seg => { const pct = seg.valore / total; const start = accum; accum += pct; return { ...seg, start, end: accum }; });
  function arcPath(start, end, r = 42) {
    const s = start*Math.PI*2-Math.PI/2, e = end*Math.PI*2-Math.PI/2;
    const large = end-start > 0.5 ? 1 : 0;
    return `M ${50+r*Math.cos(s)} ${50+r*Math.sin(s)} A ${r} ${r} 0 ${large} 1 ${50+r*Math.cos(e)} ${50+r*Math.sin(e)}`;
  }
  return (
    <svg viewBox="0 0 100 100" width="140" height="140">
      {archi.map((a,i) => <path key={i} d={arcPath(a.start, a.end===1?0.9999:a.end)} fill="none" stroke={a.colore} strokeWidth="12" strokeLinecap="round" style={{filter:"drop-shadow(0 0 3px "+a.colore+"44)"}} />)}
      <text x="50" y="47" textAnchor="middle" fill="#eee" fontSize="10" fontWeight="700" fontFamily="'DM Sans',sans-serif">{formattaValuta(total)}</text>
      <text x="50" y="59" textAnchor="middle" fill="#888" fontSize="7" fontFamily="'DM Sans',sans-serif">totale</text>
    </svg>
  );
}

// ─── Month selector bar (fixed, shared between Home and Stats) ───
function MonthBar({ meseOffset, setMeseOffset }) {
  const oggi = new Date();
  const meseVis = new Date(oggi.getFullYear(), oggi.getMonth() - meseOffset, 1);
  const nomeMese = MESI[meseVis.getMonth()] + " " + meseVis.getFullYear();
  const navBtn = { background: "#1a1a28", border: "1px solid #252538", borderRadius: 10, color: "#eee", fontSize: 16, padding: "5px 12px", cursor: "pointer" };

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 16px", background: "#111119", borderBottom: "1px solid #1e1e2e", flexShrink: 0 }}>
      <button onClick={() => setMeseOffset(o => o + 1)} style={navBtn}>◂</button>
      <div style={{ fontSize: 16, fontWeight: 700, color: "#eee", fontFamily: "'DM Sans',sans-serif" }}>{nomeMese}</div>
      <button onClick={() => setMeseOffset(o => Math.max(0, o - 1))} style={{ ...navBtn, opacity: meseOffset === 0 ? 0.3 : 1 }} disabled={meseOffset === 0}>▸</button>
    </div>
  );
}

// ─── Tab bar ───
function TabBar({ tab, setTab, householdId }) {
  const baseTabs = [
    { id: "home", label: "Home", icon: "⌂" },
    { id: "aggiungi", label: "Aggiungi", icon: "+" },
    { id: "stats", label: "Statistiche", icon: "◔" },
    { id: "export", label: "Esporta", icon: "↓" },
  ];
  // Portfolio only for laura-gabriele
  const tabs = householdId === "laura-gabriele"
    ? [...baseTabs.slice(0, 3), { id: "portfolio", label: "Portfolio", icon: "📈" }, baseTabs[3]]
    : baseTabs;

  return (
    <div style={{
      display: "flex",
      justifyContent: "space-around",
      background: "#0E0E16",            // darker background
      borderTop: "1px solid #2A2A3E",
      // padding: "2px 0 max(2px)",
      // position: "sticky",
      bottom: 0,
      boxShadow: "0 -2px 12px rgba(0,0,0,0.4)",  // subtle top shadow
    }}>
      {tabs.map(t => {
        const isActive = tab === t.id;
        return (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 4,
              padding: "6px 12px",
              borderRadius: 30,
              transition: "all 0.2s ease",
              color: isActive ? "#FFFFFF" : "#AAAAAA",   // brighter inactive
              backgroundColor: isActive ? "rgba(108, 92, 231, 0.25)" : "transparent",
            }}
          >
            <span style={{
              fontSize: t.id === "aggiungi" ? 28 : 22,
              lineHeight: 1,
              fontWeight: isActive ? 700 : 400,
              textShadow: isActive ? "0 0 6px rgba(108,92,231,0.6)" : "none",
              transition: "inherit",
            }}>
              {t.icon}
            </span>
            <span style={{
              fontSize: 11,
              fontFamily: "'DM Sans',sans-serif",
              letterSpacing: 0.5,
              fontWeight: isActive ? 700 : 500,
              color: isActive ? "#FFFFFF" : "#AAAAAA",
            }}>
              {t.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ─── Home ───
function HomeView({ transazioni, onDelete, onEdit, onSettle, persone, meseOffset }) {
  const oggi = new Date();
  const [editId, setEditId] = useState(null);

  const meseVis = new Date(oggi.getFullYear(), oggi.getMonth() - meseOffset, 1);
  const nomeMese = MESI[meseVis.getMonth()] + " " + meseVis.getFullYear();

  const txMese = transazioni.filter(t => {
    const d = new Date(t.data);
    return d.getMonth() === meseVis.getMonth() && d.getFullYear() === meseVis.getFullYear();
  });
  const entrate = txMese.filter(t => t.tipo === "entrata").reduce((s, t) => s + t.importo, 0);
  const uscite = txMese.filter(t => t.tipo === "uscita").reduce((s, t) => s + t.importo, 0);
  const saldo = entrate - uscite;
  const txOrdinate = [...txMese].sort((a, b) => new Date(b.data) - new Date(a.data));

  const debitiGlobale = calcolaDebitiMatrix(transazioni, persone);
  const debitiMese = calcolaDebitiMatrix(txMese, persone);
  const allPeople = getAllPersone(transazioni, persone);
  const p1 = persone[0] || DEFAULT_PERSONE[0];
  const p2 = persone[1] || DEFAULT_PERSONE[1];

  return (
    <div>
      <div style={{ padding: "14px 16px 20px" }}>
      {/* Saldo card */}
      <div style={{ background: "linear-gradient(135deg, #1e1e30 0%, #2a1f4e 100%)", borderRadius: 20, padding: "24px 20px", marginBottom: 12, border: "1px solid #333355", boxShadow: "0 8px 32px #0005" }}>
        <div style={{ fontSize: 12, color: "#999", letterSpacing: 1, textTransform: "uppercase" }}>Saldo di {MESI[meseVis.getMonth()]}</div>
        <div style={{ fontSize: 36, fontWeight: 800, marginTop: 6, fontFamily: "'Space Mono', monospace", color: saldo >= 0 ? "#4ECDC4" : "#FF6B6B", letterSpacing: -1 }}>
          {saldo >= 0 ? "+" : ""}{formattaValuta(saldo)}
        </div>
        <div style={{ display: "flex", gap: 20, marginTop: 16 }}>
          <div>
            <div style={{ fontSize: 10, color: "#6a6", letterSpacing: 0.5 }}>▲ Entrate</div>
            <div style={{ fontSize: 16, fontWeight: 600, color: "#6C6", fontFamily: "'Space Mono',monospace" }}>{formattaValuta(entrate)}</div>
          </div>
          <div>
            <div style={{ fontSize: 10, color: "#a66", letterSpacing: 0.5 }}>▼ Uscite</div>
            <div style={{ fontSize: 16, fontWeight: 600, color: "#F66", fontFamily: "'Space Mono',monospace" }}>{formattaValuta(uscite)}</div>
          </div>
        </div>
      </div>

      {/* Debt card */}
      <div style={{ background: "#1a1a28", borderRadius: 16, padding: 16, marginBottom: 20, border: "1px solid #252538" }}>
        <div style={{ fontSize: 11, color: "#999", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 10 }}>Bilancio debiti</div>
        {/* Month debts */}
        <div style={{ fontSize: 10, color: "#777", marginBottom: 6 }}>{MESI[meseVis.getMonth()]}</div>
        {debitiMese.length === 0 ? <div style={{ fontSize: 13, color: "#888", marginBottom: 8 }}>Tutti pari</div> : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
            {debitiMese.map((d, i) => {
              const pDa = allPeople.find(p => p.id === d.da) || { nome: d.da, emoji: "👤", colore: "#888" };
              const pA = allPeople.find(p => p.id === d.a) || { nome: d.a, emoji: "👤", colore: "#888" };
              return (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 16 }}>{pDa.emoji}</span>
                  <span style={{ fontSize: 12, color: "#ccc", flex: 1 }}>{pDa.nome} → {pA.nome}</span>
                  <span style={{ fontSize: 14, fontWeight: 800, fontFamily: "'Space Mono',monospace", color: pA.colore }}>{formattaValuta(d.importo)}</span>
                </div>
              );
            })}
          </div>
        )}
        {/* Global debts */}
        <div style={{ borderTop: "1px solid #252538", paddingTop: 10 }}>
          <div style={{ fontSize: 10, color: "#777", marginBottom: 6 }}>Totale</div>
          {debitiGlobale.length === 0 ? <div style={{ fontSize: 13, color: "#888" }}>Tutti pari</div> : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {debitiGlobale.map((d, i) => {
                const pDa = allPeople.find(p => p.id === d.da) || { nome: d.da, emoji: "👤", colore: "#888" };
                const pA = allPeople.find(p => p.id === d.a) || { nome: d.a, emoji: "👤", colore: "#888" };
                return (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 16 }}>{pDa.emoji}</span>
                    <span style={{ fontSize: 12, color: "#ccc", flex: 1 }}>{pDa.nome} → {pA.nome}</span>
                    <span style={{ fontSize: 16, fontWeight: 800, fontFamily: "'Space Mono',monospace", color: pA.colore }}>{formattaValuta(d.importo)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        {/* Settle buttons */}
        {debitiGlobale.length > 0 && (
          <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
            {debitiGlobale.map((d, i) => {
              const pDa = allPeople.find(p => p.id === d.da) || { nome: d.da };
              const pA = allPeople.find(p => p.id === d.a) || { nome: d.a };
              return (
                <button key={i} onClick={() => {
                  if (!confirm(`Saldare?\n${pDa.nome} paga ${formattaValuta(d.importo)} a ${pA.nome}`)) return;
                  onSettle({
                    id: generaId(), tipo: "uscita", importo: d.importo, categoria: "altro",
                    descrizione: `Saldo debito → ${pA.nome}`, data: new Date().toISOString().slice(0, 10),
                    pagatoDa: d.da, splits: [{ personaId: d.a, quota: 100 }],
                  });
                }} style={{
                  width: "100%", padding: "10px", border: "none", borderRadius: 10, cursor: "pointer",
                  background: "linear-gradient(135deg, #4ECDC4, #3ab8b0)", color: "#fff",
                  fontSize: 12, fontWeight: 700, boxShadow: "0 2px 10px #4ECDC433",
                }}>
                  Salda {pDa.nome} → {pA.nome} ({formattaValuta(d.importo)})
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Transactions for selected month */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div style={{ fontSize: 13, color: "#999", letterSpacing: 0.5, textTransform: "uppercase" }}>Transazioni di {MESI[meseVis.getMonth()]}</div>
        <div style={{ fontSize: 12, color: "#666", fontFamily: "'Space Mono',monospace" }}>{txOrdinate.length}</div>
      </div>
      {txOrdinate.length === 0 ? (
        <div style={{ color: "#555", textAlign: "center", padding: 40, fontSize: 14 }}>Nessuna transazione in {nomeMese}.<br/>Premi + per iniziare!</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {txOrdinate.map(t => (
            <TransactionRow key={t.id} t={t} persone={persone} isEditing={editId === t.id}
              onTap={() => setEditId(editId === t.id ? null : t.id)}
              onDelete={() => { onDelete(t.id); setEditId(null); }}
              onSave={(updates) => { onEdit(t.id, updates); setEditId(null); }}
              onCancel={() => setEditId(null)}
            />
          ))}
        </div>
      )}

      {/* Edit overlay backdrop */}
      {editId && <div onClick={() => setEditId(null)} style={{ position: "fixed", inset: 0, background: "#0006", zIndex: 5 }} />}
      </div>
    </div>
  );
}

// ─── Transaction Row with inline edit ───
function TransactionRow({ t, persone, isEditing, onTap, onDelete, onSave, onCancel }) {
  const cat = CATEGORIE.find(c => c.id === t.categoria) || CATEGORIE[7];
  const persona = persone.find(p => p.id === t.pagatoDa);

  // Edit state
  const [tipo, setTipo] = useState(t.tipo);
  const [importo, setImporto] = useState(String(t.importo));
  const [categoria, setCategoria] = useState(t.categoria || "altro");
  const [descrizione, setDescrizione] = useState(t.descrizione || "");
  const [data, setData] = useState(t.data);
  const [pagatoDa, setPagatoDa] = useState(t.pagatoDa || persone[0]?.id || "");
  const [splits, setSplits] = useState(t.splits || (t.splitPagante != null ? [{ personaId: t.pagatoDa || persone[0]?.id, quota: t.splitPagante }, { personaId: persone.find(p=>p.id!==(t.pagatoDa||persone[0]?.id))?.id || persone[1]?.id, quota: 100 - (t.splitPagante||0) }] : persone.map(p => ({ personaId: p.id, quota: Math.round(100 / persone.length) }))));
  const [extraPersone, setExtraPersone] = useState(t.extraPersone || []);
  const [intestataA, setIntestataA] = useState(t.intestataA || persone[0]?.id || "");
  const [salvato, setSalvato] = useState(false);

  useEffect(() => {
    setTipo(t.tipo); setImporto(String(t.importo)); setCategoria(t.categoria || "altro");
    setDescrizione(t.descrizione || ""); setData(t.data);
    setPagatoDa(t.pagatoDa || persone[0]?.id || "");
    setSplits(t.splits || (t.splitPagante != null ? [{ personaId: t.pagatoDa || persone[0]?.id, quota: t.splitPagante }, { personaId: persone.find(p=>p.id!==(t.pagatoDa||persone[0]?.id))?.id || persone[1]?.id, quota: 100 - (t.splitPagante||0) }] : persone.map(p => ({ personaId: p.id, quota: Math.round(100 / persone.length) }))));
    setExtraPersone(t.extraPersone || []);
    setIntestataA(t.intestataA || persone[0]?.id || "");
  }, [t, persone]);

  function handleSave() {
    const val = parseFloat(String(importo).replace(",", "."));
    if (!val || val <= 0) return;
    onSave({
      tipo, importo: val,
      categoria: tipo === "entrata" ? "entrata" : categoria,
      descrizione: descrizione.trim(), data,
      pagatoDa: tipo === "uscita" ? pagatoDa : null,
      splits: tipo === "uscita" ? splits : null,
      extraPersone: tipo === "uscita" && extraPersone.length > 0 ? extraPersone : null,
      intestataA: tipo === "entrata" ? intestataA : null,
    });
    setSalvato(true);
    setTimeout(() => setSalvato(false), 1000);
  }

  const personaIntestata = persone.find(p => p.id === t.intestataA);

  // Compact row
  if (!isEditing) {
    return (
      <div onClick={onTap} style={{ display: "flex", alignItems: "center", gap: 10, background: "#1a1a28", borderRadius: 14, padding: "12px 14px", border: "1px solid #252538", cursor: "pointer", transition: "background 0.2s" }}>
        <div style={{ width: 40, height: 40, borderRadius: 12, background: cat.colore + "22", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0 }}>
          {cat.emoji}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "#eee", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.descrizione || cat.nome}</div>
          <div style={{ fontSize: 11, color: "#666", display: "flex", alignItems: "center", gap: 4 }}>
            {formattaData(t.data)}
            {persona && t.tipo === "uscita" && <span style={{ background: persona.colore + "33", color: persona.colore, borderRadius: 6, padding: "1px 5px", fontSize: 10, fontWeight: 600 }}>{persona.emoji} {t.splits && t.splits.length > 2 ? `÷${t.splits.length}` : t.splits ? "" : t.splitPagante != null && t.splitPagante !== 100 ? `${t.splitPagante}%` : ""}</span>}
            {personaIntestata && t.tipo === "entrata" && <span style={{ background: personaIntestata.colore + "33", color: personaIntestata.colore, borderRadius: 6, padding: "1px 5px", fontSize: 10, fontWeight: 600 }}>{personaIntestata.emoji}</span>}
          </div>
        </div>
        <div style={{ fontSize: 15, fontWeight: 700, fontFamily: "'Space Mono',monospace", color: t.tipo === "entrata" ? "#4ECDC4" : "#FF6B6B", flexShrink: 0 }}>{t.tipo === "entrata" ? "+" : "-"}{formattaValuta(t.importo)}</div>
      </div>
    );
  }

  // Expanded edit form
  return (
    <div style={{ background: "#1a1a28", borderRadius: 16, padding: "16px", border: "2px solid #6C5CE7", position: "relative", zIndex: 10, overflow: "hidden" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: "#eee" }}>Modifica transazione</div>
        <button onClick={onCancel} style={{ background: "none", border: "none", color: "#888", fontSize: 18, cursor: "pointer" }}>✕</button>
      </div>

      {/* Tipo */}
      <div style={{ display: "flex", background: "#111119", borderRadius: 12, padding: 3, marginBottom: 14, border: "1px solid #252538" }}>
        {["uscita", "entrata"].map(tp => (
          <button key={tp} onClick={() => setTipo(tp)} style={{
            flex: 1, padding: "8px 0", border: "none", borderRadius: 10, cursor: "pointer",
            fontSize: 13, fontWeight: 600,
            background: tipo === tp ? (tp === "uscita" ? "#FF6B6B22" : "#4ECDC422") : "transparent",
            color: tipo === tp ? (tp === "uscita" ? "#FF6B6B" : "#4ECDC4") : "#666",
          }}>{tp === "uscita" ? "▼ Uscita" : "▲ Entrata"}</button>
        ))}
      </div>

      {/* Importo */}
      <div style={{ marginBottom: 12 }}>
        <label style={labelStyle}>Importo (€)</label>
        <input type="number" inputMode="decimal" value={importo} onChange={e => setImporto(e.target.value)}
          style={{ ...inputStyle, fontSize: 22, fontWeight: 800, fontFamily: "'Space Mono',monospace", textAlign: "center", color: tipo === "uscita" ? "#FF6B6B" : "#4ECDC4", background: "#111119" }} />
      </div>

      {/* Categoria */}
      {tipo === "uscita" && (
        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>Categoria</label>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 5 }}>
            {CATEGORIE.filter(c => c.id !== "entrata").map(c => (
              <button key={c.id} onClick={() => setCategoria(c.id)} style={{
                background: categoria === c.id ? c.colore + "33" : "#111119",
                border: categoria === c.id ? `2px solid ${c.colore}88` : "2px solid #252538",
                borderRadius: 10, padding: "6px 2px", cursor: "pointer",
                display: "flex", flexDirection: "column", alignItems: "center", gap: 2,
              }}>
                <span style={{ fontSize: 16 }}>{c.emoji}</span>
                <span style={{ fontSize: 8, color: categoria === c.id ? c.colore : "#888", fontWeight: 600 }}>{c.nome}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Chi ha pagato + split */}
      {tipo === "uscita" && (
        <SplitSelector pagatoDa={pagatoDa} setPagatoDa={setPagatoDa} splits={splits} setSplits={setSplits} persone={persone} importo={importo} extraPersone={extraPersone} setExtraPersone={setExtraPersone} />
      )}

      {/* Entrata di chi */}
      {tipo === "entrata" && (
        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>Entrata di chi?</label>
          <div style={{ display: "flex", gap: 6 }}>
            {persone.map(p => (
              <button key={p.id} onClick={() => setIntestataA(p.id)} style={{
                flex: 1, padding: "10px 6px", border: intestataA === p.id ? `2px solid ${p.colore}` : "2px solid #252538",
                borderRadius: 12, cursor: "pointer", background: intestataA === p.id ? p.colore + "22" : "#111119",
                display: "flex", alignItems: "center", justifyContent: "center", gap: 6, transition: "all 0.2s",
              }}>
                <span style={{ fontSize: 18 }}>{p.emoji}</span>
                <span style={{ fontSize: 12, fontWeight: 700, color: intestataA === p.id ? p.colore : "#888" }}>{p.nome}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Descrizione */}
      <div style={{ marginBottom: 12 }}>
        <label style={labelStyle}>Descrizione</label>
        <input type="text" value={descrizione} onChange={e => setDescrizione(e.target.value)} placeholder="Es: Pranzo..." style={{ ...inputStyle, background: "#111119" }} />
      </div>

      {/* Data */}
      <div style={{ marginBottom: 16 }}>
        <label style={labelStyle}>Data</label>
        <input type="date" value={data} onChange={e => setData(e.target.value)} style={{ ...inputStyle, background: "#111119", colorScheme: "dark" }} />
      </div>

      {/* Actions */}
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={() => { if (confirm("Eliminare questa transazione?")) onDelete(); }} style={{
          padding: "12px", border: "1px solid #FF6B6B44", borderRadius: 12, cursor: "pointer",
          background: "#FF6B6B11", color: "#FF6B6B", fontSize: 13, fontWeight: 600, flexShrink: 0,
        }}>Elimina</button>
        <button onClick={handleSave} style={{
          flex: 1, padding: "12px", border: "none", borderRadius: 12, cursor: "pointer",
          fontSize: 14, fontWeight: 700, color: "#fff",
          background: salvato ? "linear-gradient(135deg, #4ECDC4, #3ab8b0)" : "linear-gradient(135deg, #6C5CE7, #a855f7)",
          boxShadow: "0 4px 16px #6C5CE744",
        }}>{salvato ? "✓ Salvato!" : "Salva modifiche"}</button>
      </div>
    </div>
  );
}

// ─── Add ───
function AggiungiView({ onAggiungi, persone }) {
  const [tipo, setTipo] = useState("uscita");
  const [importo, setImporto] = useState("");
  const [categoria, setCategoria] = useState("cibo");
  const [descrizione, setDescrizione] = useState("");
  const [data, setData] = useState(new Date().toISOString().slice(0, 10));
  const [salvato, setSalvato] = useState(false);
  const [pagatoDa, setPagatoDa] = useState(persone[0]?.id || "");
  const [splits, setSplits] = useState(persone.map((p, i) => ({ personaId: p.id, quota: i === 0 ? 50 : 50 })));
  const [extraPersone, setExtraPersone] = useState([]);
  const [intestataA, setIntestataA] = useState(persone[0]?.id || "");

  function handleSubmit() {
    const val = parseFloat(importo.replace(",", "."));
    if (!val || val <= 0) return;
    onAggiungi({
      id: generaId(), tipo, importo: val,
      categoria: tipo === "entrata" ? "entrata" : categoria,
      descrizione: descrizione.trim(), data,
      pagatoDa: tipo === "uscita" ? pagatoDa : null,
      splits: tipo === "uscita" ? splits : null,
      extraPersone: tipo === "uscita" && extraPersone.length > 0 ? extraPersone : null,
      intestataA: tipo === "entrata" ? intestataA : null,
    });
    setImporto(""); setDescrizione(""); setSalvato(true);
    setTimeout(() => setSalvato(false), 1500);
  }

  const val = parseFloat(importo.replace(",",".")) || 0;

  return (
    <div style={{ padding: "20px 16px" }}>
      <div style={{ fontSize: 22, fontWeight: 800, color: "#eee", marginBottom: 20 }}>Nuova transazione</div>
      <div style={{ display: "flex", background: "#1a1a28", borderRadius: 14, padding: 4, marginBottom: 20, border: "1px solid #252538" }}>
        {["uscita", "entrata"].map(t => (
          <button key={t} onClick={() => setTipo(t)} style={{
            flex: 1, padding: "10px 0", border: "none", borderRadius: 11, cursor: "pointer",
            fontFamily: "'DM Sans',sans-serif", fontSize: 14, fontWeight: 600,
            background: tipo===t?(t==="uscita"?"linear-gradient(135deg,#FF6B6B33,#FF6B6B22)":"linear-gradient(135deg,#4ECDC433,#4ECDC422)"):"transparent",
            color: tipo===t?(t==="uscita"?"#FF6B6B":"#4ECDC4"):"#666",
          }}>{t === "uscita" ? "▼ Uscita" : "▲ Entrata"}</button>
        ))}
      </div>
      <div style={{ marginBottom: 18 }}>
        <label style={labelStyle}>Importo (€)</label>
        <input type="number" inputMode="decimal" value={importo} onChange={e => setImporto(e.target.value)} placeholder="0,00"
          style={{ ...inputStyle, fontSize: 28, fontWeight: 800, fontFamily: "'Space Mono',monospace", textAlign: "center", color: tipo==="uscita"?"#FF6B6B":"#4ECDC4" }} />
      </div>
      {tipo === "uscita" && (
        <>
          <div style={{ marginBottom: 18 }}>
            <label style={labelStyle}>Categoria</label>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
              {CATEGORIE.filter(c => c.id !== "entrata").map(c => (
                <button key={c.id} onClick={() => setCategoria(c.id)} style={{
                  background: categoria===c.id?c.colore+"33":"#1a1a28", border: categoria===c.id?`2px solid ${c.colore}88`:"2px solid #252538",
                  borderRadius: 14, padding: "10px 4px", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
                }}>
                  <span style={{ fontSize: 22 }}>{c.emoji}</span>
                  <span style={{ fontSize: 10, color: categoria===c.id?c.colore:"#888", fontWeight: 600 }}>{c.nome}</span>
                </button>
              ))}
            </div>
          </div>
          <SplitSelector pagatoDa={pagatoDa} setPagatoDa={setPagatoDa} splits={splits} setSplits={setSplits} persone={persone} importo={importo} extraPersone={extraPersone} setExtraPersone={setExtraPersone} />
        </>
      )}
      {tipo === "entrata" && (
        <div style={{ marginBottom: 18 }}>
          <label style={labelStyle}>Entrata di chi?</label>
          <div style={{ display: "flex", gap: 8 }}>
            {persone.map(p => (
              <button key={p.id} onClick={() => setIntestataA(p.id)} style={{
                flex: 1, padding: "12px 8px", border: intestataA === p.id ? `2px solid ${p.colore}` : "2px solid #252538",
                borderRadius: 14, cursor: "pointer", background: intestataA === p.id ? p.colore + "22" : "#1a1a28",
                display: "flex", alignItems: "center", justifyContent: "center", gap: 8, transition: "all 0.2s",
              }}>
                <span style={{ fontSize: 22 }}>{p.emoji}</span>
                <span style={{ fontSize: 14, fontWeight: 700, color: intestataA === p.id ? p.colore : "#888", fontFamily: "'DM Sans',sans-serif" }}>{p.nome}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <div style={{ marginBottom: 18 }}>
        <label style={labelStyle}>Descrizione (opzionale)</label>
        <input type="text" value={descrizione} onChange={e => setDescrizione(e.target.value)} placeholder="Es: Pranzo, Benzina..." style={inputStyle} />
      </div>
      <div style={{ marginBottom: 24 }}>
        <label style={labelStyle}>Data</label>
        <input type="date" value={data} onChange={e => setData(e.target.value)} style={{ ...inputStyle, colorScheme: "dark" }} />
      </div>
      <button onClick={handleSubmit} style={{
        width: "100%", padding: "16px", border: "none", borderRadius: 16, cursor: "pointer",
        fontSize: 16, fontWeight: 700,
        background: tipo==="uscita"?"linear-gradient(135deg,#FF6B6B,#ee5a5a)":"linear-gradient(135deg,#4ECDC4,#3ab8b0)",
        color: "#fff", boxShadow: tipo==="uscita"?"0 4px 20px #FF6B6B44":"0 4px 20px #4ECDC444",
      }}>{salvato ? "✓ Salvato!" : "Salva transazione"}</button>
    </div>
  );
}

// ─── Scanner ───

const labelStyle = { display: "block", fontSize: 11, color: "#888", marginBottom: 6, letterSpacing: 0.5, textTransform: "uppercase" };
const inputStyle = { width: "100%", maxWidth: "100%", padding: "14px 16px", background: "#1a1a28", border: "1px solid #252538", borderRadius: 14, color: "#eee", fontSize: 15, fontFamily: "'DM Sans',sans-serif", outline: "none", boxSizing: "border-box", WebkitAppearance: "none" };

// ─── Stats ───
function StatsView({ transazioni, persone, meseOffset }) {
  const oggi = new Date();
  const meseVis = new Date(oggi.getFullYear(), oggi.getMonth() - meseOffset, 1);
  const nomeMese = MESI[meseVis.getMonth()] + " " + meseVis.getFullYear();
  const txMese = transazioni.filter(t => { const d=new Date(t.data); return d.getMonth()===meseVis.getMonth()&&d.getFullYear()===meseVis.getFullYear(); });
  const usciteMese = txMese.filter(t => t.tipo === "uscita");
  const totalUscite = usciteMese.reduce((s,t) => s+t.importo, 0);
  const totalEntrate = txMese.filter(t=>t.tipo==="entrata").reduce((s,t)=>s+t.importo,0);
  const perCategoria = CATEGORIE.filter(c=>c.id!=="entrata").map(cat=>({...cat,valore:usciteMese.filter(t=>t.categoria===cat.id).reduce((s,t)=>s+t.importo,0)})).filter(c=>c.valore>0).sort((a,b)=>b.valore-a.valore);
  const ultimi6 = Array.from({length:6},(_,i)=>{const m=new Date(oggi.getFullYear(),oggi.getMonth()-(5-i),1);return{label:MESI[m.getMonth()],valore:transazioni.filter(t=>t.tipo==="uscita"&&new Date(t.data).getMonth()===m.getMonth()&&new Date(t.data).getFullYear()===m.getFullYear()).reduce((s,t)=>s+t.importo,0),colore:"#6C5CE7"};});
  const p1 = persone[0] || DEFAULT_PERSONE[0];
  const p2 = persone[1] || DEFAULT_PERSONE[1];
  const p1Speso = usciteMese.filter(t=>t.pagatoDa===p1.id).reduce((s,t)=>s+t.importo,0);
  const p2Speso = usciteMese.filter(t=>t.pagatoDa===p2.id).reduce((s,t)=>s+t.importo,0);
  const debitiMese = calcolaDebitiMatrix(txMese, persone);

  // ─── Frequency analysis (must be before Trends) ───
  const numTransazioni = usciteMese.length;
  const spesaMedia = numTransazioni > 0 ? totalUscite / numTransazioni : 0;
  const giorniMese = new Date(meseVis.getFullYear(), meseVis.getMonth() + 1, 0).getDate();
  const perGiorno = Array.from({ length: giorniMese }, (_, i) => {
    const g = i + 1;
    const tot = usciteMese.filter(t => new Date(t.data).getDate() === g).reduce((s, t) => s + t.importo, 0);
    const count = usciteMese.filter(t => new Date(t.data).getDate() === g).length;
    return { giorno: g, totale: tot, count };
  });
  const maxGiorno = Math.max(...perGiorno.map(g => g.totale), 1);
  const fasce = [{ label: "0–10", min: 0, max: 10 },{ label: "10–25", min: 10, max: 25 },{ label: "25–50", min: 25, max: 50 },{ label: "50–100", min: 50, max: 100 },{ label: "100+", min: 100, max: Infinity }];
  const istogramma = fasce.map(f => ({ ...f, count: usciteMese.filter(t => t.importo >= f.min && t.importo < f.max).length }));
  const maxIsto = Math.max(...istogramma.map(f => f.count), 1);

  // ─── Trends & Insights ───
  const mesePrecedente = new Date(meseVis.getFullYear(), meseVis.getMonth() - 1, 1);
  const txMesePrec = transazioni.filter(t => { const d=new Date(t.data); return d.getMonth()===mesePrecedente.getMonth()&&d.getFullYear()===mesePrecedente.getFullYear(); });
  const usciteMesePrec = txMesePrec.filter(t => t.tipo === "uscita");
  const totalUscitePrec = usciteMesePrec.reduce((s,t) => s+t.importo, 0);
  const totalEntratePrec = txMesePrec.filter(t=>t.tipo==="entrata").reduce((s,t)=>s+t.importo,0);

  // Month over month change
  const deltaPct = totalUscitePrec > 0 ? ((totalUscite - totalUscitePrec) / totalUscitePrec * 100) : null;
  const deltaEntPct = totalEntratePrec > 0 ? ((totalEntrate - totalEntratePrec) / totalEntratePrec * 100) : null;

  // Category comparison vs previous month
  const catTrends = CATEGORIE.filter(c=>c.id!=="entrata").map(cat => {
    const curr = usciteMese.filter(t=>t.categoria===cat.id).reduce((s,t)=>s+t.importo,0);
    const prev = usciteMesePrec.filter(t=>t.categoria===cat.id).reduce((s,t)=>s+t.importo,0);
    const delta = prev > 0 ? ((curr - prev) / prev * 100) : (curr > 0 ? 100 : 0);
    return { ...cat, curr, prev, delta };
  }).filter(c => c.curr > 0 || c.prev > 0).sort((a,b) => Math.abs(b.delta) - Math.abs(a.delta));

  // Biggest single expense
  const maxTx = usciteMese.length > 0 ? usciteMese.reduce((a,b) => a.importo > b.importo ? a : b) : null;

  // Saving rate
  const savingRate = totalEntrate > 0 ? ((totalEntrate - totalUscite) / totalEntrate * 100) : 0;

  // Average daily spend
  const giornoOggi = meseVis.getMonth() === oggi.getMonth() && meseVis.getFullYear() === oggi.getFullYear() ? oggi.getDate() : giorniMese;
  const mediaGiornaliera = giornoOggi > 0 ? totalUscite / giornoOggi : 0;
  const mediaGiornalieraPrec = giorniMese > 0 && totalUscitePrec > 0 ? totalUscitePrec / new Date(mesePrecedente.getFullYear(), mesePrecedente.getMonth()+1, 0).getDate() : 0;

  // Top spending day
  const topDay = perGiorno.reduce((a,b) => a.totale > b.totale ? a : b, { giorno: 0, totale: 0 });

  // Generate smart insights
  const insights = [];
  if (deltaPct !== null) {
    if (deltaPct > 15) insights.push({ icon: "📈", color: "#FF6B6B", text: `Uscite in aumento del ${Math.round(deltaPct)}% rispetto a ${MESI[mesePrecedente.getMonth()]}` });
    else if (deltaPct < -15) insights.push({ icon: "📉", color: "#4ECDC4", text: `Uscite in calo del ${Math.round(Math.abs(deltaPct))}% rispetto a ${MESI[mesePrecedente.getMonth()]}` });
    else insights.push({ icon: "➡️", color: "#F0A500", text: `Spesa stabile rispetto a ${MESI[mesePrecedente.getMonth()]} (${deltaPct >= 0 ? "+" : ""}${Math.round(deltaPct)}%)` });
  }
  if (savingRate > 20) insights.push({ icon: "💪", color: "#4ECDC4", text: `Tasso di risparmio: ${Math.round(savingRate)}% — ottimo!` });
  else if (savingRate > 0) insights.push({ icon: "💡", color: "#F0A500", text: `Tasso di risparmio: ${Math.round(savingRate)}%` });
  else if (totalEntrate > 0) insights.push({ icon: "⚠️", color: "#FF6B6B", text: `Spendi più di quanto guadagni questo mese` });
  if (maxTx) {
    const maxCat = CATEGORIE.find(c=>c.id===maxTx.categoria);
    insights.push({ icon: "🏷️", color: "#DDA0DD", text: `Spesa più grande: ${formattaValuta(maxTx.importo)} — ${maxTx.descrizione || maxCat?.nome || ""}` });
  }
  if (topDay.totale > 0) insights.push({ icon: "📅", color: "#45B7D1", text: `Giorno più costoso: ${topDay.giorno} ${MESI[meseVis.getMonth()]} (${formattaValuta(topDay.totale)})` });
  const catUp = catTrends.find(c => c.delta > 30 && c.curr > 20);
  const catDown = catTrends.find(c => c.delta < -30 && c.prev > 20);
  if (catUp) insights.push({ icon: catUp.emoji, color: catUp.colore, text: `${catUp.nome} +${Math.round(catUp.delta)}% vs mese scorso (${formattaValuta(catUp.curr)})` });
  if (catDown) insights.push({ icon: catDown.emoji, color: catDown.colore, text: `${catDown.nome} ${Math.round(catDown.delta)}% vs mese scorso (${formattaValuta(catDown.curr)})` });
  if (mediaGiornaliera > 0) insights.push({ icon: "📊", color: "#6C5CE7", text: `Media giornaliera: ${formattaValuta(mediaGiornaliera)}/giorno` });

  return (
    <div>
      <div style={{ padding: "14px 16px 20px" }}>
      <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
        <div style={{ flex: 1, background: "#1a1a28", borderRadius: 16, padding: "16px 14px", border: "1px solid #252538" }}>
          <div style={{ fontSize: 10, color: "#6a6", letterSpacing: 0.5, textTransform: "uppercase" }}>Entrate</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: "#4ECDC4", fontFamily: "'Space Mono',monospace", marginTop: 4 }}>{formattaValuta(totalEntrate)}</div>
        </div>
        <div style={{ flex: 1, background: "#1a1a28", borderRadius: 16, padding: "16px 14px", border: "1px solid #252538" }}>
          <div style={{ fontSize: 10, color: "#a66", letterSpacing: 0.5, textTransform: "uppercase" }}>Uscite</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: "#FF6B6B", fontFamily: "'Space Mono',monospace", marginTop: 4 }}>{formattaValuta(totalUscite)}</div>
        </div>
      </div>
      {(p1Speso > 0 || p2Speso > 0) && (
        <div style={{ background: "#1a1a28", borderRadius: 16, padding: "14px 16px", marginBottom: 16, border: "1px solid #252538" }}>
          <div style={{ fontSize: 11, color: "#999", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 10 }}>Chi ha pagato</div>
          <div style={{ display: "flex", gap: 12, marginBottom: 10 }}>
            <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 20 }}>{p1.emoji}</span>
              <div><div style={{ fontSize: 11, color: p1.colore, fontWeight: 600 }}>{p1.nome}</div><div style={{ fontSize: 15, fontWeight: 700, color: "#eee", fontFamily: "'Space Mono',monospace" }}>{formattaValuta(p1Speso)}</div></div>
            </div>
            <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 20 }}>{p2.emoji}</span>
              <div><div style={{ fontSize: 11, color: p2.colore, fontWeight: 600 }}>{p2.nome}</div><div style={{ fontSize: 15, fontWeight: 700, color: "#eee", fontFamily: "'Space Mono',monospace" }}>{formattaValuta(p2Speso)}</div></div>
            </div>
          </div>
          {debitiMese.length > 0 && (
            <div style={{ borderTop: "1px solid #252538", paddingTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
              {debitiMese.map((d, i) => {
                const allP = getAllPersone(transazioni, persone);
                const pDa = allP.find(p => p.id === d.da) || { nome: d.da, emoji: "👤", colore: "#888" };
                const pA = allP.find(p => p.id === d.a) || { nome: d.a, emoji: "👤", colore: "#888" };
                return (
                  <div key={i} style={{ fontSize: 12, color: "#ccc" }}>
                    <span>{pDa.emoji} {pDa.nome} deve <strong style={{ color: pA.colore }}>{formattaValuta(d.importo)}</strong> a {pA.nome}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
      {perCategoria.length > 0 && (
        <div style={{ background: "#1a1a28", borderRadius: 20, padding: 20, marginBottom: 24, border: "1px solid #252538" }}>
          <div style={{ fontSize: 12, color: "#999", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 16 }}>Spese per categoria</div>
          <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
            <DonutChart segmenti={perCategoria} />
            <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1 }}>
              {perCategoria.map(c => (
                <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ width: 10, height: 10, borderRadius: 3, background: c.colore, flexShrink: 0 }} />
                  <span style={{ fontSize: 12, color: "#ccc", flex: 1 }}>{c.emoji} {c.nome}</span>
                  <span style={{ fontSize: 12, color: "#eee", fontWeight: 600, fontFamily: "'Space Mono',monospace" }}>{formattaValuta(c.valore)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      <div style={{ background: "#1a1a28", borderRadius: 20, padding: 20, border: "1px solid #252538", marginBottom: 24 }}>
        <div style={{ fontSize: 12, color: "#999", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 16 }}>Trend uscite (6 mesi)</div>
        <MiniChart dati={ultimi6} />
      </div>

      {numTransazioni > 0 && (
        <>
          <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
            <div style={{ flex: 1, background: "#1a1a28", borderRadius: 16, padding: "14px", border: "1px solid #252538", textAlign: "center" }}>
              <div style={{ fontSize: 10, color: "#999", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 4 }}>Transazioni</div>
              <div style={{ fontSize: 26, fontWeight: 800, color: "#6C5CE7", fontFamily: "'Space Mono',monospace" }}>{numTransazioni}</div>
            </div>
            <div style={{ flex: 1, background: "#1a1a28", borderRadius: 16, padding: "14px", border: "1px solid #252538", textAlign: "center" }}>
              <div style={{ fontSize: 10, color: "#999", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 4 }}>Spesa media</div>
              <div style={{ fontSize: 18, fontWeight: 800, color: "#FF6B6B", fontFamily: "'Space Mono',monospace" }}>{formattaValuta(spesaMedia)}</div>
            </div>
            <div style={{ flex: 1, background: "#1a1a28", borderRadius: 16, padding: "14px", border: "1px solid #252538", textAlign: "center" }}>
              <div style={{ fontSize: 10, color: "#999", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 4 }}>Freq. giorn.</div>
              <div style={{ fontSize: 18, fontWeight: 800, color: "#4ECDC4", fontFamily: "'Space Mono',monospace" }}>{(numTransazioni / giorniMese).toFixed(1)}<span style={{ fontSize: 11, color: "#888" }}>/g</span></div>
            </div>
          </div>
          <div style={{ background: "#1a1a28", borderRadius: 20, padding: 20, marginBottom: 16, border: "1px solid #252538" }}>
            <div style={{ fontSize: 12, color: "#999", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 14 }}>Distribuzione importi (€)</div>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 90 }}>
              {istogramma.map((f, i) => (
                <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center" }}>
                  {f.count > 0 && <div style={{ fontSize: 10, color: "#aaa", marginBottom: 4, fontFamily: "'Space Mono',monospace", fontWeight: 700 }}>{f.count}</div>}
                  <div style={{ width: "100%", maxWidth: 40, height: Math.max(3, (f.count / maxIsto) * 65),
                    background: `linear-gradient(180deg, ${["#6C5CE7","#a855f7","#FF6B6B","#F0A500","#E84393"][i]} 0%, ${["#6C5CE7","#a855f7","#FF6B6B","#F0A500","#E84393"][i]}66 100%)`,
                    borderRadius: "5px 5px 0 0", transition: "height 0.4s ease" }} />
                  <div style={{ fontSize: 9, color: "#777", marginTop: 5, whiteSpace: "nowrap" }}>{f.label}</div>
                </div>
              ))}
            </div>
          </div>
          <div style={{ background: "#1a1a28", borderRadius: 20, padding: 20, marginBottom: 24, border: "1px solid #252538" }}>
            <div style={{ fontSize: 12, color: "#999", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 14 }}>Heatmap spese giornaliere</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4 }}>
              {perGiorno.map((g) => {
                const intensity = g.totale / maxGiorno;
                const bg = g.totale === 0 ? "#1e1e2e" : `rgba(108, 92, 231, ${0.15 + intensity * 0.85})`;
                return (
                  <div key={g.giorno} title={`${g.giorno}: ${formattaValuta(g.totale)} (${g.count} tx)`} style={{
                    aspectRatio: "1", borderRadius: 6, background: bg,
                    display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                    border: g.totale > 0 ? "1px solid #6C5CE744" : "1px solid #252538", cursor: "default",
                  }}>
                    <div style={{ fontSize: 10, fontWeight: 600, color: g.totale > 0 ? "#eee" : "#555" }}>{g.giorno}</div>
                    {g.totale > 0 && <div style={{ fontSize: 7, color: "#ccc", fontFamily: "'Space Mono',monospace", marginTop: 1 }}>{g.totale >= 1000 ? Math.round(g.totale/1000)+"k" : Math.round(g.totale)}</div>}
                  </div>
                );
              })}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 12, justifyContent: "center" }}>
              <span style={{ fontSize: 9, color: "#666" }}>Meno</span>
              {[0, 0.25, 0.5, 0.75, 1].map((v, i) => (
                <div key={i} style={{ width: 14, height: 14, borderRadius: 3, background: v === 0 ? "#1e1e2e" : `rgba(108, 92, 231, ${0.15 + v * 0.85})` }} />
              ))}
              <span style={{ fontSize: 9, color: "#666" }}>Più</span>
            </div>
          </div>
        </>
      )}

      {/* ─── Trends & Insights ─── */}
      {(insights.length > 0 || catTrends.length > 0) && (
        <>
          {/* Smart insights */}
          {insights.length > 0 && (
            <div style={{ background: "#1a1a28", borderRadius: 20, padding: 20, marginBottom: 16, border: "1px solid #252538" }}>
              <div style={{ fontSize: 12, color: "#999", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 14 }}>Insights</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {insights.map((ins, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                    <span style={{ fontSize: 18, flexShrink: 0, lineHeight: 1.2 }}>{ins.icon}</span>
                    <span style={{ fontSize: 13, color: "#ccc", fontFamily: "'DM Sans',sans-serif", lineHeight: 1.4 }}>{ins.text}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Month over month comparison bars */}
          {totalUscitePrec > 0 && (
            <div style={{ background: "#1a1a28", borderRadius: 20, padding: 20, marginBottom: 16, border: "1px solid #252538" }}>
              <div style={{ fontSize: 12, color: "#999", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 14 }}>Confronto vs {MESI[mesePrecedente.getMonth()]}</div>
              {/* Uscite comparison */}
              <div style={{ marginBottom: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                  <span style={{ fontSize: 11, color: "#888" }}>Uscite</span>
                  <span style={{ fontSize: 12, fontWeight: 700, fontFamily: "'Space Mono',monospace", color: deltaPct > 0 ? "#FF6B6B" : "#4ECDC4" }}>
                    {deltaPct >= 0 ? "+" : ""}{Math.round(deltaPct)}%
                  </span>
                </div>
                <div style={{ display: "flex", gap: 4, height: 20 }}>
                  <div style={{ position: "relative", flex: 1, background: "#252538", borderRadius: 6, overflow: "hidden" }}>
                    <div style={{ position: "absolute", inset: 0, width: `${Math.min(100, totalUscitePrec / Math.max(totalUscite, totalUscitePrec) * 100)}%`, background: "#FF6B6B44", borderRadius: 6 }} />
                    <div style={{ position: "relative", padding: "2px 8px", fontSize: 10, color: "#aaa" }}>{MESI[mesePrecedente.getMonth()]} {formattaValuta(totalUscitePrec)}</div>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 4, height: 20, marginTop: 4 }}>
                  <div style={{ position: "relative", flex: 1, background: "#252538", borderRadius: 6, overflow: "hidden" }}>
                    <div style={{ position: "absolute", inset: 0, width: `${Math.min(100, totalUscite / Math.max(totalUscite, totalUscitePrec) * 100)}%`, background: "#FF6B6B88", borderRadius: 6 }} />
                    <div style={{ position: "relative", padding: "2px 8px", fontSize: 10, color: "#eee", fontWeight: 600 }}>{MESI[meseVis.getMonth()]} {formattaValuta(totalUscite)}</div>
                  </div>
                </div>
              </div>
              {/* Entrate comparison */}
              {(totalEntrate > 0 || totalEntratePrec > 0) && (
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                    <span style={{ fontSize: 11, color: "#888" }}>Entrate</span>
                    {deltaEntPct !== null && <span style={{ fontSize: 12, fontWeight: 700, fontFamily: "'Space Mono',monospace", color: deltaEntPct >= 0 ? "#4ECDC4" : "#FF6B6B" }}>
                      {deltaEntPct >= 0 ? "+" : ""}{Math.round(deltaEntPct)}%
                    </span>}
                  </div>
                  <div style={{ display: "flex", gap: 4, height: 20 }}>
                    <div style={{ position: "relative", flex: 1, background: "#252538", borderRadius: 6, overflow: "hidden" }}>
                      <div style={{ position: "absolute", inset: 0, width: `${Math.min(100, totalEntratePrec / Math.max(totalEntrate, totalEntratePrec, 1) * 100)}%`, background: "#4ECDC444", borderRadius: 6 }} />
                      <div style={{ position: "relative", padding: "2px 8px", fontSize: 10, color: "#aaa" }}>{MESI[mesePrecedente.getMonth()]} {formattaValuta(totalEntratePrec)}</div>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 4, height: 20, marginTop: 4 }}>
                    <div style={{ position: "relative", flex: 1, background: "#252538", borderRadius: 6, overflow: "hidden" }}>
                      <div style={{ position: "absolute", inset: 0, width: `${Math.min(100, totalEntrate / Math.max(totalEntrate, totalEntratePrec, 1) * 100)}%`, background: "#4ECDC488", borderRadius: 6 }} />
                      <div style={{ position: "relative", padding: "2px 8px", fontSize: 10, color: "#eee", fontWeight: 600 }}>{MESI[meseVis.getMonth()]} {formattaValuta(totalEntrate)}</div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Category trends vs previous month */}
          {catTrends.length > 0 && totalUscitePrec > 0 && (
            <div style={{ background: "#1a1a28", borderRadius: 20, padding: 20, marginBottom: 16, border: "1px solid #252538" }}>
              <div style={{ fontSize: 12, color: "#999", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 14 }}>Trend per categoria</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {catTrends.slice(0, 6).map(c => (
                  <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 16, width: 24, textAlign: "center", flexShrink: 0 }}>{c.emoji}</span>
                    <span style={{ fontSize: 12, color: "#ccc", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.nome}</span>
                    <span style={{ fontSize: 12, fontWeight: 600, fontFamily: "'Space Mono',monospace", color: "#888", flexShrink: 0 }}>{formattaValuta(c.curr)}</span>
                    <span style={{
                      fontSize: 11, fontWeight: 700, fontFamily: "'Space Mono',monospace", flexShrink: 0,
                      padding: "2px 6px", borderRadius: 6, minWidth: 48, textAlign: "center",
                      color: c.delta > 10 ? "#FF6B6B" : c.delta < -10 ? "#4ECDC4" : "#F0A500",
                      background: c.delta > 10 ? "#FF6B6B15" : c.delta < -10 ? "#4ECDC415" : "#F0A50015",
                    }}>
                      {c.delta >= 0 ? "+" : ""}{Math.round(c.delta)}%
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Saving rate gauge */}
          {totalEntrate > 0 && (
            <div style={{ background: "#1a1a28", borderRadius: 20, padding: 20, marginBottom: 24, border: "1px solid #252538" }}>
              <div style={{ fontSize: 12, color: "#999", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 14 }}>Tasso di risparmio</div>
              <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                {/* Gauge ring */}
                <svg viewBox="0 0 80 80" width="70" height="70" style={{ flexShrink: 0 }}>
                  <circle cx="40" cy="40" r="32" fill="none" stroke="#252538" strokeWidth="8" />
                  <circle cx="40" cy="40" r="32" fill="none"
                    stroke={savingRate > 20 ? "#4ECDC4" : savingRate > 0 ? "#F0A500" : "#FF6B6B"}
                    strokeWidth="8" strokeLinecap="round"
                    strokeDasharray={`${Math.max(0, Math.min(100, savingRate)) / 100 * 201} 201`}
                    transform="rotate(-90 40 40)" />
                  <text x="40" y="38" textAnchor="middle" fill="#eee" fontSize="14" fontWeight="800" fontFamily="'Space Mono',monospace">
                    {Math.round(savingRate)}%
                  </text>
                  <text x="40" y="50" textAnchor="middle" fill="#888" fontSize="7" fontFamily="'DM Sans',sans-serif">risparmio</text>
                </svg>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, color: "#ccc", marginBottom: 4 }}>
                    {savingRate > 30 ? "Eccellente! Stai risparmiando molto." :
                     savingRate > 15 ? "Buon lavoro, stai risparmiando." :
                     savingRate > 0 ? "Margine ridotto — attenzione alle spese." :
                     "Stai spendendo più di quanto guadagni."}
                  </div>
                  <div style={{ fontSize: 11, color: "#888" }}>
                    Risparmiati: {formattaValuta(Math.max(0, totalEntrate - totalUscite))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {perCategoria.length === 0 && <div style={{ color: "#555", textAlign: "center", padding: 40, fontSize: 14 }}>Nessun dato per questo mese.</div>}
      </div>
    </div>
  );
}

// ─── Portfolio View ───
function PortfolioView() {
  const [positions, setPositions] = useState([]);
  const [quotesData, setQuotesData] = useState({ quotes: {}, cached: false, aggiornamento: "" });
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [ticker, setTicker] = useState("");
  const [nome, setNome] = useState("");
  const [quantita, setQuantita] = useState("");
  const [prezzoAcquisto, setPrezzoAcquisto] = useState("");
  const [dataAcquisto, setDataAcquisto] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState("");
  const [adding, setAdding] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const quotes = quotesData.quotes || {};

  // Load positions
  useEffect(() => {
    (async () => {
      try {
        const data = await fetchPositions();
        setPositions(data);
      } catch (e) { console.error(e); }
      setLoading(false);
    })();
  }, []);

  // Aggregate: group by ticker, sum quantities
  const holdings = [];
  const tickerMap = {};
  for (const p of positions) {
    if (!tickerMap[p.ticker]) {
      tickerMap[p.ticker] = { ticker: p.ticker, nome: p.nome || p.ticker, quantita: 0, costoTotale: 0, trades: [] };
    }
    const h = tickerMap[p.ticker];
    if (p.tipo === "sell") {
      h.quantita -= p.quantita;
      h.costoTotale -= p.quantita * p.prezzoAcquisto;
    } else {
      h.quantita += p.quantita;
      h.costoTotale += p.quantita * p.prezzoAcquisto;
    }
    h.trades.push(p);
  }
  for (const k of Object.keys(tickerMap)) {
    const h = tickerMap[k];
    if (h.quantita > 0.0001) {
      h.prezzoMedio = h.costoTotale / h.quantita;
      holdings.push(h);
    }
  }

  // Fetch quotes when holdings change (uses daily cache)
  useEffect(() => {
    if (holdings.length === 0) return;
    fetchQuotes(holdings.map(h => h.ticker)).then(r => setQuotesData(r));
  }, [positions.length]);

  // Force refresh bypasses daily cache
  async function refreshQuotes() {
    if (holdings.length === 0) return;
    setRefreshing(true);
    const r = await fetchQuotes(holdings.map(h => h.ticker), true);
    setQuotesData(r);
    setRefreshing(false);
  }

  async function handleAdd() {
    if (!ticker.trim() || !quantita || !prezzoAcquisto) return;
    setAdding(true);
    try {
      const pos = await addPosition({
        ticker: ticker.trim().toUpperCase(), nome: nome.trim() || ticker.trim().toUpperCase(),
        quantita: parseFloat(quantita), prezzoAcquisto: parseFloat(prezzoAcquisto),
        dataAcquisto, note: note.trim(), tipo: "buy",
      });
      setPositions(prev => [...prev, pos]);
      setTicker(""); setNome(""); setQuantita(""); setPrezzoAcquisto(""); setNote("");
      setShowAdd(false);
    } catch (e) { console.error(e); }
    setAdding(false);
  }

  async function handleDelete(id) {
    if (!confirm("Eliminare questa posizione?")) return;
    await deletePosition(id);
    setPositions(prev => prev.filter(p => p.id !== id));
  }

  // Portfolio totals
  let totalInvestito = 0, totalValore = 0;
  for (const h of holdings) {
    const q = quotes[h.ticker];
    totalInvestito += h.costoTotale;
    totalValore += q ? h.quantita * q.prezzo : h.costoTotale;
  }
  const totalPL = totalValore - totalInvestito;
  const totalPLPct = totalInvestito > 0 ? (totalPL / totalInvestito * 100) : 0;

  if (loading) return <div style={{ padding: 40, textAlign: "center", color: "#888" }}>Caricamento portfolio...</div>;

  return (
    <div style={{ padding: "20px 16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 800, color: "#eee" }}>Portfolio</div>
          <div style={{ fontSize: 12, color: "#888" }}>{holdings.length} titoli</div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={refreshQuotes} disabled={refreshing} title="Aggiorna prezzi (forza)" style={{
            background: "none", border: "1px solid #252538", borderRadius: 8, cursor: "pointer",
            color: "#888", fontSize: 13, padding: "6px 10px", opacity: refreshing ? 0.5 : 1,
          }}>{refreshing ? "..." : "↻"}</button>
          <button onClick={() => setShowAdd(!showAdd)} style={{
            background: showAdd ? "#6C5CE722" : "none", border: showAdd ? "1px solid #6C5CE7" : "1px solid #252538",
            borderRadius: 8, cursor: "pointer", color: showAdd ? "#6C5CE7" : "#888", fontSize: 16, padding: "4px 10px",
          }}>{showAdd ? "✕" : "+"}</button>
        </div>
      </div>
      {/* Cache info */}
      {quotesData.aggiornamento && (
        <div style={{ fontSize: 11, color: "#555", marginBottom: 14 }}>
          Prezzi aggiornati al {quotesData.aggiornamento}{quotesData.cached ? " (cache)" : " (live)"} — ↻ per forzare aggiornamento
        </div>
      )}

      {/* Summary card */}
      {holdings.length > 0 && (
        <div style={{ background: "linear-gradient(135deg, #1e1e30 0%, #2a1f4e 100%)", borderRadius: 20, padding: "20px", marginBottom: 16, border: "1px solid #333355", boxShadow: "0 8px 32px #0005" }}>
          <div style={{ fontSize: 11, color: "#999", letterSpacing: 0.5, textTransform: "uppercase" }}>Valore portafoglio</div>
          <div style={{ fontSize: 32, fontWeight: 800, fontFamily: "'Space Mono',monospace", color: "#eee", marginTop: 4 }}>
            {formattaValuta(totalValore)}
          </div>
          <div style={{ display: "flex", gap: 16, marginTop: 12 }}>
            <div>
              <div style={{ fontSize: 10, color: "#888" }}>Investito</div>
              <div style={{ fontSize: 14, fontWeight: 600, fontFamily: "'Space Mono',monospace", color: "#aaa" }}>{formattaValuta(totalInvestito)}</div>
            </div>
            <div>
              <div style={{ fontSize: 10, color: "#888" }}>P&L</div>
              <div style={{ fontSize: 14, fontWeight: 700, fontFamily: "'Space Mono',monospace", color: totalPL >= 0 ? "#4ECDC4" : "#FF6B6B" }}>
                {totalPL >= 0 ? "+" : ""}{formattaValuta(totalPL)} ({totalPLPct >= 0 ? "+" : ""}{totalPLPct.toFixed(1)}%)
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Add form */}
      {showAdd && (
        <div style={{ background: "#1a1a28", borderRadius: 16, padding: 16, marginBottom: 16, border: "2px solid #6C5CE7" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#eee", marginBottom: 12 }}>Aggiungi posizione</div>
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>Ticker</label>
              <input type="text" value={ticker} onChange={e => setTicker(e.target.value.toUpperCase())} placeholder="AAPL"
                style={{ ...inputStyle, fontSize: 16, fontWeight: 700, fontFamily: "'Space Mono',monospace", textTransform: "uppercase", background: "#111119" }} />
            </div>
            <div style={{ flex: 2 }}>
              <label style={labelStyle}>Nome (opzionale)</label>
              <input type="text" value={nome} onChange={e => setNome(e.target.value)} placeholder="Apple Inc."
                style={{ ...inputStyle, background: "#111119" }} />
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>Quantità</label>
              <input type="number" inputMode="decimal" value={quantita} onChange={e => setQuantita(e.target.value)} placeholder="10"
                style={{ ...inputStyle, fontFamily: "'Space Mono',monospace", background: "#111119" }} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>Prezzo acquisto (€)</label>
              <input type="number" inputMode="decimal" value={prezzoAcquisto} onChange={e => setPrezzoAcquisto(e.target.value)} placeholder="150.00"
                style={{ ...inputStyle, fontFamily: "'Space Mono',monospace", background: "#111119" }} />
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>Data acquisto</label>
              <input type="date" value={dataAcquisto} onChange={e => setDataAcquisto(e.target.value)}
                style={{ ...inputStyle, background: "#111119", colorScheme: "dark" }} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>Note</label>
              <input type="text" value={note} onChange={e => setNote(e.target.value)} placeholder="..."
                style={{ ...inputStyle, background: "#111119" }} />
            </div>
          </div>
          <button onClick={handleAdd} disabled={adding || !ticker || !quantita || !prezzoAcquisto} style={{
            width: "100%", padding: "12px", border: "none", borderRadius: 12, cursor: "pointer",
            fontSize: 14, fontWeight: 700, color: "#fff",
            background: ticker && quantita && prezzoAcquisto ? "linear-gradient(135deg, #6C5CE7, #a855f7)" : "#252538",
            opacity: adding ? 0.6 : 1,
          }}>{adding ? "Salvataggio..." : "Aggiungi al portfolio"}</button>
        </div>
      )}

      {/* Holdings list */}
      {holdings.length === 0 ? (
        <div style={{ color: "#555", textAlign: "center", padding: 40, fontSize: 14 }}>
          Nessuna posizione ancora.<br/>Tocca + per aggiungere un titolo.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {holdings.map(h => {
            const q = quotes[h.ticker];
            const prezzoCorrente = q?.prezzo || 0;
            const valoreCorrente = prezzoCorrente > 0 ? h.quantita * prezzoCorrente : h.costoTotale;
            const pl = prezzoCorrente > 0 ? valoreCorrente - h.costoTotale : 0;
            const plPct = h.costoTotale > 0 && prezzoCorrente > 0 ? (pl / h.costoTotale * 100) : 0;
            const dailyPct = q?.cambioPct || 0;

            return (
              <div key={h.ticker} style={{ background: "#1a1a28", borderRadius: 16, padding: "14px 16px", border: "1px solid #252538" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontSize: 15, fontWeight: 800, color: "#eee", fontFamily: "'Space Mono',monospace" }}>{h.ticker}</span>
                      <span style={{ fontSize: 11, color: "#888", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h.nome}</span>
                    </div>
                    <div style={{ fontSize: 11, color: "#666", marginTop: 2 }}>
                      {h.quantita.toFixed(h.quantita % 1 === 0 ? 0 : 2)} pz × {formattaValuta(h.prezzoMedio)} medio
                    </div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 16, fontWeight: 700, fontFamily: "'Space Mono',monospace", color: "#eee" }}>
                      {prezzoCorrente > 0 ? formattaValuta(valoreCorrente) : "—"}
                    </div>
                    {prezzoCorrente > 0 && (
                      <div style={{ fontSize: 11, fontWeight: 700, fontFamily: "'Space Mono',monospace", color: pl >= 0 ? "#4ECDC4" : "#FF6B6B" }}>
                        {pl >= 0 ? "+" : ""}{formattaValuta(pl)} ({plPct >= 0 ? "+" : ""}{plPct.toFixed(1)}%)
                      </div>
                    )}
                  </div>
                </div>
                {/* Price bar */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  {prezzoCorrente > 0 ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontSize: 12, color: "#aaa", fontFamily: "'Space Mono',monospace" }}>{formattaValuta(prezzoCorrente)}</span>
                      <span style={{
                        fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 6,
                        background: dailyPct >= 0 ? "#4ECDC415" : "#FF6B6B15",
                        color: dailyPct >= 0 ? "#4ECDC4" : "#FF6B6B",
                        fontFamily: "'Space Mono',monospace",
                      }}>{dailyPct >= 0 ? "+" : ""}{dailyPct.toFixed(2)}% oggi</span>
                    </div>
                  ) : (
                    <span style={{ fontSize: 11, color: "#555" }}>Prezzo non disponibile</span>
                  )}
                  <button onClick={() => {
                    // Delete all trades for this ticker
                    for (const t of h.trades) handleDelete(t.id);
                  }} style={{ background: "none", border: "none", color: "#555", cursor: "pointer", fontSize: 14, padding: "2px 6px" }}>×</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Allocation chart */}
      {holdings.length >= 2 && Object.keys(quotes).length > 0 && (
        <div style={{ background: "#1a1a28", borderRadius: 20, padding: 20, marginTop: 16, border: "1px solid #252538" }}>
          <div style={{ fontSize: 12, color: "#999", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 14 }}>Allocazione</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {holdings.map(h => {
              const q = quotes[h.ticker];
              const val = q ? h.quantita * q.prezzo : h.costoTotale;
              const pct = totalValore > 0 ? (val / totalValore * 100) : 0;
              const colors = ["#6C5CE7", "#4ECDC4", "#FF6B6B", "#FFEAA7", "#DDA0DD", "#F0A500", "#74B9FF", "#55EFC4"];
              const color = colors[holdings.indexOf(h) % colors.length];
              return (
                <div key={h.ticker}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                    <span style={{ fontSize: 12, color: "#ccc", fontWeight: 600 }}>{h.ticker}</span>
                    <span style={{ fontSize: 12, color: "#aaa", fontFamily: "'Space Mono',monospace" }}>{pct.toFixed(1)}%</span>
                  </div>
                  <div style={{ height: 8, background: "#252538", borderRadius: 4, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${pct}%`, background: color, borderRadius: 4, transition: "width 0.5s" }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Export View ───
const ALL_COLUMNS = [
  { id: "data", label: "Data" },
  { id: "tipo", label: "Tipo" },
  { id: "importo", label: "Importo (€)" },
  { id: "categoria", label: "Categoria" },
  { id: "descrizione", label: "Descrizione" },
  { id: "pagatoDa", label: "Pagato da" },
  { id: "partecipanti", label: "Partecipanti e quote" },
];

function ExportView({ transazioni, persone }) {
  const oggi = new Date();
  const [meseDa, setMeseDa] = useState(`${oggi.getFullYear()}-${String(oggi.getMonth()+1).padStart(2,"0")}`);
  const [meseA, setMeseA] = useState(meseDa);
  const [colonne, setColonne] = useState(ALL_COLUMNS.map(c => c.id));
  const [ordinamento, setOrdinamento] = useState("data-asc");
  const [esportando, setEsportando] = useState(false);

  function toggleColonna(id) {
    setColonne(prev => prev.includes(id) ? prev.filter(c => c !== id) : [...prev, id]);
  }

  function selezionaTutte() { setColonne(ALL_COLUMNS.map(c => c.id)); }
  function deselezionaTutte() { setColonne(["data", "importo"]); } // minimo

  // Filter transactions by month range
  const filtrate = transazioni.filter(t => {
    const mese = t.data?.slice(0, 7); // "YYYY-MM"
    return mese && mese >= meseDa && mese <= meseA;
  });

  // Sort
  const ordinate = [...filtrate].sort((a, b) => {
    const [campo, dir] = ordinamento.split("-");
    let va, vb;
    if (campo === "data") { va = a.data; vb = b.data; }
    else if (campo === "importo") { va = a.importo; vb = b.importo; }
    else if (campo === "categoria") { va = a.categoria; vb = b.categoria; }
    else if (campo === "pagatoDa") { va = a.pagatoDa || ""; vb = b.pagatoDa || ""; }
    else { va = a.data; vb = b.data; }
    if (va < vb) return dir === "asc" ? -1 : 1;
    if (va > vb) return dir === "asc" ? 1 : -1;
    return 0;
  });

  async function esporta() {
    setEsportando(true);
    try {
      const XLSX = await import("xlsx");

      const rows = ordinate.map(t => {
        const row = {};
        const p = persone.find(p => p.id === t.pagatoDa);
        if (colonne.includes("data")) row["Data"] = t.data;
        if (colonne.includes("tipo")) row["Tipo"] = t.tipo === "uscita" ? "Uscita" : "Entrata";
        if (colonne.includes("importo")) row["Importo (€)"] = t.importo;
        if (colonne.includes("categoria")) row["Categoria"] = t.categoria;
        if (colonne.includes("descrizione")) row["Descrizione"] = t.descrizione || "";
        if (colonne.includes("pagatoDa")) row["Pagato da"] = p?.nome || t.pagatoDa || "";
        if (colonne.includes("partecipanti")) {
          if (t.splits && Array.isArray(t.splits) && t.splits.length > 0) {
            const allP = getAllPersone(transazioni, persone);
            row["Partecipanti"] = t.splits.map(s => {
              const sp = allP.find(x => x.id === s.personaId);
              return `${sp?.nome || s.personaId} ${s.quota}%`;
            }).join(", ");
          } else if (t.splitPagante != null) {
            row["Partecipanti"] = `${p?.nome || ""} ${t.splitPagante}%`;
          } else {
            row["Partecipanti"] = "";
          }
        }
        return row;
      });

      const ws = XLSX.utils.json_to_sheet(rows);

      // Auto-width columns
      const colWidths = Object.keys(rows[0] || {}).map(key => ({
        wch: Math.max(key.length, ...rows.map(r => String(r[key] ?? "").length)) + 2,
      }));
      ws["!cols"] = colWidths;

      const wb = XLSX.utils.book_new();
      const sheetName = meseDa === meseA ? meseDa : `${meseDa}_${meseA}`;
      XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
      XLSX.writeFile(wb, `finanza_${sheetName}.xlsx`);
    } catch (err) {
      console.error("Export error:", err);
      alert("Errore durante l'esportazione: " + err.message);
    } finally {
      setEsportando(false);
    }
  }

  // Generate month options (last 24 months)
  const mesiOptions = [];
  for (let i = 0; i < 24; i++) {
    const d = new Date(oggi.getFullYear(), oggi.getMonth() - i, 1);
    const val = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
    const label = `${MESI[d.getMonth()]} ${d.getFullYear()}`;
    mesiOptions.push({ val, label });
  }

  const sortOptions = [
    { val: "data-asc", label: "Data ↑ (vecchie prima)" },
    { val: "data-desc", label: "Data ↓ (recenti prima)" },
    { val: "importo-desc", label: "Importo ↓ (più alto)" },
    { val: "importo-asc", label: "Importo ↑ (più basso)" },
    { val: "categoria-asc", label: "Categoria A→Z" },
    { val: "pagatoDa-asc", label: "Pagato da A→Z" },
  ];

  return (
    <div style={{ padding: "20px 16px" }}>
      <div style={{ fontSize: 22, fontWeight: 800, color: "#eee", marginBottom: 6 }}>Esporta dati</div>
      <div style={{ fontSize: 13, color: "#888", marginBottom: 20 }}>Scarica le transazioni come file Excel</div>

      {/* Month range */}
      <div style={{ display: "flex", gap: 10, marginBottom: 18 }}>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>Da mese</label>
          <select value={meseDa} onChange={e => { setMeseDa(e.target.value); if (e.target.value > meseA) setMeseA(e.target.value); }}
            style={{ ...inputStyle, colorScheme: "dark", cursor: "pointer" }}>
            {mesiOptions.map(m => <option key={m.val} value={m.val}>{m.label}</option>)}
          </select>
        </div>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>A mese</label>
          <select value={meseA} onChange={e => setMeseA(e.target.value)}
            style={{ ...inputStyle, colorScheme: "dark", cursor: "pointer" }}>
            {mesiOptions.filter(m => m.val >= meseDa).map(m => <option key={m.val} value={m.val}>{m.label}</option>)}
          </select>
        </div>
      </div>

      {/* Column selector */}
      <div style={{ marginBottom: 18 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <label style={{ ...labelStyle, marginBottom: 0 }}>Colonne da esportare</label>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={selezionaTutte} style={{ background: "none", border: "none", color: "#6C5CE7", fontSize: 11, cursor: "pointer", fontWeight: 600 }}>Tutte</button>
            <button onClick={deselezionaTutte} style={{ background: "none", border: "none", color: "#888", fontSize: 11, cursor: "pointer", fontWeight: 600 }}>Minimo</button>
          </div>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {ALL_COLUMNS.map(c => {
            const active = colonne.includes(c.id);
            return (
              <button key={c.id} onClick={() => toggleColonna(c.id)} style={{
                padding: "7px 12px", borderRadius: 10, cursor: "pointer",
                fontSize: 12, fontWeight: 600, fontFamily: "'DM Sans',sans-serif",
                background: active ? "#6C5CE722" : "#1a1a28",
                border: active ? "2px solid #6C5CE7" : "2px solid #252538",
                color: active ? "#6C5CE7" : "#888",
                transition: "all 0.2s",
              }}>{c.label}</button>
            );
          })}
        </div>
      </div>

      {/* Sort order */}
      <div style={{ marginBottom: 18 }}>
        <label style={labelStyle}>Ordinamento</label>
        <select value={ordinamento} onChange={e => setOrdinamento(e.target.value)}
          style={{ ...inputStyle, colorScheme: "dark", cursor: "pointer" }}>
          {sortOptions.map(s => <option key={s.val} value={s.val}>{s.label}</option>)}
        </select>
      </div>

      {/* Preview */}
      <div style={{ background: "#1a1a28", borderRadius: 16, padding: "14px 16px", marginBottom: 20, border: "1px solid #252538" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 13, color: "#ccc", fontWeight: 600 }}>{ordinate.length} transazioni</div>
            <div style={{ fontSize: 11, color: "#888", marginTop: 2 }}>{colonne.length} colonne selezionate</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: "#FF6B6B", fontFamily: "'Space Mono',monospace" }}>
              {formattaValuta(ordinate.filter(t => t.tipo === "uscita").reduce((s, t) => s + t.importo, 0))}
            </div>
            <div style={{ fontSize: 10, color: "#888" }}>uscite totali</div>
          </div>
        </div>
      </div>

      {/* Export button */}
      <button onClick={esporta} disabled={ordinate.length === 0 || esportando} style={{
        width: "100%", padding: "16px", border: "none", borderRadius: 16, cursor: ordinate.length > 0 ? "pointer" : "default",
        fontFamily: "'DM Sans',sans-serif", fontSize: 16, fontWeight: 700,
        background: ordinate.length > 0 ? "linear-gradient(135deg, #6C5CE7, #a855f7)" : "#252538",
        color: ordinate.length > 0 ? "#fff" : "#666",
        boxShadow: ordinate.length > 0 ? "0 4px 20px #6C5CE744" : "none",
        opacity: esportando ? 0.6 : 1,
        transition: "all 0.3s",
      }}>
        {esportando ? "Generazione file..." : ordinate.length === 0 ? "Nessuna transazione nel periodo" : `Scarica XLSX (${ordinate.length} righe)`}
      </button>
    </div>
  );
}

// ─── Login Screen ───
function LoginScreen({ onLogin }) {
  const [pin, setPin] = useState("");
  const [errore, setErrore] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleLogin() {
    if (pin.length < 4) return;
    setLoading(true);
    setErrore("");
    try {
      await login(pin);
      onLogin();
    } catch (err) {
      setErrore(err.message || "PIN non valido");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ maxWidth: 430, margin: "0 auto", minHeight: "100vh", background: "#111119", color: "#eee", fontFamily: "'DM Sans',sans-serif", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div style={{ fontSize: 36, fontWeight: 800, marginBottom: 4 }}>
        <span style={{ background: "linear-gradient(135deg, #6C5CE7, #a855f7)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>Finanza</span>
      </div>
      <div style={{ fontSize: 11, color: "#555", letterSpacing: 2, marginBottom: 40 }}>TRACKER</div>

      <div style={{ width: "100%", maxWidth: 300 }}>
        <label style={{ ...labelStyle, textAlign: "center", display: "block" }}>Inserisci il PIN</label>
        <input
          type="password"
          inputMode="numeric"
          maxLength={8}
          value={pin}
          onChange={e => { setPin(e.target.value.replace(/\D/g, "")); setErrore(""); }}
          onKeyDown={e => e.key === "Enter" && handleLogin()}
          placeholder="••••"
          style={{
            ...inputStyle,
            fontSize: 32, fontWeight: 800, fontFamily: "'Space Mono',monospace",
            textAlign: "center", letterSpacing: 12,
          }}
          autoFocus
        />

        {errore && (
          <div style={{ marginTop: 12, textAlign: "center", color: "#FF6B6B", fontSize: 13, fontWeight: 600 }}>{errore}</div>
        )}

        <button onClick={handleLogin} disabled={loading || pin.length < 4} style={{
          width: "100%", padding: "16px", border: "none", borderRadius: 16, cursor: pin.length >= 4 ? "pointer" : "default",
          fontFamily: "'DM Sans',sans-serif", fontSize: 16, fontWeight: 700, marginTop: 20,
          background: pin.length >= 4 ? "linear-gradient(135deg, #6C5CE7, #a855f7)" : "#252538",
          color: pin.length >= 4 ? "#fff" : "#666",
          opacity: loading ? 0.6 : 1,
          transition: "all 0.3s",
        }}>
          {loading ? "Accesso..." : "Accedi"}
        </button>
      </div>
    </div>
  );
}

// ─── Main App ───
export default function FinanzaApp() {
  const [authed, setAuthed] = useState(isLoggedIn());
  const [tab, setTab] = useState("home");
  const [transazioni, setTransazioni] = useState([]);
  const [loading, setLoading] = useState(true);
  const [meseOffset, setMeseOffset] = useState(0);

  const persone = getPersone().length > 0 ? getPersone() : DEFAULT_PERSONE;
  const householdName = getHouseholdName();

  const loadAll = useCallback(async () => {
    try {
      const data = await fetchTransactions();
      setTransazioni(data);
    } catch (err) {
      if (err.message === "Sessione scaduta") { setAuthed(false); return; }
      console.error("Load error:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (authed) loadAll(); else setLoading(false); }, [authed, loadAll]);

  function handleLogin() { setAuthed(true); setLoading(true); loadAll(); }
  function handleLogout() { logout(); setAuthed(false); setTransazioni([]); setTab("home"); }

  async function aggiungiTransazione(t) {
    try {
      const saved = await addTransaction(t);
      setTransazioni(prev => [...prev, saved]);
      setTab("home");
    } catch (err) { console.error("Add error:", err); }
  }

  async function eliminaTransazione(id) {
    try {
      await deleteTransaction(id);
      setTransazioni(prev => prev.filter(t => t.id !== id));
    } catch (err) { console.error("Delete error:", err); }
  }

  async function modificaTransazione(id, updates) {
    try {
      const updated = await updateTransaction(id, updates);
      setTransazioni(prev => prev.map(t => t.id === id ? { ...t, ...updated } : t));
    } catch (err) { console.error("Update error:", err); }
  }

  if (!authed) return <LoginScreen onLogin={handleLogin} />;
  if (loading) return <div style={{ minHeight: "100vh", background: "#111119", display: "flex", alignItems: "center", justifyContent: "center" }}><div style={{ color: "#6C5CE7", fontSize: 18 }}>Caricamento...</div></div>;

  const showMonthBar = tab === "home" || tab === "stats";

  return (
    <div style={{ maxWidth: 430, margin: "0 auto", height: "100dvh", background: "#111119", color: "#eee", fontFamily: "'DM Sans', sans-serif", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {/* Fixed header */}
      <div style={{ padding: "calc(18px + env(safe-area-inset-top, 0px)) 16px 8px", display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: showMonthBar ? "none" : "1px solid #1e1e2e", background: "#111119", flexShrink: 0 }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: -0.5 }}><span style={{ background: "linear-gradient(135deg, #6C5CE7, #a855f7)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>Finanza</span></div>
          <div style={{ fontSize: 10, color: "#555", letterSpacing: 1 }}>{householdName || "TRACKER"}</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <button onClick={() => window.location.reload()} title="Ricarica" style={{
            background: "none", border: "1px solid #252538", borderRadius: 8, cursor: "pointer",
            color: "#888", fontSize: 14, padding: "4px 8px", display: "flex", alignItems: "center",
          }}>↻</button>
          <button onClick={handleLogout} title="Logout" style={{
            background: "none", border: "1px solid #252538", borderRadius: 8, cursor: "pointer",
            color: "#888", fontSize: 12, padding: "4px 8px", display: "flex", alignItems: "center",
            fontFamily: "'DM Sans',sans-serif",
          }}>Esci</button>
          <div style={{ width: 7, height: 7, borderRadius: "50%", background: isAPIConnected() ? "#4ECDC4" : "#F0A500" }} title={isAPIConnected() ? "MongoDB" : "offline"} />
        </div>
      </div>
      {/* Fixed month selector bar — only for Home and Stats */}
      {showMonthBar && (
        <MonthBar meseOffset={meseOffset} setMeseOffset={setMeseOffset} />
      )}
      {/* Scrollable content */}
      <div style={{ flex: 1, overflowY: "auto", paddingBottom: 10 }}>
        {tab === "home" && <HomeView transazioni={transazioni} onDelete={eliminaTransazione} onEdit={modificaTransazione} onSettle={aggiungiTransazione} persone={persone} meseOffset={meseOffset} />}
        {tab === "aggiungi" && <AggiungiView onAggiungi={aggiungiTransazione} persone={persone} />}
        {tab === "stats" && <StatsView transazioni={transazioni} persone={persone} meseOffset={meseOffset} />}
        {tab === "export" && <ExportView transazioni={transazioni} persone={persone} />}
        {tab === "portfolio" && <PortfolioView />}
      </div>
      <TabBar tab={tab} setTab={setTab} householdId={getSession()?.householdId} />
    </div>
  );
}
