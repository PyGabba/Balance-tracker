import { useState, useEffect, useCallback, useRef } from "react";
import { App as CapApp } from "@capacitor/app";
import { fetchTransactions, addTransaction, deleteTransaction, updateTransaction, isAPIConnected, login, logout, register, changePin, isLoggedIn, getSession, getPersone, getHouseholdName, fetchPositions, addPosition, deletePosition, fetchManualPrices, saveManualPricesRemote, wakeupServer, deleteHousehold, getCategorieUscita, fetchCategorie, saveCategorie, setAuthErrorHandler, fetchGoals, addGoal, updateGoal, deleteGoal } from "./api.js";

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
function evalImporto(val) {
  if (!val) return 0;
  const s = String(val).replace(",", ".");
  if (/^[0-9.]+$/.test(s)) return parseFloat(s) || 0;
  try {
    const sanitized = s.replace(/[^0-9.+*/\-()]/g, "");
    if (sanitized && /^[0-9.+*/\-()]+$/.test(sanitized)) {
      const result = Function(`"use strict"; return (${sanitized})`)();
      if (typeof result === "number" && isFinite(result)) return Math.round(result * 100) / 100;
    }
  } catch {}
  return 0;
}

// Storage is now handled by src/api.js (MongoDB + localStorage fallback)

// ─── Multi-person debt calculator ───
// Returns array: [{ da: personaId, a: personaId, importo: number }]
function calcolaDebitiMatrix(transazioni, persone) {
  const balances = {};
  for (const t of transazioni) {
    if (t.tipo === "saldo") {
      if (!t.pagatoDa || !t.ricevutoDa) continue;
      // Payment reduces debt: add in reverse direction so netting cancels it out
      const key = `${t.ricevutoDa}->${t.pagatoDa}`;
      balances[key] = (balances[key] || 0) + t.importo;
      continue;
    }
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
  // Convert directional pair balances → per-person net balance
  const netPerPerson = {};
  for (const [key, amount] of Object.entries(balances)) {
    const [da, a] = key.split("->");
    netPerPerson[da] = (netPerPerson[da] || 0) - amount; // owes → negative
    netPerPerson[a]  = (netPerPerson[a]  || 0) + amount; // owed → positive
  }

  // Greedy creditor/debtor matching — minimises number of transactions
  const creditors = [], debtors = [];
  for (const [id, bal] of Object.entries(netPerPerson)) {
    if (bal >  0.01) creditors.push({ id, bal });
    if (bal < -0.01) debtors.push({ id, bal: -bal });
  }
  creditors.sort((a, b) => b.bal - a.bal);
  debtors.sort((a, b) => b.bal - a.bal);

  const debiti = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const pay = Math.min(debtors[i].bal, creditors[j].bal);
    debiti.push({ da: debtors[i].id, a: creditors[j].id, importo: Math.round(pay * 100) / 100 });
    debtors[i].bal   -= pay;
    creditors[j].bal -= pay;
    if (debtors[i].bal   < 0.01) i++;
    if (creditors[j].bal < 0.01) j++;
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

// ─── Floating Glass Tab Bar ───
function TabBar({ tab, setTab, householdId }) {
  const baseTabs = [
    { id: "home", label: "Home", icon: "⌂" },
    { id: "aggiungi", label: "Aggiungi", icon: "+" },
    { id: "portfolio", label: "Portfolio", icon: "📈" },
    { id: "stats", label: "Statistiche", icon: "◔" },
    { id: "export", label: "Esporta", icon: "↓" },
  ];
  const tabs = [...baseTabs, { id: "impostazioni", label: "Account", icon: "⚙" }];

  const icons = {
    home: (active) => (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={active ? "#a78bfa" : "#94a3b8"} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 9.5L12 3l9 6.5V20a1 1 0 01-1 1H4a1 1 0 01-1-1V9.5z"/>
        <path d="M9 21V12h6v9"/>
      </svg>
    ),
    aggiungi: () => (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round">
        <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
      </svg>
    ),
    stats: (active) => (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={active ? "#a78bfa" : "#94a3b8"} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="12" width="4" height="9" rx="1"/>
        <rect x="10" y="7" width="4" height="14" rx="1"/>
        <rect x="17" y="3" width="4" height="18" rx="1"/>
      </svg>
    ),
    export: (active) => (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={active ? "#a78bfa" : "#94a3b8"} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>
        <line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="18" x2="20" y2="18"/>
      </svg>
    ),
    portfolio: (active) => (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={active ? "#a78bfa" : "#94a3b8"} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
      </svg>
    ),
    impostazioni: (active) => (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={active ? "#a78bfa" : "#94a3b8"} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3"/>
        <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
      </svg>
    ),
  };

  return (
    <div style={{
      position: "absolute",
      bottom: 0,
      left: 0,
      right: 0,
      width: "100%",
      background: "#111119",
      display: "flex",
      flexDirection: "column",
      zIndex: 100,
      flexShrink: 0,
      pointerEvents: "none",
    }}>
      <div style={{
        display: "flex",
        justifyContent: "space-around",
        alignItems: "center",
        background: "rgba(17, 17, 25, 0.92)",
        backdropFilter: "blur(25px) saturate(180%)",
        WebkitBackdropFilter: "blur(25px) saturate(180%)",
        borderRadius: "16px 16px 0 0",
        padding: "4px 12px 2px",
        border: "1px solid rgba(255, 255, 255, 0.08)",
        borderBottom: "none",
        pointerEvents: "all",
        gap: "2px",
      }}>
      {tabs.map(t => {
        const isActive = tab === t.id;
        const isAdd = t.id === "aggiungi";
        return (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            onTouchStart={(e) => e.currentTarget.style.opacity = "0.7"}
            onTouchEnd={(e) => e.currentTarget.style.opacity = "1"}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: "1px",
              padding: "3px 6px",
              flex: 1,
              transition: "all 0.25s cubic-bezier(0.4, 0, 0.2, 1)",
              opacity: 1,
            }}
          >
            <div style={{
              width: isAdd ? 32 : 22,
              height: isAdd ? 32 : 22,
              borderRadius: isAdd ? "50%" : "8px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: isAdd
                ? "linear-gradient(135deg, #6C5CE7, #a855f7)"
                : isActive ? "rgba(167, 139, 250, 0.18)" : "transparent",
              transition: "all 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
              boxShadow: isAdd ? "0 4px 12px rgba(108, 92, 231, 0.3)" : "none",
            }}>
              {icons[t.id]?.(isActive)}
            </div>
            <span style={{
              fontSize: "7px",
              fontFamily: "'DM Sans', 'Segoe UI', sans-serif",
              fontWeight: isActive ? 600 : 500,
              color: isActive ? "#a78bfa" : "#94a3b8",
              letterSpacing: "0.3px",
              whiteSpace: "nowrap",
              textOverflow: "ellipsis",
              overflow: "hidden",
              maxWidth: "100%",
              transition: "color 0.3s ease",
            }}>
              {t.label}
            </span>
          </button>
        );
      })}
      </div>
    </div>
  );
}

// ─── Home ───

// Goal gauge component
function GoalGauge({ current, target, size = 60 }) {
  const pct = target > 0 ? Math.min(current / target, 1) : 0;
  const stroke = 8;
  const radius = (size - stroke) / 2;
  const circ = 2 * Math.PI * radius;
  const offset = circ * (1 - pct);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={size/2} cy={size/2} r={radius} fill="none" stroke="#252538" strokeWidth={stroke} />
      <circle cx={size/2} cy={size/2} r={radius} fill="none" stroke={pct >= 1 ? "#4ECDC4" : "#6C5CE7"} strokeWidth={stroke}
        strokeDasharray={circ} strokeDashoffset={offset} strokeLinecap="round" transform={`rotate(-90 ${size/2} ${size/2})`} style={{transition: "stroke-dashoffset 0.5s"}} />
    </svg>
  );
}

// Goal row component
function GoalRow({ goal, onUpdate, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState(String(goal.currentAmount || 0));
  const pct = goal.targetAmount > 0 ? (goal.currentAmount / goal.targetAmount * 100) : 0;
  const daysLeft = goal.targetDate ? Math.ceil((new Date(goal.targetDate) - new Date()) / (1000*60*60*24)) : null;
  
  function handleSave() {
    const val = parseFloat(amount.replace(",", "."));
    if (!isNaN(val) && val >= 0) {
      onUpdate(goal.id, { currentAmount: val });
    }
    setEditing(false);
  }
  
  return (
    <div style={{ background: "#111119", borderRadius: 12, padding: 12, border: editing ? "1px solid #6C5CE7" : "1px solid #252538" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <GoalGauge current={goal.currentAmount || 0} target={goal.targetAmount} size={50} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#eee" }}>{goal.nome}</div>
          <div style={{ fontSize: 11, color: "#888" }}>
            {formattaValuta(goal.currentAmount || 0)} / {formattaValuta(goal.targetAmount)} ({pct.toFixed(0)}%)
            {daysLeft !== null && <span style={{ color: daysLeft < 0 ? "#FF6B6B" : "#666", marginLeft: 8 }}>{daysLeft < 0 ? `in ritardo ${Math.abs(daysLeft)}g` : `${daysLeft}g rimasti`}</span>}
          </div>
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          <button onClick={() => setEditing(!editing)} style={{ background: "none", border: "none", color: "#6C5CE7", cursor: "pointer", fontSize: 14 }}>✏</button>
          <button onClick={() => { if (confirm("Eliminare questo obiettivo?")) onDelete(goal.id); }} style={{ background: "none", border: "none", color: "#FF6B6B", cursor: "pointer", fontSize: 14 }}>×</button>
        </div>
      </div>
      {editing && (
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <input type="number" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)}
            placeholder="0.00" style={{ flex: 1, padding: "8px 10px", background: "#1a1a28", border: "1px solid #6C5CE7", borderRadius: 8, color: "#eee", fontSize: 14, fontFamily: "'Space Mono',monospace", outline: "none" }} />
          <button onClick={handleSave} style={{ padding: "8px 14px", background: "#6C5CE7", border: "none", borderRadius: 8, color: "#fff", fontSize: 12, fontWeight: 700 }}>Salva</button>
        </div>
      )}
    </div>
  );
}

// Goals form component
function GoalsForm({ onAdd, onCancel }) {
  const [nome, setNome] = useState("");
  const [targetAmount, setTargetAmount] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [currentAmount, setCurrentAmount] = useState("");
  const [contributionType, setContributionType] = useState("manual");
  const [contributionValue, setContributionValue] = useState("");
  const [autoAdd, setAutoAdd] = useState(false);
  
  function handleSubmit() {
    if (!nome.trim() || !targetAmount) return;
    onAdd({
      nome: nome.trim(),
      targetAmount: parseFloat(targetAmount),
      targetDate: targetDate || null,
      currentAmount: parseFloat(currentAmount) || 0,
      contributionType,
      contributionValue: contributionType !== "manual" ? parseFloat(contributionValue) || 0 : 0,
      autoAdd,
    });
    setNome(""); setTargetAmount(""); setTargetDate(""); setCurrentAmount("");
    setContributionType("manual"); setContributionValue(""); setAutoAdd(false);
    onCancel?.();
  }
  
  return (
    <div style={{ background: "#111119", borderRadius: 12, padding: 12, marginBottom: 10, border: "1px solid #252538" }}>
      <input type="text" value={nome} onChange={e => setNome(e.target.value)} placeholder="Nome obiettivo (es. Vacanza)"
        style={{ ...inputStyle, marginBottom: 8, background: "#1a1a28" }} />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
        <input type="number" inputMode="decimal" value={targetAmount} onChange={e => setTargetAmount(e.target.value)} placeholder="Target €"
          style={{ flex: "1 1 100px", padding: "8px 10px", background: "#1a1a28", border: "1px solid #252538", borderRadius: 8, color: "#eee", fontSize: 13, fontFamily: "'Space Mono',monospace", outline: "none" }} />
        <input type="number" inputMode="decimal" value={currentAmount} onChange={e => setCurrentAmount(e.target.value)} placeholder="Già risparmiato"
          style={{ flex: "1 1 100px", padding: "8px 10px", background: "#1a1a28", border: "1px solid #252538", borderRadius: 8, color: "#eee", fontSize: 13, fontFamily: "'Space Mono',monospace", outline: "none" }} />
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
        <input type="date" value={targetDate} onChange={e => setTargetDate(e.target.value)} placeholder="Data obiettivo"
          style={{ flex: "1 1 100px", padding: "8px 10px", background: "#1a1a28", border: "1px solid #252538", borderRadius: 8, color: "#666", fontSize: 12, outline: "none", colorScheme: "dark" }} />
      </div>
      {/* Contribution type */}
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 11, color: "#888", marginBottom: 6 }}>Risparmio automatico (ogni Entrata)</div>
        <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
          {["manual", "percent", "fixed"].map(tp => (
            <button key={tp} onClick={() => setContributionType(tp)} style={{
              flex: 1, padding: "6px 0", border: "none", borderRadius: 8, cursor: "pointer",
              fontSize: 11, fontWeight: 600,
              background: contributionType === tp ? "#6C5CE722" : "transparent",
              color: contributionType === tp ? "#a78bfa" : "#666",
              border: contributionType === tp ? "1px solid #6C5CE7" : "1px solid #252538",
            }}>
              {tp === "manual" ? "Manuale" : tp === "percent" ? "% Entrata" : "€ Fisso"}
            </button>
          ))}
        </div>
        {contributionType !== "manual" && (
          <input type="number" inputMode="decimal" value={contributionValue} onChange={e => setContributionValue(e.target.value)}
            placeholder={contributionType === "percent" ? "% da salvare" : "€ da salvare"}
            style={{ width: "100%", padding: "8px 10px", background: "#1a1a28", border: "1px solid #6C5CE7", borderRadius: 8, color: "#eee", fontSize: 13, fontFamily: "'Space Mono',monospace", outline: "none" }} />
        )}
      </div>
      {/* Auto-add toggle */}
      <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, cursor: "pointer" }}>
        <input type="checkbox" checked={autoAdd} onChange={e => setAutoAdd(e.target.checked)} style={{ width: 16, height: 16 }} />
        <span style={{ fontSize: 12, color: "#aaa" }}>Applica automaticamente alle entrate</span>
      </label>
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={onCancel} style={{ padding: "8px 12px", background: "none", border: "1px solid #333", borderRadius: 8, color: "#888", fontSize: 12 }}>✕</button>
        <button onClick={handleSubmit} disabled={!nome.trim() || !targetAmount} style={{ flex: 1, padding: "8px", background: nome.trim() && targetAmount ? "#6C5CE7" : "#252538", border: "none", borderRadius: 8, color: nome.trim() && targetAmount ? "#fff" : "#555", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Aggiungi</button>
      </div>
    </div>
  );
}

function HomeView({ transazioni, onDelete, onEdit, onSettle, persone, meseOffset, categorie, goals, onAddGoal, onUpdateGoal, onDeleteGoal }) {
  const oggi = new Date();
  const [editId, setEditId] = useState(null);
  const [settlingKey, setSettlingKey] = useState(null);
  const [settleAmount, setSettleAmount] = useState("");
  const [search, setSearch] = useState("");
  const [showAddGoal, setShowAddGoal] = useState(false);

  const meseVis = new Date(oggi.getFullYear(), oggi.getMonth() - meseOffset, 1);
  const nomeMese = MESI[meseVis.getMonth()] + " " + meseVis.getFullYear();

  const txMese = transazioni.filter(t => {
    const d = new Date(t.data);
    return d.getMonth() === meseVis.getMonth() && d.getFullYear() === meseVis.getFullYear();
  });
  const entrateNormali = txMese.filter(t => t.tipo === "entrata").reduce((s, t) => s + t.importo, 0);
  // External payer settling a debt = real money received by household
  const entrateExternaSaldi = txMese.filter(t => t.tipo === "saldo" && !persone.some(p => p.id === t.pagatoDa)).reduce((s, t) => s + t.importo, 0);
  const entrate = entrateNormali + entrateExternaSaldi;
  const uscite = txMese.filter(t => t.tipo === "uscita").reduce((s, t) => s + t.importo, 0);
  const saldo = entrate - uscite;
  const txOrdinate = [...txMese]
    .filter(t => t.tipo !== "saldo")
    .filter(t => {
      if (!search.trim()) return true;
      const q = search.trim().toLowerCase();
      const cat = categorie.find(c => c.id === t.categoria);
      return (t.descrizione || "").toLowerCase().includes(q)
        || (cat?.nome || "").toLowerCase().includes(q);
    })
    .sort((a, b) => new Date(b.data) - new Date(a.data));

  const debitiGlobale = calcolaDebitiMatrix(transazioni, persone);
  const debitiMese = calcolaDebitiMatrix(txMese, persone);
  const allPeople = getAllPersone(transazioni, persone);
  const p1 = persone[0] || DEFAULT_PERSONE[0];
  const p2 = persone[1] || DEFAULT_PERSONE[1];

  const oggiStr = new Date().toISOString().slice(0, 10);
  const ricorrentiInScadenza = transazioni.filter(t =>
    t.ricorrenza?.frequenza && t.ricorrenza?.prossimaData &&
    t.ricorrenza.prossimaData <= oggiStr
  );

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

      {/* Recurring transactions banner */}
      {ricorrentiInScadenza.length > 0 && (
        <div style={{ background: "#1a1a28", borderRadius: 14, padding: "12px 14px", marginBottom: 12, border: "1px solid #6C5CE744", display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 18 }}>🔁</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#a78bfa" }}>
              {ricorrentiInScadenza.length === 1
                ? `"${ricorrentiInScadenza[0].descrizione || ricorrentiInScadenza[0].categoria}" è stata rinnovata`
                : `${ricorrentiInScadenza.length} transazioni ricorrenti rinnovate`}
            </div>
            <div style={{ fontSize: 11, color: "#555", marginTop: 2 }}>Aggiunte automaticamente oggi</div>
          </div>
        </div>
      )}

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
          <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            {debitiGlobale.map((d, i) => {
              const pDa = allPeople.find(p => p.id === d.da) || { nome: d.da, emoji: "👤" };
              const pA = allPeople.find(p => p.id === d.a) || { nome: d.a, emoji: "👤" };
              const key = `${d.da}->${d.a}`;
              if (settlingKey === key) {
                return (
                  <div key={i} style={{ background: "#111119", borderRadius: 12, padding: 12, border: "1px solid #4ECDC433" }}>
                    <div style={{ fontSize: 12, color: "#aaa", marginBottom: 8 }}>
                      {pDa.emoji} {pDa.nome} → {pA.emoji} {pA.nome} <span style={{ color: "#555" }}>(max {formattaValuta(d.importo)})</span>
                    </div>
                    <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
                      <input
                        type="number" inputMode="decimal"
                        value={settleAmount}
                        onChange={e => setSettleAmount(e.target.value)}
                        style={{ flex: 1, padding: "9px 12px", background: "#1a1a28", border: "1px solid #4ECDC455", borderRadius: 10, color: "#eee", fontSize: 15, fontFamily: "'Space Mono',monospace", outline: "none", boxSizing: "border-box" }}
                      />
                      <button onClick={() => setSettleAmount(String(d.importo))} style={{ padding: "9px 10px", border: "1px solid #4ECDC433", borderRadius: 10, background: "#4ECDC411", color: "#4ECDC4", fontSize: 11, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>Max</button>
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button onClick={() => { setSettlingKey(null); setSettleAmount(""); }} style={{ flex: 1, padding: "9px", border: "1px solid #252538", borderRadius: 10, background: "transparent", color: "#888", fontSize: 12, cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>Annulla</button>
                      <button onClick={() => {
                        const raw = parseFloat(String(settleAmount).replace(",", "."));
                        const amt = isNaN(raw) || raw <= 0 ? d.importo : Math.min(raw, d.importo);
                        onSettle({
                          id: generaId(), tipo: "saldo",
                          importo: Math.round(amt * 100) / 100,
                          descrizione: `Saldo debito → ${pA.nome}`,
                          data: new Date().toISOString().slice(0, 10),
                          pagatoDa: d.da, ricevutoDa: d.a,
                        });
                        setSettlingKey(null); setSettleAmount("");
                      }} style={{ flex: 2, padding: "9px", border: "none", borderRadius: 10, background: "#4ECDC4", color: "#111119", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>
                        Conferma saldo
                      </button>
                    </div>
                  </div>
                );
              }
              return (
                <button key={i} onClick={() => { setSettlingKey(key); setSettleAmount(String(d.importo)); }} style={{
                  width: "100%", padding: "10px", borderRadius: 10, cursor: "pointer",
                  background: "#1e2a2a", color: "#4ECDC4", border: "1px solid #4ECDC433",
                  fontSize: 12, fontWeight: 600, fontFamily: "'DM Sans',sans-serif",
                }}>
                  Salda {pDa.nome} → {pA.nome} ({formattaValuta(d.importo)})
                </button>
              );
            })}
          </div>
        )}
        {/* Settlement history */}
        {(() => {
          const saldati = transazioni
            .filter(t => t.tipo === "saldo")
            .sort((a, b) => new Date(b.data) - new Date(a.data));
          if (saldati.length === 0) return null;
          return (
            <div style={{ borderTop: "1px solid #252538", paddingTop: 10, marginTop: 10 }}>
              <div style={{ fontSize: 10, color: "#777", marginBottom: 6, letterSpacing: 0.5, textTransform: "uppercase" }}>Storico saldi</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                {saldati.map((t, i) => {
                  const pDa = allPeople.find(p => p.id === t.pagatoDa) || { nome: t.pagatoDa, emoji: "👤" };
                  const pA = allPeople.find(p => p.id === t.ricevutoDa) || { nome: t.ricevutoDa, emoji: "👤" };
                  return (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontSize: 12, color: "#4ECDC4" }}>✓</span>
                      <span style={{ fontSize: 11, color: "#666", flex: 1 }}>{pDa.nome} → {pA.nome}</span>
                      <span style={{ fontSize: 11, color: "#4ECDC4", fontFamily: "'Space Mono',monospace", fontWeight: 600 }}>{formattaValuta(t.importo)}</span>
                      <span style={{ fontSize: 10, color: "#555", marginLeft: 4 }}>{formattaData(t.data)}</span>
                      <button onClick={() => onDelete(t.id)} style={{ background: "none", border: "none", color: "#FF6B6B55", cursor: "pointer", fontSize: 12, padding: "0 2px", lineHeight: 1 }} title="Elimina saldo">✕</button>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })()}
      </div>

      {/* Savings Goals card */}
      <div style={{ background: "#1a1a28", borderRadius: 16, padding: 16, marginBottom: 20, border: "1px solid #252538" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <div style={{ fontSize: 11, color: "#999", letterSpacing: 0.5, textTransform: "uppercase" }}>Obiettivi risparmio</div>
          <button onClick={() => setShowAddGoal(!showAddGoal)} style={{
            background: "none", border: "none", color: "#6C5CE7", cursor: "pointer", fontSize: 14,
          }}>{showAddGoal ? "✕" : "+"}</button>
        </div>

        {/* Add goal form */}
        {showAddGoal && (
          <GoalsForm onAdd={onAddGoal} onCancel={() => setShowAddGoal(false)} />
        )}

        {/* Goals list */}
        {(!goals || goals.length === 0) && !showAddGoal ? (
          <div style={{ fontSize: 12, color: "#666", textAlign: "center", padding: 8 }}>
            Nessun obiettivo. Tocca + per aggiungerne uno.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {goals?.map(g => (
              <GoalRow key={g.id} goal={g} onUpdate={onUpdateGoal} onDelete={onDeleteGoal} />
            ))}
          </div>
        )}
      </div>

      {/* Transactions for selected month */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div style={{ fontSize: 13, color: "#999", letterSpacing: 0.5, textTransform: "uppercase" }}>Transazioni di {MESI[meseVis.getMonth()]}</div>
        <div style={{ fontSize: 12, color: "#666", fontFamily: "'Space Mono',monospace" }}>{txOrdinate.length}</div>
      </div>
      <div style={{ position: "relative", marginBottom: 12 }}>
        <span style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", fontSize: 14, color: "#555", pointerEvents: "none" }}>🔍</span>
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Cerca transazioni..."
          style={{ ...inputStyle, paddingLeft: 36, paddingTop: 10, paddingBottom: 10, fontSize: 13 }}
        />
        {search && (
          <button onClick={() => setSearch("")} style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "#555", cursor: "pointer", fontSize: 16, lineHeight: 1, padding: 2 }}>✕</button>
        )}
      </div>
      {txOrdinate.length === 0 ? (
        <div style={{ color: "#555", textAlign: "center", padding: 40, fontSize: 14 }}>
          {search.trim() ? `Nessun risultato per "${search}"` : <>Nessuna transazione in {nomeMese}.<br/>Premi + per iniziare!</>}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {txOrdinate.map(t => (
            <TransactionRow key={t.id} t={t} persone={persone} categorie={categorie} isEditing={editId === t.id}
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
function TransactionRow({ t, persone, categorie, isEditing, onTap, onDelete, onSave, onCancel }) {
  const _ENTRATA_CAT = { id: "entrata", nome: "Entrata", emoji: "💰", colore: "#4ECDC4" };
  const cat = t.tipo === "entrata" ? _ENTRATA_CAT : (categorie.find(c => c.id === t.categoria) || categorie.find(c => c.id === "altro") || categorie[categorie.length - 1]);
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
          <div style={{ fontSize: 14, fontWeight: 600, color: "#eee", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {t.descrizione || cat.nome}
            {t.ricorrenza && <span style={{ fontSize: 10, marginLeft: 5, color: "#6C5CE7" }}>🔁</span>}
          </div>
          <div style={{ fontSize: 11, color: "#666", display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
            {formattaData(t.data)}
            {persona && t.tipo === "uscita" && (() => {
              // Ottieni lista partecipanti con quote
              let participants = [];
              if (t.splits && Array.isArray(t.splits) && t.splits.length > 0) {
                participants = t.splits.map(s => ({
                  id: s.personaId,
                  quota: s.quota,
                  persona: persone.find(p => p.id === s.personaId) || { id: s.personaId, nome: s.personaId, emoji: "👤", colore: "#888" }
                }));
              } else if (t.splitPagante != null && t.splitPagante !== 100) {
                // Vecchio formato a 2 persone
                const otherId = persone.find(p => p.id !== t.pagatoDa)?.id;
                if (otherId) {
                  participants = [
                    { id: t.pagatoDa, quota: t.splitPagante, persona },
                    { id: otherId, quota: 100 - t.splitPagante, persona: persone.find(p => p.id === otherId) }
                  ];
                }
              }
            
              const totalParticipants = participants.length;
              const payerIndex = participants.findIndex(p => p.id === t.pagatoDa);
              const isEqualSplit = totalParticipants === 2 && participants[0]?.quota === 50 && participants[1]?.quota === 50;
            
              // Costruisci label concisa
              let splitLabel = "";
              if (totalParticipants === 2 && isEqualSplit) {
                // 50/50: mostra solo l'altra persona
                const other = participants.find(p => p.id !== t.pagatoDa);
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
            {categorie.map(c => (
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
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {persone.map(p => (
              <button key={p.id} onClick={() => setIntestataA(p.id)} style={{
                flex: "1 1 auto", minWidth: 0, padding: "10px 6px", border: intestataA === p.id ? `2px solid ${p.colore}` : "2px solid #252538",
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
const RICORRENZA_OPTIONS = [
  { id: "no", label: "Nessuna" },
  { id: "settimanale", label: "Ogni settimana" },
  { id: "mensile", label: "Ogni mese" },
  { id: "annuale", label: "Ogni anno" },
];

function calcolaProssimaData(data, frequenza) {
  const d = new Date(data);
  if (frequenza === "settimanale") d.setDate(d.getDate() + 7);
  else if (frequenza === "mensile") d.setMonth(d.getMonth() + 1);
  else if (frequenza === "annuale") d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

function AggiungiView({ onAggiungi, persone, transazioni = [], categorie, initialTipo = "uscita", initialImporto = "", initialDescrizione = "", initialCategoria = "", initialPagatoDa = "" }) {
  const [tipo, setTipo] = useState(initialTipo);
  const [importoRaw, setImportoRaw] = useState(initialImporto);
  const importoInputRef = useRef(null);
  const [importo, setImporto] = useState(() => evalImporto(initialImporto));
  const computedImporto = evalImporto(importoRaw);
  const isComputed = computedImporto !== importo && computedImporto > 0;
  const [categoria, setCategoria] = useState(() => {
    if (initialCategoria) {
      const match = categorie.find(c => c.id === initialCategoria || c.nome.toLowerCase() === initialCategoria.toLowerCase());
      if (match) return match.id;
    }
    return categorie[0]?.id || "cibo";
  });
  const [descrizione, setDescrizione] = useState(initialDescrizione);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [data, setData] = useState(new Date().toISOString().slice(0, 10));
  const [salvato, setSalvato] = useState(false);
  const [pagatoDa, setPagatoDa] = useState(() => {
    if (initialPagatoDa) {
      const match = persone.find(p => p.id === initialPagatoDa || p.nome.toLowerCase() === initialPagatoDa.toLowerCase());
      if (match) return match.id;
    }
    return persone[0]?.id || "";
  });
  const base = Math.floor(100 / persone.length);
  const [splits, setSplits] = useState(persone.map((p, i) => ({ personaId: p.id, quota: i === persone.length - 1 ? 100 - base * (persone.length - 1) : base})));
  const [extraPersone, setExtraPersone] = useState([]);
  const [intestataA, setIntestataA] = useState(persone[0]?.id || "");
  const [ricorrenza, setRicorrenza] = useState("no");

  function handleSubmit() {
    const val = importo; // already computed from evalImporto
    if (!val || val <= 0) return;
    const ricorrenzaData = ricorrenza !== "no" ? {
      frequenza: ricorrenza,
      prossimaData: calcolaProssimaData(data, ricorrenza),
    } : null;
    onAggiungi({
      id: generaId(), tipo, importo: val,
      categoria: tipo === "entrata" ? "entrata" : categoria,
      descrizione: descrizione.trim(), data,
      pagatoDa: tipo === "uscita" ? pagatoDa : null,
      splits: tipo === "uscita" ? splits : null,
      extraPersone: tipo === "uscita" && extraPersone.length > 0 ? extraPersone : null,
      intestataA: tipo === "entrata" ? intestataA : null,
      ricorrenza: ricorrenzaData,
    });
    setImportoRaw(""); setImporto(0); setDescrizione(""); setRicorrenza("no"); setSalvato(true);
    setTimeout(() => setSalvato(false), 1500);
  }

  const val = importo || 0;

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
        <input type="text" ref={importoInputRef} inputMode="decimal" value={importoRaw} onChange={e => { setImportoRaw(e.target.value); setImporto(evalImporto(e.target.value)); }} placeholder="0€"
          style={{ ...inputStyle, fontSize: 28, fontWeight: 800, fontFamily: "'Space Mono',monospace", textAlign: "center", color: tipo==="uscita"?"#FF6B6B":"#4ECDC4" }} />
        {isComputed && (
          <div style={{ fontSize: 12, color: "#6C5CE7", textAlign: "center", marginTop: 4 }}>
            = {formattaValuta(computedImporto)}
          </div>
        )}
        {/* Calculator keypad */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr) 100%", gap: 6, marginTop: 10 }}>
          {["+", "-", "*"].map(op => (
            <button key={op} onClick={(e) => { e.preventDefault(); const newVal = importoRaw + op; setImportoRaw(newVal); setImporto(evalImporto(newVal)); importoInputRef.current?.focus(); }}
              style={{ padding: "10px", background: "#1a1a28", border: "1px solid #252538", borderRadius: 10, color: "#6C5CE7", fontSize: 18, fontWeight: 700, cursor: "pointer" }}>
              {op}
            </button>
          ))}
          <button key="=" onClick={(e) => { e.preventDefault(); setImportoRaw(String(computedImporto)); setImporto(computedImporto); importoInputRef.current?.focus(); }}
            style={{ padding: "10px", background: "#6C5CE7", border: "none", borderRadius: 10, color: "#fff", fontSize: 18, fontWeight: 700, cursor: "pointer" }}>
            = {formattaValuta(computedImporto)}
          </button>
        </div>
      </div>
      {tipo === "uscita" && (
        <>
          <div style={{ marginBottom: 18 }}>
            <label style={labelStyle}>Categoria</label>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
              {categorie.map(c => (
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
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {persone.map(p => (
              <button key={p.id} onClick={() => setIntestataA(p.id)} style={{
                flex: "1 1 auto", minWidth: 0, padding: "12px 8px", border: intestataA === p.id ? `2px solid ${p.colore}` : "2px solid #252538",
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
      <div style={{ marginBottom: 18, position: "relative" }}>
        <label style={labelStyle}>Descrizione (opzionale)</label>
        <input
          type="text"
          value={descrizione}
          onChange={e => { setDescrizione(e.target.value); setSuggestOpen(true); }}
          onFocus={() => setSuggestOpen(true)}
          onBlur={() => setTimeout(() => setSuggestOpen(false), 150)}
          placeholder="Es: Pranzo, Benzina..."
          style={inputStyle}
          autoComplete="off"
        />
        {suggestOpen && (() => {
          const catKey = tipo === "entrata" ? "entrata" : categoria;
          const seen = new Set();
          const suggestions = transazioni
            .filter(t => t.categoria === catKey && t.descrizione && t.descrizione.trim() !== "")
            .sort((a, b) => new Date(b.data) - new Date(a.data))
            .map(t => t.descrizione.trim())
            .filter(d => {
              if (seen.has(d)) return false;
              seen.add(d);
              return descrizione === "" || d.toLowerCase().includes(descrizione.toLowerCase());
            })
            .slice(0, 6);
          return suggestions.length > 0 ? (
            <div style={{
              position: "absolute", top: "100%", left: 0, right: 0, zIndex: 100,
              background: "#1a1a28", border: "1px solid #252538", borderRadius: 14,
              marginTop: 4, overflow: "hidden", boxShadow: "0 8px 24px #00000055",
            }}>
              {suggestions.map((s, i) => (
                <div
                  key={i}
                  onMouseDown={() => { setDescrizione(s); setSuggestOpen(false); }}
                  style={{
                    padding: "12px 16px", cursor: "pointer", fontSize: 14,
                    color: "#ddd", fontFamily: "'DM Sans',sans-serif",
                    borderBottom: i < suggestions.length - 1 ? "1px solid #252538" : "none",
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = "#252538"}
                  onMouseLeave={e => e.currentTarget.style.background = "transparent"}
                >{s}</div>
              ))}
            </div>
          ) : null;
        })()}
      </div>
      <div style={{ marginBottom: 24 }}>
        <label style={labelStyle}>Data</label>
        <input type="date" value={data} onChange={e => setData(e.target.value)} style={{ ...inputStyle, colorScheme: "dark" }} />
      </div>
      <div style={{ marginBottom: 24 }}>
        <label style={labelStyle}>Ripeti</label>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {RICORRENZA_OPTIONS.map(opt => (
            <button key={opt.id} onClick={() => setRicorrenza(opt.id)} style={{
              padding: "8px 14px", borderRadius: 20, cursor: "pointer", fontSize: 12, fontWeight: 600,
              fontFamily: "'DM Sans',sans-serif",
              background: ricorrenza === opt.id ? "#6C5CE722" : "#1a1a28",
              border: ricorrenza === opt.id ? "2px solid #6C5CE7" : "2px solid #252538",
              color: ricorrenza === opt.id ? "#a78bfa" : "#666",
              transition: "all 0.15s",
            }}>{opt.label}</button>
          ))}
        </div>
        {ricorrenza !== "no" && (
          <div style={{ fontSize: 11, color: "#6C5CE7", marginTop: 8 }}>
            🔁 Prossima: {calcolaProssimaData(data, ricorrenza)}
          </div>
        )}
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
function StatsView({ transazioni, persone, meseOffset, categorie, goals }) {
  const oggi = new Date();
  const meseVis = new Date(oggi.getFullYear(), oggi.getMonth() - meseOffset, 1);
  const nomeMese = MESI[meseVis.getMonth()] + " " + meseVis.getFullYear();
  const txMese = transazioni.filter(t => { const d=new Date(t.data); return d.getMonth()===meseVis.getMonth()&&d.getFullYear()===meseVis.getFullYear(); });
  const usciteMese = txMese.filter(t => t.tipo === "uscita");
  const totalUscite = usciteMese.reduce((s,t) => s+t.importo, 0);
  const totalEntrate = txMese.filter(t=>t.tipo==="entrata").reduce((s,t)=>s+t.importo,0)
    + txMese.filter(t=>t.tipo==="saldo"&&!persone.some(p=>p.id===t.pagatoDa)).reduce((s,t)=>s+t.importo,0);
  const perCategoria = categorie.map(cat=>({...cat,valore:usciteMese.filter(t=>t.categoria===cat.id).reduce((s,t)=>s+t.importo,0)})).filter(c=>c.valore>0).sort((a,b)=>b.valore-a.valore);
  const ultimi6 = Array.from({length:6},(_,i)=>{const m=new Date(oggi.getFullYear(),oggi.getMonth()-(5-i),1);return{label:MESI[m.getMonth()],valore:transazioni.filter(t=>t.tipo==="uscita"&&new Date(t.data).getMonth()===m.getMonth()&&new Date(t.data).getFullYear()===m.getFullYear()).reduce((s,t)=>s+t.importo,0),colore:"#6C5CE7"};});
  const spesoPerPersona = persone.map(p => ({
    ...p,
    speso: usciteMese.filter(t => t.pagatoDa === p.id).reduce((s, t) => s + t.importo, 0),
  }));
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
  const totalEntratePrec = txMesePrec.filter(t=>t.tipo==="entrata").reduce((s,t)=>s+t.importo,0)
    + txMesePrec.filter(t=>t.tipo==="saldo"&&!persone.some(p=>p.id===t.pagatoDa)).reduce((s,t)=>s+t.importo,0);

  // Month over month change
  const deltaPct = totalUscitePrec > 0 ? ((totalUscite - totalUscitePrec) / totalUscitePrec * 100) : null;
  const deltaEntPct = totalEntratePrec > 0 ? ((totalEntrate - totalEntratePrec) / totalEntratePrec * 100) : null;

  // Category comparison vs previous month
  const catTrends = categorie.map(cat => {
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
    const maxCat = categorie.find(c=>c.id===maxTx.categoria);
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
      {spesoPerPersona.some(p => p.speso > 0) && (
        <div style={{ background: "#1a1a28", borderRadius: 16, padding: "14px 16px", marginBottom: 16, border: "1px solid #252538" }}>
          <div style={{ fontSize: 11, color: "#999", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 10 }}>Chi ha pagato</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 10 }}>
            {spesoPerPersona.map(p => (
              <div key={p.id} style={{ flex: "1 1 120px", display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 20 }}>{p.emoji}</span>
                <div>
                  <div style={{ fontSize: 11, color: p.colore, fontWeight: 600 }}>{p.nome}</div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: "#eee", fontFamily: "'Space Mono',monospace" }}>{formattaValuta(p.speso)}</div>
                </div>
              </div>
            ))}
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
      {goals && goals.length > 0 && (
        <div style={{ background: "#1a1a28", borderRadius: 20, padding: 20, marginBottom: 24, border: "1px solid #252538" }}>
          <div style={{ fontSize: 12, color: "#999", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 16 }}>Obiettivi risparmio</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 12 }}>
            {goals.map(g => {
              const pct = g.targetAmount > 0 ? (g.currentAmount / g.targetAmount * 100) : 0;
              const daysLeft = g.targetDate ? Math.ceil((new Date(g.targetDate) - new Date()) / (1000*60*60*24)) : null;
              return (
                <div key={g.id} style={{ background: "#111119", borderRadius: 12, padding: 12, textAlign: "center" }}>
                  <GoalGauge current={g.currentAmount || 0} target={g.targetAmount} size={70} />
                  <div style={{ fontSize: 12, fontWeight: 600, color: "#eee", marginTop: 8 }}>{g.nome}</div>
                  <div style={{ fontSize: 11, color: pct >= 100 ? "#4ECDC4" : "#888" }}>{pct.toFixed(0)}%</div>
                  {daysLeft !== null && daysLeft < 30 && daysLeft >= 0 && (
                    <div style={{ fontSize: 10, color: "#F0A500", marginTop: 4 }}>{daysLeft}g rimasti</div>
                  )}
                </div>
              );
            })}
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

      {/* ─── Storico saldi 12 mesi ─── */}
      {(() => {
        const mesi12 = Array.from({ length: 12 }, (_, i) => {
          const d = new Date(oggi.getFullYear(), oggi.getMonth() - (11 - i), 1);
          const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
          const txM = transazioni.filter(t => t.data?.slice(0, 7) === ym);
          const e = txM.filter(t => t.tipo === "entrata").reduce((s, t) => s + t.importo, 0);
          const u = txM.filter(t => t.tipo === "uscita").reduce((s, t) => s + t.importo, 0);
          return { label: MESI[d.getMonth()], anno: d.getFullYear(), ym, entrate: e, uscite: u, saldo: e - u };
        });

        const haData = mesi12.some(m => m.entrate > 0 || m.uscite > 0);
        if (!haData) return null;

        const maxVal = Math.max(...mesi12.flatMap(m => [m.entrate, m.uscite]), 1);
        const CHART_H = 90;
        const CHART_W = 300;
        const barW = 8;
        const gap = CHART_W / 12;

        // Saldo line points
        const maxAbs = Math.max(...mesi12.map(m => Math.abs(m.saldo)), 1);
        const midY = CHART_H / 2;
        const saldoPoints = mesi12.map((m, i) => {
          const x = gap * i + gap / 2;
          const y = midY - (m.saldo / maxAbs) * (midY - 8);
          return `${x},${y}`;
        }).join(" ");

        return (
          <div style={{ background: "#1a1a28", borderRadius: 20, padding: "18px 16px", margin: "0 0 24px", border: "1px solid #252538" }}>
            <div style={{ fontSize: 12, color: "#999", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 14 }}>Storico 12 mesi</div>

            {/* Bar chart: entrate + uscite */}
            <div style={{ overflowX: "auto" }}>
              <svg viewBox={`0 0 ${CHART_W} ${CHART_H + 28}`} style={{ width: "100%", minWidth: 280 }}>
                {/* Zero line */}
                <line x1="0" y1={CHART_H} x2={CHART_W} y2={CHART_H} stroke="#252538" strokeWidth="1" />

                {mesi12.map((m, i) => {
                  const x = gap * i + gap / 2;
                  const hE = m.entrate > 0 ? (m.entrate / maxVal) * CHART_H : 0;
                  const hU = m.uscite > 0 ? (m.uscite / maxVal) * CHART_H : 0;
                  const isCurrent = m.ym === `${oggi.getFullYear()}-${String(oggi.getMonth() + 1).padStart(2, "0")}`;
                  return (
                    <g key={m.ym}>
                      {/* Entrate bar */}
                      <rect x={x - barW - 1} y={CHART_H - hE} width={barW} height={Math.max(hE, 1)}
                        rx="2" fill={isCurrent ? "#4ECDC4" : "#4ECDC433"} />
                      {/* Uscite bar */}
                      <rect x={x + 1} y={CHART_H - hU} width={barW} height={Math.max(hU, 1)}
                        rx="2" fill={isCurrent ? "#FF6B6B" : "#FF6B6B33"} />
                      {/* Month label */}
                      <text x={x} y={CHART_H + 12} textAnchor="middle"
                        fill={isCurrent ? "#a78bfa" : "#555"} fontSize="7"
                        fontFamily="'DM Sans',sans-serif" fontWeight={isCurrent ? "700" : "400"}>
                        {m.label}
                      </text>
                      <text x={x} y={CHART_H + 21} textAnchor="middle"
                        fill="#333" fontSize="6" fontFamily="'DM Sans',sans-serif">
                        {m.anno !== oggi.getFullYear() ? m.anno : ""}
                      </text>
                    </g>
                  );
                })}

                {/* Saldo net line */}
                <polyline points={saldoPoints} fill="none" stroke="#a78bfa" strokeWidth="1.5"
                  strokeLinecap="round" strokeLinejoin="round" opacity="0.8" />
                {mesi12.map((m, i) => {
                  const x = gap * i + gap / 2;
                  const y = midY - (m.saldo / maxAbs) * (midY - 8);
                  return <circle key={m.ym} cx={x} cy={y} r="2.5" fill="#a78bfa" opacity="0.9" />;
                })}
              </svg>
            </div>

            {/* Legend */}
            <div style={{ display: "flex", gap: 16, marginTop: 4, justifyContent: "center" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, color: "#888" }}>
                <div style={{ width: 10, height: 10, borderRadius: 2, background: "#4ECDC4" }} /> Entrate
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, color: "#888" }}>
                <div style={{ width: 10, height: 10, borderRadius: 2, background: "#FF6B6B" }} /> Uscite
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, color: "#888" }}>
                <div style={{ width: 16, height: 2, borderRadius: 1, background: "#a78bfa" }} /> Saldo netto
              </div>
            </div>

            {/* Summary row: best and worst month */}
            {(() => {
              const withData = mesi12.filter(m => m.entrate > 0 || m.uscite > 0);
              if (withData.length < 2) return null;
              const best = withData.reduce((a, b) => a.saldo > b.saldo ? a : b);
              const worst = withData.reduce((a, b) => a.saldo < b.saldo ? a : b);
              const avgUscite = withData.reduce((s, m) => s + m.uscite, 0) / withData.length;
              return (
                <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                  <div style={{ flex: 1, background: "#111119", borderRadius: 10, padding: "8px 10px" }}>
                    <div style={{ fontSize: 9, color: "#555", textTransform: "uppercase", letterSpacing: 0.5 }}>Mese migliore</div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#4ECDC4", fontFamily: "'Space Mono',monospace", marginTop: 2 }}>{best.label}</div>
                    <div style={{ fontSize: 10, color: "#4ECDC4" }}>{best.saldo >= 0 ? "+" : ""}{formattaValuta(best.saldo)}</div>
                  </div>
                  <div style={{ flex: 1, background: "#111119", borderRadius: 10, padding: "8px 10px" }}>
                    <div style={{ fontSize: 9, color: "#555", textTransform: "uppercase", letterSpacing: 0.5 }}>Mese peggiore</div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#FF6B6B", fontFamily: "'Space Mono',monospace", marginTop: 2 }}>{worst.label}</div>
                    <div style={{ fontSize: 10, color: "#FF6B6B" }}>{worst.saldo >= 0 ? "+" : ""}{formattaValuta(worst.saldo)}</div>
                  </div>
                  <div style={{ flex: 1, background: "#111119", borderRadius: 10, padding: "8px 10px" }}>
                    <div style={{ fontSize: 9, color: "#555", textTransform: "uppercase", letterSpacing: 0.5 }}>Media uscite</div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#F0A500", fontFamily: "'Space Mono',monospace", marginTop: 2 }}>
                      {formattaValuta(avgUscite)}
                    </div>
                    <div style={{ fontSize: 10, color: "#555" }}>al mese</div>
                  </div>
                </div>
              );
            })()}
          </div>
        );
      })()}
      </div>
    </div>
  );
}

// ─── Portfolio View ───
function PortfolioView() {
  const [positions, setPositions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [ticker, setTicker] = useState("");
  const [nome, setNome] = useState("");
  const [quantita, setQuantita] = useState("");
  const [prezzoAcquisto, setPrezzoAcquisto] = useState("");
  const [dataAcquisto, setDataAcquisto] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState("");
  const [adding, setAdding] = useState(false);
  const [tradeType, setTradeType] = useState("buy");
  const [sortPortfolio, setSortPortfolio] = useState("valore-desc");
  const [expandedTicker, setExpandedTicker] = useState(null);

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

  async function handleAdd() {
    if (!ticker.trim() || !quantita || !prezzoAcquisto) return;
    setAdding(true);
    try {
      const pos = await addPosition({
        ticker: ticker.trim().toUpperCase(), nome: nome.trim() || ticker.trim().toUpperCase(),
        quantita: parseFloat(quantita), prezzoAcquisto: parseFloat(prezzoAcquisto),
        dataAcquisto, note: note.trim(), tipo: tradeType,
      });
      setPositions(prev => [...prev, pos]);
      setTicker(""); setNome(""); setQuantita(""); setPrezzoAcquisto(""); setNote("");
      setShowAdd(false);
    } catch (e) { console.error(e); }
    setAdding(false);
  }

  async function handleDeleteHolding(trades) {
    if (!confirm(`Eliminare tutte le ${trades.length > 1 ? trades.length + " operazioni" : "operazione"} per questo titolo?`)) return;
    await Promise.all(trades.map(t => deletePosition(t.id)));
    const ids = new Set(trades.map(t => t.id));
    setPositions(prev => prev.filter(p => !ids.has(p.id)));
  }

  // ── Manual price overrides (MongoDB) ──
  const [manualPrices, setManualPrices] = useState({});
  const [editingTicker, setEditingTicker] = useState(null);
  const [editPriceVal, setEditPriceVal] = useState("");

  useEffect(() => {
    fetchManualPrices().then(p => setManualPrices(p));
  }, []);

  function saveManualPrices(updated) {
    setManualPrices(updated);
    saveManualPricesRemote(updated);
  }

  function startEditPrice(ticker, currentManual) {
    setEditingTicker(ticker);
    setEditPriceVal(currentManual != null ? String(currentManual) : "");
  }

  function handleSaveManualPrice(ticker) {
    const val = parseFloat(editPriceVal.replace(",", "."));
    if (!isNaN(val) && val > 0) {
      saveManualPrices({ ...manualPrices, [ticker]: val });
    }
    setEditingTicker(null);
    setEditPriceVal("");
  }

  function handleClearManualPrice(ticker) {
    const updated = { ...manualPrices };
    delete updated[ticker];
    saveManualPrices(updated);
    setEditingTicker(null);
  }

  // Portfolio totals — use manual price override, fall back to cost basis
  let totalInvestito = 0, totalValore = 0;
  for (const h of holdings) {
    const manuale = manualPrices[h.ticker];
    const prezzo = manuale || 0;
    totalInvestito += h.costoTotale;
    totalValore += prezzo > 0 ? h.quantita * prezzo : h.costoTotale;
  }
  const totalPL = totalValore - totalInvestito;
  const totalPLPct = totalInvestito > 0 ? (totalPL / totalInvestito * 100) : 0;

  // Sort holdings
  const holdingsOrdinate = [...holdings].sort((a, b) => {
    const ma = manualPrices[a.ticker]; const mb = manualPrices[b.ticker];
    const pa = ma || 0; const pb = mb || 0;
    const va = pa > 0 ? a.quantita * pa : a.costoTotale;
    const vb = pb > 0 ? b.quantita * pb : b.costoTotale;
    const pla = pa > 0 ? va - a.costoTotale : 0;
    const plb = pb > 0 ? vb - b.costoTotale : 0;
    const plpca = a.costoTotale > 0 && pa > 0 ? pla / a.costoTotale * 100 : 0;
    const plpcb = b.costoTotale > 0 && pb > 0 ? plb / b.costoTotale * 100 : 0;
    switch (sortPortfolio) {
      case "valore-desc": return vb - va;
      case "valore-asc":  return va - vb;
      case "pl-desc":     return plb - pla;
      case "pl-asc":      return pla - plb;
      case "plpct-desc":  return plpcb - plpca;
      case "plpct-asc":   return plpca - plpcb;
      case "ticker-asc":  return a.ticker.localeCompare(b.ticker);
      case "ticker-desc": return b.ticker.localeCompare(a.ticker);
      case "investito-desc": return b.costoTotale - a.costoTotale;
      case "investito-asc":  return a.costoTotale - b.costoTotale;
      default: return 0;
    }
  });

  // Sorted holdings for charts (by value descending)
  const holdingsByValue = [...holdings].sort((a, b) => {
    const pa = manualPrices[a.ticker] || 0;
    const pb = manualPrices[b.ticker] || 0;
    const va = pa > 0 ? a.quantita * pa : a.costoTotale;
    const vb = pb > 0 ? b.quantita * pb : b.costoTotale;
    return vb - va;
  });

  const holdingsByPL = [...holdings].sort((a, b) => {
    const pa = manualPrices[a.ticker] || 0;
    const pb = manualPrices[b.ticker] || 0;
    const pla = pa > 0 ? (a.quantita * pa) - a.costoTotale : 0;
    const plb = pb > 0 ? (b.quantita * pb) - b.costoTotale : 0;
    return plb - pla;
  });

  if (loading) return <div style={{ padding: 40, textAlign: "center", color: "#888" }}>Caricamento portfolio...</div>;

  return (
    <div style={{ padding: "20px 16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 800, color: "#eee" }}>Portfolio</div>
          <div style={{ fontSize: 12, color: "#888" }}>{holdings.length} titoli</div>
        </div>
        <button onClick={() => setShowAdd(!showAdd)} style={{
            background: showAdd ? "#6C5CE722" : "none", border: showAdd ? "1px solid #6C5CE7" : "1px solid #252538",
            borderRadius: 8, cursor: "pointer", color: showAdd ? "#6C5CE7" : "#888", fontSize: 16, padding: "4px 10px",
          }}>{showAdd ? "✕" : "+"}</button>
      </div>

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
          
          {/* Buy/Sell toggle */}
          <div style={{ display: "flex", background: "#111119", borderRadius: 12, padding: 3, marginBottom: 12, border: "1px solid #252538" }}>
            {["buy", "sell"].map(tp => (
              <button key={tp} onClick={() => setTradeType(tp)} style={{
                flex: 1, padding: "8px 0", border: "none", borderRadius: 10, cursor: "pointer",
                fontSize: 13, fontWeight: 600,
                background: tradeType === tp ? (tp === "buy" ? "#4ECDC422" : "#FF6B6B22") : "transparent",
                color: tradeType === tp ? (tp === "buy" ? "#4ECDC4" : "#FF6B6B") : "#666",
              }}>{tp === "buy" ? "▲ Acquista" : "▼ Vendi"}</button>
            ))}
          </div>
          
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
            background: ticker && quantita && prezzoAcquisto ? (tradeType === "buy" ? "linear-gradient(135deg, #4ECDC4, #3ab8b0)" : "linear-gradient(135deg, #FF6B6B, #e05050)") : "#252538",
            opacity: adding ? 0.6 : 1,
          }}>{adding ? "Salvataggio..." : (tradeType === "buy" ? "Aggiungi acquisto" : "Registra vendita")}</button>
        </div>
      )}

      {/* Holdings list */}
      {holdings.length === 0 ? (
        <div style={{ color: "#555", textAlign: "center", padding: 40, fontSize: 14 }}>
          Nessuna posizione ancora.<br/>Tocca + per aggiungere un titolo.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {/* Sort selector */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 11, color: "#555", flexShrink: 0 }}>Ordina per</span>
            <select value={sortPortfolio} onChange={e => setSortPortfolio(e.target.value)} style={{
              flex: 1, background: "#1a1a28", border: "1px solid #252538", borderRadius: 8,
              color: "#aaa", fontSize: 12, padding: "6px 8px", fontFamily: "'DM Sans',sans-serif",
              colorScheme: "dark", cursor: "pointer",
            }}>
              <option value="valore-desc">Valore ↓ (più alto)</option>
              <option value="valore-asc">Valore ↑ (più basso)</option>
              <option value="pl-desc">P&L € ↓ (migliore)</option>
              <option value="pl-asc">P&L € ↑ (peggiore)</option>
              <option value="plpct-desc">P&L % ↓ (migliore)</option>
              <option value="plpct-asc">P&L % ↑ (peggiore)</option>
              <option value="investito-desc">Investito ↓</option>
              <option value="investito-asc">Investito ↑</option>
              <option value="ticker-asc">Ticker A→Z</option>
              <option value="ticker-desc">Ticker Z→A</option>
            </select>
          </div>

          {holdingsOrdinate.map(h => {
            const manuale = manualPrices[h.ticker];
            const isManuale = manuale > 0;
            const prezzoCorrente = manuale || 0;
            const valoreCorrente = prezzoCorrente > 0 ? h.quantita * prezzoCorrente : h.costoTotale;
            const pl = prezzoCorrente > 0 ? valoreCorrente - h.costoTotale : 0;
            const plPct = h.costoTotale > 0 && prezzoCorrente > 0 ? (pl / h.costoTotale * 100) : 0;
            const isEditing = editingTicker === h.ticker;

            return (
              <div key={h.ticker} style={{ background: "#1a1a28", borderRadius: 16, padding: "14px 16px", border: isEditing ? "1px solid #6C5CE7" : "1px solid #252538", transition: "border-color 0.2s" }}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 8 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 15, fontWeight: 800, color: "#eee", fontFamily: "'Space Mono',monospace", flexShrink: 0 }}>{h.ticker}</span>
                      <span style={{ fontSize: 11, color: "#888", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{h.nome}</span>
                      {isManuale && (
                        <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 5px", borderRadius: 4, background: "#F0A50022", color: "#F0A500", letterSpacing: 0.3, flexShrink: 0 }}>MANUALE</span>
                      )}
                    </div>
                    <div style={{ fontSize: 11, color: "#666", marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {h.quantita.toFixed(h.quantita % 1 === 0 ? 0 : 2)} pz × {formattaValuta(h.prezzoMedio)} medio
                    </div>
                  </div>
                  <div style={{ textAlign: "right", flexShrink: 0, maxWidth: "48%" }}>
                    <div style={{ fontSize: 15, fontWeight: 700, fontFamily: "'Space Mono',monospace", color: "#eee", wordBreak: "break-all" }}>
                      {prezzoCorrente > 0 ? formattaValuta(valoreCorrente) : "—"}
                    </div>
                    {prezzoCorrente > 0 && (
                      <div style={{ fontSize: 11, fontWeight: 700, fontFamily: "'Space Mono',monospace", color: pl >= 0 ? "#4ECDC4" : "#FF6B6B", wordBreak: "break-all" }}>
                        {pl >= 0 ? "+" : ""}{formattaValuta(pl)}<br/>
                        <span style={{ fontSize: 10 }}>({plPct >= 0 ? "+" : ""}{plPct.toFixed(1)}%)</span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Price bar */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                  <div style={{ minWidth: 0, overflow: "hidden" }}>
                    {prezzoCorrente > 0 && !isEditing ? (
                      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 12, color: "#aaa", fontFamily: "'Space Mono',monospace", whiteSpace: "nowrap" }}>{formattaValuta(prezzoCorrente)}</span>
                      </div>
                    ) : !isEditing ? (
                      <span style={{ fontSize: 11, color: "#555" }}>Inserisci prezzo manuale</span>
                    ) : null}
                  </div>

                  {/* Edit ✏ + Delete × — always on right, never wrap */}
                  {!isEditing && (
                    <div style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
                      <button onClick={() => startEditPrice(h.ticker, manuale)} title="Aggiorna prezzo manualmente" style={{
                        background: prezzoCorrente === 0 ? "#6C5CE722" : "none",
                        border: prezzoCorrente === 0 ? "1px solid #6C5CE755" : "none",
                        borderRadius: 7, color: prezzoCorrente === 0 ? "#a78bfa" : "#555",
                        cursor: "pointer", fontSize: 13, lineHeight: 1,
                        padding: prezzoCorrente === 0 ? "4px 8px" : "4px 6px",
                        fontFamily: "'DM Sans',sans-serif",
                      }}>✏</button>
                      <button onClick={() => handleDeleteHolding(h.trades)} style={{
                        background: "none", border: "none", color: "#555", cursor: "pointer", fontSize: 16, lineHeight: 1, padding: "4px 6px",
                      }}>×</button>
                    </div>
                  )}
                </div>

                {/* "Inserisci prezzo" call-to-action when no price and not editing */}
                {prezzoCorrente === 0 && !isEditing && (
                  <button onClick={() => startEditPrice(h.ticker, manuale)} style={{
                    marginTop: 8, width: "100%", padding: "8px", background: "#6C5CE711",
                    border: "1px dashed #6C5CE755", borderRadius: 10, color: "#a78bfa",
                    cursor: "pointer", fontSize: 12, fontWeight: 700, fontFamily: "'DM Sans',sans-serif",
                  }}>✏ Inserisci prezzo manuale</button>
                )}

                {/* Inline manual price editor */}
                {isEditing && (
                  <div style={{ marginTop: 10, padding: "12px", background: "#111119", borderRadius: 12, border: "1px solid #6C5CE733" }}>
                    <div style={{ fontSize: 11, color: "#a78bfa", fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 8 }}>
                      Prezzo manuale — {h.ticker}
                    </div>
                    <input
                      type="number" inputMode="decimal" autoFocus
                      value={editPriceVal}
                      onChange={e => setEditPriceVal(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter") handleSaveManualPrice(h.ticker); if (e.key === "Escape") setEditingTicker(null); }}
                      placeholder="Es: 42.50"
                      style={{ width: "100%", padding: "10px 12px", background: "#1a1a28", border: "1px solid #6C5CE7", borderRadius: 10, color: "#eee", fontSize: 16, fontFamily: "'Space Mono',monospace", outline: "none", boxSizing: "border-box", marginBottom: 8 }}
                    />
                    <div style={{ display: "flex", gap: 8 }}>
                      <button onClick={() => handleSaveManualPrice(h.ticker)} style={{
                        flex: 1, padding: "10px", background: "linear-gradient(135deg, #6C5CE7, #a855f7)", border: "none",
                        borderRadius: 10, color: "#fff", fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: "'DM Sans',sans-serif",
                      }}>Salva</button>
                      <button onClick={() => setEditingTicker(null)} style={{
                        padding: "10px 14px", background: "none", border: "1px solid #333", borderRadius: 10,
                        color: "#888", fontSize: 14, cursor: "pointer", fontFamily: "'DM Sans',sans-serif",
                      }}>✕</button>
                    </div>
                    {manuale && (
                      <button onClick={() => handleClearManualPrice(h.ticker)} style={{
                        marginTop: 8, background: "none", border: "none", color: "#FF6B6B88", cursor: "pointer",
                        fontSize: 11, fontFamily: "'DM Sans',sans-serif", padding: 0,
                      }}>Rimuovi prezzo manuale</button>
                    )}
                    <div style={{ fontSize: 10, color: "#555", marginTop: 8 }}>
                      Il prezzo API verrà usato automaticamente se disponibile.
                    </div>
                  </div>
                )}

                {/* Toggle trade history button */}
                {h.trades && h.trades.length > 1 && !isEditing && (
                  <button onClick={() => setExpandedTicker(expandedTicker === h.ticker ? null : h.ticker)} style={{
                    marginTop: 8, width: "100%", padding: "6px", background: "none",
                    border: "none", color: "#6C5CE7", cursor: "pointer",
                    fontSize: 11, fontFamily: "'DM Sans',sans-serif",
                  }}>
                    {expandedTicker === h.ticker ? "▲ Nascondi storico" : `▼ Vedi ${h.trades.length} trades`}
                  </button>
                )}

                {/* Expandable trade history */}
                {expandedTicker === h.ticker && h.trades && h.trades.length > 0 && (
                  <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid #252538" }}>
                    <div style={{ fontSize: 10, color: "#888", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 8 }}>Storico trades</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      {[...h.trades].sort((a, b) => new Date(b.dataAcquisto) - new Date(a.dataAcquisto)).map((t, i) => (
                        <div key={t.id || i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", background: "#111119", borderRadius: 8 }}>
                          <span style={{ fontSize: 10, color: "#666", minWidth: 60 }}>{t.dataAcquisto}</span>
                          <span style={{ fontSize: 11, fontWeight: 600, color: t.tipo === "sell" ? "#FF6B6B" : "#4ECDC4", minWidth: 35 }}>
                            {t.tipo === "sell" ? "SELL" : "BUY"}
                          </span>
                          <span style={{ flex: 1, fontSize: 12, color: "#ccc", fontFamily: "'Space Mono',monospace" }}>{t.quantita} pz</span>
                          <span style={{ fontSize: 12, color: "#aaa", fontFamily: "'Space Mono',monospace" }}>@{formattaValuta(t.prezzoAcquisto)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Allocation pie chart */}
      {holdings.length >= 2 && totalValore > 0 && (
        <div style={{ background: "#1a1a28", borderRadius: 20, padding: 20, marginTop: 16, border: "1px solid #252538" }}>
          <div style={{ fontSize: 12, color: "#999", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 14 }}>Allocazione</div>
          <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
            <DonutChart segmenti={holdingsByValue.map((h, i) => {
              const prezzo = manualPrices[h.ticker] || 0;
              const val = prezzo > 0 ? h.quantita * prezzo : h.costoTotale;
              const colors = ["#6C5CE7", "#4ECDC4", "#FF6B6B", "#FFEAA7", "#DDA0DD", "#F0A500", "#74B9FF", "#55EFC4"];
              return { valore: val, colore: colors[i % colors.length], label: h.ticker };
            })} />
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
              {holdingsByValue.map((h, i) => {
                const prezzo = manualPrices[h.ticker] || 0;
                const val = prezzo > 0 ? h.quantita * prezzo : h.costoTotale;
                const pct = totalValore > 0 ? (val / totalValore * 100) : 0;
                const colors = ["#6C5CE7", "#4ECDC4", "#FF6B6B", "#FFEAA7", "#DDA0DD", "#F0A500", "#74B9FF", "#55EFC4"];
                const color = colors[i % colors.length];
                return (
                  <div key={h.ticker} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <div style={{ width: 10, height: 10, borderRadius: 3, background: color }} />
                    <span style={{ fontSize: 12, color: "#ccc", fontWeight: 600, flex: 1 }}>{h.ticker}</span>
                    <span style={{ fontSize: 12, color: "#aaa", fontFamily: "'Space Mono',monospace" }}>{pct.toFixed(1)}%</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* P&L Bar Chart */}
      {holdings.length >= 1 && totalValore > 0 && (
        <div style={{ background: "#1a1a28", borderRadius: 20, padding: 20, marginTop: 16, border: "1px solid #252538" }}>
          <div style={{ fontSize: 12, color: "#999", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 14 }}>Profit & Loss</div>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 100 }}>
            {holdingsByPL.map(h => {
              const prezzo = manualPrices[h.ticker] || 0;
              const valore = prezzo > 0 ? h.quantita * prezzo : 0;
              const pl = prezzo > 0 ? valore - h.costoTotale : 0;
              const maxPL = Math.max(...holdings.map(h => {
                const p = manualPrices[h.ticker] || 0;
                return p > 0 ? Math.abs((h.quantita * p) - h.costoTotale) : 0;
              }), 1);
              const height = Math.max(2, (Math.abs(pl) / maxPL) * 80);
              const isPositive = pl >= 0;
              return (
                <div key={h.ticker} style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: 1 }}>
                  <div style={{ width: "100%", maxWidth: 28, height, background: isPositive ? "#4ECDC4" : "#FF6B6B", borderRadius: "4px 4px 0 0", transition: "height 0.5s" }} />
                  <span style={{ fontSize: 9, color: "#888", marginTop: 4 }}>{h.ticker}</span>
                  <span style={{ fontSize: 8, color: isPositive ? "#4ECDC4" : "#FF6B6B" }}>{isPositive ? "+" : ""}{pl >= 1000 ? (pl/1000).toFixed(1) + "k" : pl.toFixed(0)}€</span>
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
  { id: "ricevutoDa", label: "Ricevuto da" },
  { id: "partecipanti", label: "Partecipanti e quote" },
];

function ExportView({ transazioni, persone, positions, onImport, onImportComplete, onImportPosition, onImportPositionComplete }) {
  const oggi = new Date();
  const [meseDa, setMeseDa] = useState(`${oggi.getFullYear()}-${String(oggi.getMonth()+1).padStart(2,"0")}`);
  const [meseA, setMeseA] = useState(meseDa);
  const [colonne, setColonne] = useState(ALL_COLUMNS.map(c => c.id));
  const [ordinamento, setOrdinamento] = useState("data-asc");
  const [esportando, setEsportando] = useState(false);
  const [includiPortfolio, setIncludiPortfolio] = useState(false);

  // Import state
  const [importando, setImportando] = useState(false);
  const [importPreview, setImportPreview] = useState(null);
  const [importPortfolioPreview, setImportPortfolioPreview] = useState(null);
  const [importFile, setImportFile] = useState(null);

  function toggleColonna(id) {
    setColonne(prev => prev.includes(id) ? prev.filter(c => c !== id) : [...prev, id]);
  }

  function selezionaTutte() { setColonne(ALL_COLUMNS.map(c => c.id)); }
  function deselezionaTutte() { setColonne(["data", "importo"]); } // minimo

  async function parseImportFile(file) {
    setImportando(true);
    setImportPreview(null);
    setImportPortfolioPreview(null);
    try {
      const XLSX = await import("xlsx");
      const buffer = await file.arrayBuffer();
      const wb = XLSX.read(buffer, { type: "array" });

      // ── Parse transactions (first non-Portfolio sheet) ──
      const txSheetName = wb.SheetNames.find(n => n !== "Portfolio") || wb.SheetNames[0];
      const ws = wb.Sheets[txSheetName];
      const rawRows = XLSX.utils.sheet_to_json(ws, { defval: "" });

      const righe = [];
      const errori = [];

      rawRows.forEach((row, i) => {
        const num = i + 2;
        const data = String(row["Data"] || "").trim();
        const tipoRaw = String(row["Tipo"] || "").toLowerCase().trim();
        const importoRaw = row["Importo (€)"] ?? row["Importo"] ?? "";
        const categoria = String(row["Categoria"] || "Altro").trim();
        const descrizione = String(row["Descrizione"] || "").trim();
        const pagatoDaNome = String(row["Pagato da"] || "").trim();
        const ricevutoDaNome = String(row["Ricevuto da"] || "").trim();

        if (!data.match(/^\d{4}-\d{2}-\d{2}$/)) {
          errori.push(`Riga ${num}: data non valida ("${data}") — formato atteso YYYY-MM-DD`);
          return;
        }
        const tipo = tipoRaw === "saldo" ? "saldo" : tipoRaw === "entrata" ? "entrata" : "uscita";
        const importo = parseFloat(String(importoRaw).replace(",", "."));
        if (isNaN(importo) || importo <= 0) {
          errori.push(`Riga ${num}: importo non valido ("${importoRaw}")`);
          return;
        }
        const persona = persone.find(p => p.nome.toLowerCase() === pagatoDaNome.toLowerCase());
        const pagatoDa = persona?.id || persone[0]?.id || "";
        const ricevutoDaPersona = persone.find(p => p.nome.toLowerCase() === ricevutoDaNome.toLowerCase());
        const ricevutoDa = ricevutoDaPersona?.id || null;

        let splits = null;
        let extraPersone = null;
        const partecipantiRaw = String(row["Partecipanti e quote"] || row["Partecipanti"] || "").trim();
        if (tipo === "uscita" && partecipantiRaw) {
          const extraMap = {};
          let extraCount = 0;
          const parsed = partecipantiRaw.split(",").map(s => s.trim()).map(s => {
            const m = s.match(/^(.+?)\s+(\d+(?:\.\d+)?)%$/);
            if (!m) return null;
            const nome = m[1].trim();
            const quota = parseFloat(m[2]);
            const p = persone.find(x => x.nome.toLowerCase() === nome.toLowerCase());
            if (p) return { personaId: p.id, quota };
            const id = nome.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "") || `extra${extraCount}`;
            if (!extraMap[id]) {
              extraMap[id] = { id, nome, emoji: "👤", colore: COLORI_EXTRA[extraCount % COLORI_EXTRA.length] };
              extraCount++;
            }
            return { personaId: id, quota };
          }).filter(Boolean);

          const extraList = Object.values(extraMap);
          if (extraList.length > 0) extraPersone = extraList;

          if (parsed.length > 0) {
            const assignedTotal = parsed.reduce((s, x) => s + x.quota, 0);
            const remaining = Math.round((100 - assignedTotal) * 100) / 100;
            const unassigned = persone.filter(p => !parsed.find(x => x.personaId === p.id));
            if (remaining > 0.5 && unassigned.length > 0) {
              const share = Math.floor(remaining / unassigned.length);
              let leftover = remaining - share * unassigned.length;
              unassigned.forEach((p, i) => {
                parsed.push({ personaId: p.id, quota: share + (i === 0 ? Math.round(leftover) : 0) });
              });
            }
            splits = parsed;
          }
        }
        if (tipo === "uscita" && !splits) {
          splits = persone.map((p, i) => ({
            personaId: p.id,
            quota: i === persone.length - 1
              ? 100 - Math.floor(100 / persone.length) * (persone.length - 1)
              : Math.floor(100 / persone.length),
          }));
        }

        righe.push({ data, tipo, importo, categoria: tipo === "saldo" ? null : categoria, descrizione, pagatoDa, ricevutoDa, splits, extraPersone });
      });

      setImportPreview({ righe, errori });

      // ── Parse Portfolio sheet (if present) ──
      if (wb.SheetNames.includes("Portfolio")) {
        const wsP = wb.Sheets["Portfolio"];
        const rawP = XLSX.utils.sheet_to_json(wsP, { defval: "" });
        const posizioni = [];
        const erroriP = [];

        rawP.forEach((row, i) => {
          const num = i + 2;
          const ticker = String(row["Ticker"] || "").trim().toUpperCase();
          const nome = String(row["Nome"] || ticker).trim();
          const tipoRaw = String(row["Tipo"] || "").toLowerCase().trim();
          const tipo = tipoRaw === "vendita" ? "sell" : "buy";
          const quantita = parseFloat(String(row["Quantità"] ?? row["Quantita"] ?? "").replace(",", "."));
          const prezzoAcquisto = parseFloat(String(row["Prezzo (€)"] ?? row["Prezzo"] ?? "").replace(",", "."));
          const dataAcquisto = String(row["Data"] || "").trim();
          const note = String(row["Note"] || "").trim();

          if (!ticker) { erroriP.push(`Riga ${num}: ticker mancante`); return; }
          if (isNaN(quantita) || quantita <= 0) { erroriP.push(`Riga ${num}: quantità non valida`); return; }
          if (isNaN(prezzoAcquisto) || prezzoAcquisto < 0) { erroriP.push(`Riga ${num}: prezzo non valido`); return; }

          posizioni.push({ ticker, nome, tipo, quantita, prezzoAcquisto, dataAcquisto, note });
        });

        if (posizioni.length > 0 || erroriP.length > 0) {
          setImportPortfolioPreview({ posizioni, errori: erroriP });
        }
      }

    } catch (err) {
      alert("Errore nel parsing del file: " + err.message);
    } finally {
      setImportando(false);
    }
  }

  async function confermaImport() {
    if (!importPreview?.righe?.length && !importPortfolioPreview?.posizioni?.length) return;
    setImportando(true);
    let okTx = 0, failTx = 0, okPos = 0, failPos = 0;

    // Import transactions
    for (const tx of (importPreview?.righe || [])) {
      try { await onImport(tx); okTx++; }
      catch { failTx++; }
    }
    if (okTx > 0 && onImportComplete) await onImportComplete();

    // Import portfolio positions
    for (const pos of (importPortfolioPreview?.posizioni || [])) {
      try { await onImportPosition(pos); okPos++; }
      catch { failPos++; }
    }
    if (okPos > 0 && onImportPositionComplete) await onImportPositionComplete();

    setImportando(false);
    setImportPreview(null);
    setImportPortfolioPreview(null);
    setImportFile(null);

    const parts = [];
    if (okTx > 0) parts.push(`${okTx} transazioni`);
    if (okPos > 0) parts.push(`${okPos} posizioni portfolio`);
    const errParts = [];
    if (failTx > 0) errParts.push(`${failTx} transazioni`);
    if (failPos > 0) errParts.push(`${failPos} posizioni`);
    alert(`Import completato: ${parts.join(" e ")} importate${errParts.length ? `, errori: ${errParts.join(", ")}` : ""}.`);
  }

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
        if (colonne.includes("tipo")) row["Tipo"] = t.tipo === "saldo" ? "Saldo" : t.tipo === "uscita" ? "Uscita" : "Entrata";
        if (colonne.includes("importo")) row["Importo (€)"] = t.importo;
        if (colonne.includes("categoria")) row["Categoria"] = t.tipo === "saldo" ? "" : (t.categoria || "");
        if (colonne.includes("descrizione")) row["Descrizione"] = t.descrizione || "";
        if (colonne.includes("pagatoDa")) row["Pagato da"] = p?.nome || t.pagatoDa || "";
        if (colonne.includes("ricevutoDa")) {
          const rp = persone.find(x => x.id === t.ricevutoDa);
          row["Ricevuto da"] = rp?.nome || t.ricevutoDa || "";
        }
        if (colonne.includes("partecipanti") && t.tipo !== "saldo") {
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
      const colWidths = Object.keys(rows[0] || {}).map(key => ({
        wch: Math.max(key.length, ...rows.map(r => String(r[key] ?? "").length)) + 2,
      }));
      ws["!cols"] = colWidths;

      const wb = XLSX.utils.book_new();
      const sheetName = meseDa === meseA ? meseDa : `${meseDa}_${meseA}`;
      XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));

      // Optional portfolio sheet
      if (includiPortfolio && positions && positions.length > 0) {
        const pRows = positions.map(p => ({
          "Ticker": p.ticker || "",
          "Nome": p.nome || p.ticker || "",
          "Tipo": p.tipo === "sell" ? "Vendita" : "Acquisto",
          "Quantità": p.quantita,
          "Prezzo (€)": p.prezzoAcquisto,
          "Data": p.dataAcquisto || "",
          "Note": p.note || "",
        }));
        const wsP = XLSX.utils.json_to_sheet(pRows);
        const colWidthsP = Object.keys(pRows[0] || {}).map(key => ({
          wch: Math.max(key.length, ...pRows.map(r => String(r[key] ?? "").length)) + 2,
        }));
        wsP["!cols"] = colWidthsP;
        XLSX.utils.book_append_sheet(wb, wsP, "Portfolio");
      }

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
      {/* ─── IMPORT SECTION ─── */}
      <div style={{ fontSize: 22, fontWeight: 800, color: "#eee", marginBottom: 6 }}>Importa dati</div>
      <div style={{ fontSize: 13, color: "#888", marginBottom: 16 }}>
        Carica un file XLSX o CSV con lo stesso formato dell'export
      </div>

      <label style={{
        display: "block", padding: "18px 16px", borderRadius: 16, cursor: "pointer",
        border: "2px dashed #252538", background: "#1a1a28", textAlign: "center",
        color: importFile ? "#ccc" : "#555", fontSize: 13, marginBottom: 12, transition: "all 0.2s",
      }}>
        <span style={{ fontSize: 22, display: "block", marginBottom: 6 }}>📂</span>
        {importFile ? importFile.name : "Tocca per scegliere un file XLSX o CSV"}
        <input type="file" accept=".xlsx,.csv" style={{ display: "none" }}
          onChange={e => {
            const f = e.target.files?.[0];
            if (f) { setImportFile(f); parseImportFile(f); }
            e.target.value = "";
          }}
        />
      </label>

      {importando && (
        <div style={{ textAlign: "center", color: "#6C5CE7", marginBottom: 12, fontSize: 13, padding: "10px 0" }}>
          Analisi in corso...
        </div>
      )}

      {importPreview && !importando && (
        <div style={{ background: "#1a1a28", borderRadius: 16, padding: 16, marginBottom: 16, border: "1px solid #252538" }}>
          <div style={{ fontWeight: 700, color: "#eee", marginBottom: 10, fontSize: 14 }}>Anteprima import</div>
          <div style={{ fontSize: 13, color: "#4ECDC4", marginBottom: importPreview.errori.length ? 8 : 0 }}>
            ✓ {importPreview.righe.length} transazioni valide
          </div>
          {importPreview.errori.length > 0 && (
            <div style={{ fontSize: 11, color: "#FF6B6B", marginBottom: 8, lineHeight: 1.6 }}>
              {importPreview.errori.map((e, i) => <div key={i}>⚠ {e}</div>)}
            </div>
          )}
          {importPreview.righe.length > 0 && (
            <>
              <div style={{ borderTop: "1px solid #252538", marginTop: 8, paddingTop: 8 }}>
                {importPreview.righe.slice(0, 3).map((r, i) => (
                  <div key={i} style={{ fontSize: 11, color: "#888", paddingBottom: 5, display: "flex", justifyContent: "space-between" }}>
                    <span>{r.data} · {r.tipo === "saldo" ? "Saldo" : r.categoria}</span>
                    <span style={{ color: r.tipo === "uscita" ? "#FF6B6B" : r.tipo === "saldo" ? "#a78bfa" : "#4ECDC4", fontFamily: "'Space Mono',monospace" }}>
                      {r.tipo === "uscita" ? "-" : r.tipo === "saldo" ? "↔" : "+"}€{r.importo.toFixed(2)}
                    </span>
                  </div>
                ))}
                {importPreview.righe.length > 3 && (
                  <div style={{ fontSize: 11, color: "#555", marginTop: 2 }}>+ altre {importPreview.righe.length - 3} righe...</div>
                )}
              </div>
              <button onClick={confermaImport} disabled={importando} style={{
                marginTop: 14, width: "100%", padding: "14px", border: "none",
                borderRadius: 14, cursor: "pointer", fontFamily: "'DM Sans',sans-serif",
                fontSize: 15, fontWeight: 700,
                background: "linear-gradient(135deg, #4ECDC4, #26a69a)",
                color: "#fff", boxShadow: "0 4px 20px #4ECDC433",
              }}>
                Importa {(importPreview?.righe?.length || 0) + (importPortfolioPreview?.posizioni?.length || 0)} elementi
              </button>
            </>
          )}
        </div>
      )}

      {/* Portfolio sheet preview */}
      {importPortfolioPreview && !importando && (
        <div style={{ background: "#1a1a28", borderRadius: 16, padding: 16, marginBottom: 16, border: "1px solid #252538" }}>
          <div style={{ fontWeight: 700, color: "#eee", marginBottom: 8, fontSize: 14 }}>📈 Portfolio trovato</div>
          <div style={{ fontSize: 13, color: "#4ECDC4", marginBottom: importPortfolioPreview.errori.length ? 8 : 0 }}>
            ✓ {importPortfolioPreview.posizioni.length} posizioni valide
          </div>
          {importPortfolioPreview.errori.length > 0 && (
            <div style={{ fontSize: 11, color: "#FF6B6B", marginBottom: 8, lineHeight: 1.6 }}>
              {importPortfolioPreview.errori.map((e, i) => <div key={i}>⚠ {e}</div>)}
            </div>
          )}
          <div style={{ borderTop: "1px solid #252538", marginTop: 6, paddingTop: 6 }}>
            {importPortfolioPreview.posizioni.slice(0, 3).map((p, i) => (
              <div key={i} style={{ fontSize: 11, color: "#888", paddingBottom: 5, display: "flex", justifyContent: "space-between" }}>
                <span style={{ fontFamily: "'Space Mono',monospace", color: "#ccc" }}>{p.ticker}</span>
                <span>{p.tipo === "sell" ? "Vendita" : "Acquisto"} {p.quantita} pz × €{p.prezzoAcquisto}</span>
              </div>
            ))}
            {importPortfolioPreview.posizioni.length > 3 && (
              <div style={{ fontSize: 11, color: "#555", marginTop: 2 }}>+ altre {importPortfolioPreview.posizioni.length - 3}...</div>
            )}
          </div>
        </div>
      )}

      <div style={{ borderTop: "1px solid #1e1e2e", margin: "24px 0" }} />

      {/* ─── EXPORT SECTION ─── */}
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

      {/* Portfolio include toggle */}
      {positions?.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, padding: "12px 14px", background: "#1a1a28", borderRadius: 12, border: "1px solid #252538", cursor: "pointer" }}
          onClick={() => setIncludiPortfolio(v => !v)}>
          <div style={{
            width: 22, height: 22, borderRadius: 6, flexShrink: 0,
            border: includiPortfolio ? "2px solid #6C5CE7" : "2px solid #333",
            background: includiPortfolio ? "#6C5CE7" : "transparent",
            display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.15s",
          }}>{includiPortfolio && <span style={{ color: "#fff", fontSize: 13, lineHeight: 1 }}>✓</span>}</div>
          <div>
            <div style={{ fontSize: 13, color: "#ccc", fontWeight: 600 }}>Includi portfolio</div>
            <div style={{ fontSize: 11, color: "#555" }}>{positions.length} posizioni → sheet "Portfolio"</div>
          </div>
        </div>
      )}

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
function PinDots({ value, maxLen, shake }) {
  return (
    <div style={{ display: "flex", gap: 14, justifyContent: "center", margin: "24px 0 20px",
      animation: shake ? "pinShake 0.4s ease" : "none" }}>
      {Array.from({ length: maxLen }).map((_, i) => (
        <div key={i} style={{
          width: 14, height: 14, borderRadius: "50%",
          background: i < value.length ? "linear-gradient(135deg, #6C5CE7, #a855f7)" : "#252538",
          border: i < value.length ? "none" : "2px solid #333",
          transition: "background 0.15s, transform 0.15s",
          transform: i === value.length - 1 ? "scale(1.25)" : "scale(1)",
        }} />
      ))}
    </div>
  );
}

function NumPad({ onDigit, onDelete, disabled }) {
  const keys = ["1","2","3","4","5","6","7","8","9","","0","⌫"];
  const btnBase = {
    border: "none", borderRadius: 18, fontFamily: "'DM Sans',sans-serif",
    fontSize: 24, fontWeight: 700, cursor: "pointer", transition: "all 0.12s",
    display: "flex", alignItems: "center", justifyContent: "center",
    height: 68, userSelect: "none", WebkitUserSelect: "none",
  };
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, width: "100%", maxWidth: 280, margin: "0 auto" }}>
      {keys.map((k, i) => {
        if (k === "") return <div key={i} />;
        const isDel = k === "⌫";
        return (
          <button key={i}
            onPointerDown={e => { e.preventDefault(); if (disabled) return; isDel ? onDelete() : onDigit(k); }}
            style={{
              ...btnBase,
              background: isDel ? "transparent" : "#1a1a28",
              color: isDel ? "#888" : "#eee",
              border: isDel ? "none" : "1px solid #252538",
              fontSize: isDel ? 20 : 24,
              opacity: disabled ? 0.4 : 1,
            }}
          >{k}</button>
        );
      })}
    </div>
  );
}

function LoginScreen({ onLogin }) {
  const [mode, setMode] = useState("login"); // "login" | "register" | "change-pin"

  // Login state — numpad
  const [pin, setPin] = useState("");
  const [loginErrore, setLoginErrore] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);
  const [pinShake, setPinShake] = useState(false);
  const PIN_LEN = 6; // auto-submit at 6 digits (minimum PIN length)

  // Register state
  const [regNome, setRegNome] = useState("");
  const [regPersone, setRegPersone] = useState([{ nome: "", emoji: "😀" }, { nome: "", emoji: "😊" }]);
  const [regPin, setRegPin] = useState("");
  const [regPinConferma, setRegPinConferma] = useState("");
  const [regErrore, setRegErrore] = useState("");
  const [regLoading, setRegLoading] = useState(false);
  const [regSuccesso, setRegSuccesso] = useState(false);
  const [emojiPickerIdx, setEmojiPickerIdx] = useState(null); // which persona's picker is open

  const [loginFromCache, setLoginFromCache] = useState(false);
  const [loginSubtitle, setLoginSubtitle] = useState("");

  // PIN change state
  const [newPin, setNewPin] = useState("");
  const [newPinConferma, setNewPinConferma] = useState("");
  const [changePinStep, setChangePinStep] = useState("new"); // "new" | "confirm"
  const [changePinErrore, setChangePinErrore] = useState("");
  const [changePinLoading, setChangePinLoading] = useState(false);

  async function handleChangePinDigit(d) {
    if (changePinStep === "new") {
      const val = newPin + d;
      if (val.length <= 8) setNewPin(val);
    } else {
      const val = newPinConferma + d;
      if (val.length <= 8) setNewPinConferma(val);
    }
  }
  function handleChangePinDelete() {
    if (changePinStep === "new") setNewPin(p => p.slice(0, -1));
    else setNewPinConferma(p => p.slice(0, -1));
  }
  async function handleChangePinNext() {
    if (changePinStep === "new") {
      if (newPin.length < 6) return setChangePinErrore("Il PIN deve essere di almeno 6 cifre");
      setChangePinErrore("");
      setChangePinStep("confirm");
    } else {
      if (newPin !== newPinConferma) {
        setChangePinErrore("I PIN non coincidono");
        setNewPinConferma("");
        return;
      }
      setChangePinLoading(true);
      setChangePinErrore("");
      try {
        await changePin(newPin);
        onLogin();
      } catch (err) {
        setChangePinErrore(err.message || "Errore aggiornamento PIN");
        setNewPin(""); setNewPinConferma(""); setChangePinStep("new");
      } finally {
        setChangePinLoading(false);
      }
    }
  }

  // Auto-submit when PIN reaches PIN_LEN digits
  const submitRef = useRef(null);
  submitRef.current = async (p) => {
    setLoginLoading(true); setLoginErrore(""); setLoginFromCache(false); setLoginSubtitle("");

    // Show "server waking up" hint after 4s if still loading
    const hintTimer = setTimeout(() => {
      setLoginSubtitle("Server in avvio, attendere...");
    }, 4000);

    try {
      const result = await login(p);
      if (result._fromCache) setLoginFromCache(true);
      if (result.requiresPinChange) {
        setMode("change-pin");
      } else {
        onLogin();
      }
    }
    catch (err) {
      setLoginErrore(err.message || "PIN non valido");
      setPinShake(true);
      setTimeout(() => { setPinShake(false); setPin(""); }, 450);
    }
    finally {
      clearTimeout(hintTimer);
      setLoginSubtitle("");
      setLoginLoading(false);
    }
  };

  useEffect(() => {
    if (pin.length === PIN_LEN && !loginLoading) {
      submitRef.current(pin);
    }
  }, [pin]);

  function onDigit(d) {
    if (loginLoading) return;
    setPin(p => p.length < 8 ? p + d : p);
    setLoginErrore("");
  }
  function onDelete() {
    setPin(p => p.slice(0, -1));
    setLoginErrore("");
  }

  async function handleRegister() {
    setRegErrore("");
    const personeValide = regPersone.filter(p => p.nome.trim());
    if (!regNome.trim()) return setRegErrore("Inserisci il nome del gruppo");
    if (personeValide.length === 0) return setRegErrore("Aggiungi almeno una persona");
    if (regPin.length < 6) return setRegErrore("Il PIN deve essere di almeno 6 cifre");
    if (regPin !== regPinConferma) return setRegErrore("I PIN non coincidono");
    setRegLoading(true);
    try {
      await register({ nome: regNome.trim(), persone: personeValide.map(p => ({ nome: p.nome.trim(), emoji: p.emoji })), pin: regPin });
      setRegSuccesso(true);
      setTimeout(() => onLogin(), 1200);
    } catch (err) {
      setRegErrore(err.message || "Errore durante la registrazione");
    } finally { setRegLoading(false); }
  }

  function addPersona() { if (regPersone.length < 6) setRegPersone(p => [...p, { nome: "", emoji: "🙂" }]); }
  function removePersona(i) { setRegPersone(p => p.filter((_, idx) => idx !== i)); setEmojiPickerIdx(null); }
  function updatePersonaNome(i, val) { setRegPersone(p => p.map((x, idx) => idx === i ? { ...x, nome: val } : x)); }
  function updatePersonaEmoji(i, emoji) { setRegPersone(p => p.map((x, idx) => idx === i ? { ...x, emoji } : x)); setEmojiPickerIdx(null); }

  const sBtn = { width: "100%", padding: "16px", border: "none", borderRadius: 16, fontFamily: "'DM Sans',sans-serif", fontSize: 16, fontWeight: 700, marginTop: 16, transition: "all 0.3s", cursor: "pointer" };
  const smallInput = { ...inputStyle, padding: "12px 14px", fontSize: 14, background: "#111119" };

  return (
    <div style={{ maxWidth: 430, margin: "0 auto", minHeight: "100vh", background: "#111119", color: "#eee", fontFamily: "'DM Sans',sans-serif", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <style>{`
        @keyframes pinShake {
          0%,100% { transform: translateX(0); }
          20% { transform: translateX(-8px); }
          40% { transform: translateX(8px); }
          60% { transform: translateX(-6px); }
          80% { transform: translateX(6px); }
        }
      `}</style>

      <div style={{ fontSize: 36, fontWeight: 800, marginBottom: 4 }}>
        <span style={{ background: "linear-gradient(135deg, #6C5CE7, #a855f7)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>Finanza</span>
      </div>
      <div style={{ fontSize: 11, color: "#555", letterSpacing: 2, marginBottom: 32 }}>TRACKER</div>

      {/* PIN change screen */}
      {mode === "change-pin" && (
        <div style={{ width: "100%", maxWidth: 300, textAlign: "center" }}>
          <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Aggiorna il PIN</div>
          <div style={{ fontSize: 13, color: "#888", marginBottom: 24 }}>
            {changePinStep === "new" ? "Scegli un nuovo PIN (minimo 6 cifre)" : "Conferma il nuovo PIN"}
          </div>
          <PinDots value={changePinStep === "new" ? newPin : newPinConferma} maxLen={8} shake={false} />
          {changePinErrore && <div style={{ color: "#FF6B6B", fontSize: 13, marginTop: 8 }}>{changePinErrore}</div>}
          <div style={{ marginTop: 16 }}>
            <NumPad onDigit={handleChangePinDigit} onDelete={handleChangePinDelete} disabled={changePinLoading} />
          </div>
          {(changePinStep === "new" ? newPin.length >= 6 : newPinConferma.length >= 6) && (
            <button onClick={handleChangePinNext} disabled={changePinLoading} style={{
              marginTop: 16, width: "100%", padding: "14px", border: "none", borderRadius: 12,
              background: "linear-gradient(135deg, #6C5CE7, #a855f7)", color: "#fff",
              fontFamily: "'DM Sans',sans-serif", fontSize: 15, fontWeight: 700, cursor: "pointer",
            }}>{changePinStep === "new" ? "Avanti" : (changePinLoading ? "Salvataggio..." : "Salva PIN")}</button>
          )}
        </div>
      )}

      {/* Mode toggle — hidden during PIN change */}
      {mode !== "change-pin" && <div style={{ display: "flex", background: "#1a1a28", borderRadius: 12, padding: 4, marginBottom: 28, width: "100%", maxWidth: 300 }}>
        {[["login", "Accedi"], ["register", "Crea account"]].map(([m, label]) => (
          <button key={m} onClick={() => { setMode(m); setLoginErrore(""); setRegErrore(""); setPin(""); }} style={{
            flex: 1, padding: "10px", border: "none", borderRadius: 9, cursor: "pointer",
            fontFamily: "'DM Sans',sans-serif", fontSize: 13, fontWeight: 700,
            background: mode === m ? "linear-gradient(135deg, #6C5CE7, #a855f7)" : "transparent",
            color: mode === m ? "#fff" : "#666", transition: "all 0.2s",
          }}>{label}</button>
        ))}
      </div>}

      {mode !== "change-pin" && <div style={{ width: "100%", maxWidth: 300 }}>

        {mode === "login" ? (
          <>
            <div style={{ textAlign: "center", color: "#888", fontSize: 12, letterSpacing: 1, textTransform: "uppercase" }}>
              {loginLoading ? "Accesso in corso..." : "Inserisci il PIN"}
            </div>
            {loginSubtitle && (
              <div style={{ textAlign: "center", color: "#6C5CE7", fontSize: 11, marginTop: 4, letterSpacing: 0.3 }}>
                {loginSubtitle}
              </div>
            )}

            <PinDots value={pin} maxLen={PIN_LEN} shake={pinShake} />

            {loginErrore && (
              <div style={{ textAlign: "center", color: "#FF6B6B", fontSize: 13, fontWeight: 600, marginBottom: 16 }}>
                {loginErrore}
              </div>
            )}

            <NumPad onDigit={onDigit} onDelete={onDelete} disabled={loginLoading} />

            {/* Show Accedi for legacy 4-5 digit PINs and for 7-8 digit PINs */}
            {(pin.length >= 4 && pin.length < PIN_LEN || pin.length > PIN_LEN) && (
              <button
                onClick={() => submitRef.current(pin)}
                disabled={loginLoading}
                style={{ ...sBtn, marginTop: 20, background: "linear-gradient(135deg, #6C5CE7, #a855f7)", color: "#fff", opacity: loginLoading ? 0.6 : 1 }}
              >
                {loginLoading ? "Accesso..." : "Accedi"}
              </button>
            )}
          </>
        ) : regSuccesso ? (
          <div style={{ textAlign: "center", padding: 20 }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>🎉</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: "#4ECDC4" }}>Account creato!</div>
            <div style={{ fontSize: 13, color: "#888", marginTop: 6 }}>Accesso in corso...</div>
          </div>
        ) : (
          <>
            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>Nome del gruppo</label>
              <input type="text" value={regNome} onChange={e => setRegNome(e.target.value)} placeholder="Es: Laura & Marco"
                style={smallInput} autoFocus />
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>Persone</label>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {regPersone.map((p, i) => (
                  <div key={i}>
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      {/* Emoji button */}
                      <button
                        onClick={() => setEmojiPickerIdx(emojiPickerIdx === i ? null : i)}
                        style={{
                          flexShrink: 0, width: 44, height: 44, border: "1px solid #252538",
                          borderRadius: 10, background: emojiPickerIdx === i ? "#252538" : "#1a1a28",
                          cursor: "pointer", fontSize: 22, display: "flex", alignItems: "center", justifyContent: "center",
                          transition: "background 0.15s",
                        }}
                      >{p.emoji}</button>
                      <input type="text" value={p.nome} onChange={e => updatePersonaNome(i, e.target.value)}
                        placeholder={`Persona ${i + 1}`} style={{ ...smallInput, flex: 1 }} />
                      {regPersone.length > 1 && (
                        <button onClick={() => removePersona(i)} style={{ background: "none", border: "1px solid #333", borderRadius: 8, color: "#888", cursor: "pointer", padding: "8px 10px", fontSize: 14, flexShrink: 0 }}>×</button>
                      )}
                    </div>
                    {/* Emoji picker panel */}
                    {emojiPickerIdx === i && (
                      <div style={{
                        marginTop: 6, padding: "10px 8px", background: "#1a1a28", borderRadius: 12,
                        border: "1px solid #252538", display: "flex", flexWrap: "wrap", gap: 4,
                      }}>
                        {["😀","😊","😎","🥰","🤩","😄","😁","🥳","😇","🤓","😏","😌","🧐","🤗","😜",
                          "👩","👨","🧑","👧","👦","👩‍💻","👨‍💻","👩‍🍳","👨‍🍳","👩‍🎨","👨‍🎨","👩‍🎤","👨‍🎤",
                          "🐶","🐱","🐼","🦊","🐨","🐯","🦁","🐻","🐸","🐙","🦋","🌸","⭐","🔥","💎",
                          "🚀","🎸","🎮","⚽","🏀","🎾","🏄","🧗","🎯","🎲","🏆","🎪"
                        ].map(e => (
                          <button key={e} onClick={() => updatePersonaEmoji(i, e)} style={{
                            background: p.emoji === e ? "#6C5CE722" : "none",
                            border: p.emoji === e ? "1px solid #6C5CE7" : "1px solid transparent",
                            borderRadius: 8, cursor: "pointer", fontSize: 20, padding: "4px 6px",
                            transition: "all 0.1s",
                          }}>{e}</button>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
                {regPersone.length < 6 && (
                  <button onClick={addPersona} style={{ background: "none", border: "1px dashed #333", borderRadius: 10, color: "#666", cursor: "pointer", padding: "10px", fontSize: 13, fontFamily: "'DM Sans',sans-serif" }}>+ Aggiungi persona</button>
                )}
              </div>
            </div>

            <div style={{ marginBottom: 10 }}>
              <label style={labelStyle}>PIN (4-8 cifre)</label>
              <input type="password" inputMode="numeric" maxLength={8} value={regPin}
                onChange={e => setRegPin(e.target.value.replace(/\D/g, ""))}
                placeholder="••••" style={{ ...smallInput, fontFamily: "'Space Mono',monospace", letterSpacing: 8, textAlign: "center" }} />
            </div>

            <div style={{ marginBottom: 6 }}>
              <label style={labelStyle}>Conferma PIN</label>
              <input type="password" inputMode="numeric" maxLength={8} value={regPinConferma}
                onChange={e => setRegPinConferma(e.target.value.replace(/\D/g, ""))}
                onKeyDown={e => e.key === "Enter" && handleRegister()}
                placeholder="••••" style={{
                  ...smallInput, fontFamily: "'Space Mono',monospace", letterSpacing: 8, textAlign: "center",
                  borderColor: regPinConferma && regPin !== regPinConferma ? "#FF6B6B" : "#252538",
                }} />
            </div>

            {regErrore && <div style={{ marginTop: 10, textAlign: "center", color: "#FF6B6B", fontSize: 13, fontWeight: 600 }}>{regErrore}</div>}

            <button onClick={handleRegister} disabled={regLoading} style={{
              ...sBtn, background: "linear-gradient(135deg, #6C5CE7, #a855f7)", color: "#fff", opacity: regLoading ? 0.6 : 1,
            }}>{regLoading ? "Creazione..." : "Crea account"}</button>
          </>
        )}
      </div>}
    </div>
  );
}

function ImpostazioniView({ householdName, householdId, persone, onDeleted, categorie, onCategorieChange }) {
  const [fase, setFase] = useState("idle"); // idle | confirm | pin | deleting | done
  const [pin, setPin] = useState("");
  const [errore, setErrore] = useState("");

  // Category editor state
  const [editingCatId, setEditingCatId] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [showNewCat, setShowNewCat] = useState(false);
  const [newCat, setNewCat] = useState({ emoji: "📦", nome: "", colore: "#A8A8A8" });

  function handleSaveEdit(id) {
    onCategorieChange(categorie.map(c => c.id === id ? { ...c, ...editForm } : c));
    setEditingCatId(null);
  }
  function handleDeleteCat(id) {
    onCategorieChange(categorie.filter(c => c.id !== id));
  }
  function handleAddCat() {
    if (!newCat.nome.trim()) return;
    const newId = newCat.nome.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "") + "_" + Date.now().toString(36);
    const without = categorie.filter(c => c.id !== "altro");
    const altro = categorie.find(c => c.id === "altro");
    const updated = [...without, { ...newCat, id: newId }, ...(altro ? [altro] : [])];
    onCategorieChange(updated);
    setShowNewCat(false);
    setNewCat({ emoji: "📦", nome: "", colore: "#A8A8A8" });
  }

  async function eseguiElimina() {
    if (!pin) return;
    setFase("deleting");
    setErrore("");
    try {
      await deleteHousehold(pin);
      setFase("done");
      setTimeout(() => onDeleted(), 1500);
    } catch (err) {
      setErrore(err.message || "Errore durante l'eliminazione");
      setFase("pin");
    }
  }

  return (
    <div style={{ padding: "20px 16px" }}>
      <div style={{ fontSize: 22, fontWeight: 800, color: "#eee", marginBottom: 4 }}>Account</div>
      <div style={{ fontSize: 13, color: "#888", marginBottom: 24 }}>Gestisci il tuo gruppo</div>

      {/* Household info card */}
      <div style={{ background: "#1a1a28", borderRadius: 16, padding: "16px", marginBottom: 24, border: "1px solid #252538" }}>
        <div style={{ fontSize: 11, color: "#555", letterSpacing: 1, marginBottom: 8, textTransform: "uppercase" }}>Gruppo attivo</div>
        <div style={{ fontSize: 18, fontWeight: 700, color: "#eee", marginBottom: 4 }}>{householdName}</div>
        {householdId && (
          <div style={{ fontSize: 11, color: "#555", fontFamily: "'Space Mono',monospace", marginBottom: 12 }}>ID: {householdId}</div>
        )}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {persone.map(p => (
            <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 6, background: "#252538", borderRadius: 20, padding: "6px 12px" }}>
              <span style={{ fontSize: 18 }}>{p.emoji}</span>
              <span style={{ fontSize: 13, color: "#ccc", fontWeight: 600 }}>{p.nome}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Category editor */}
      <div style={{ background: "#1a1a28", borderRadius: 16, padding: 16, marginBottom: 24, border: "1px solid #252538" }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: "#eee", marginBottom: 14 }}>Categorie uscite</div>
        {categorie.map(c => (
          <div key={c.id}>
            {editingCatId === c.id ? (
              <div style={{ padding: "10px 0", borderBottom: "1px solid #252538" }}>
                <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
                  <input value={editForm.emoji || c.emoji} onChange={e => setEditForm(f => ({ ...f, emoji: e.target.value }))}
                    style={{ ...inputStyle, width: 52, textAlign: "center", fontSize: 18, padding: "8px 4px" }} />
                  <input value={editForm.nome ?? c.nome} onChange={e => setEditForm(f => ({ ...f, nome: e.target.value }))}
                    placeholder="Nome categoria" style={{ ...inputStyle, flex: 1, padding: "8px 10px" }} />
                  <input type="color" value={editForm.colore || c.colore} onChange={e => setEditForm(f => ({ ...f, colore: e.target.value }))}
                    style={{ width: 36, height: 36, border: "none", background: "none", cursor: "pointer", padding: 2 }} />
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => setEditingCatId(null)} style={{ flex: 1, padding: "8px", border: "1px solid #252538", borderRadius: 10, background: "transparent", color: "#888", fontSize: 12, cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>Annulla</button>
                  <button onClick={() => handleSaveEdit(c.id)} style={{ flex: 1, padding: "8px", border: "none", borderRadius: 10, background: "#6C5CE7", color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>Salva</button>
                </div>
              </div>
            ) : (
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0", borderBottom: "1px solid #252538" }}>
                <span style={{ fontSize: 20 }}>{c.emoji}</span>
                <div style={{ width: 10, height: 10, borderRadius: "50%", background: c.colore, flexShrink: 0 }} />
                <span style={{ flex: 1, fontSize: 14, color: "#ccc", fontWeight: 600 }}>{c.nome}</span>
                <button onClick={() => { setEditingCatId(c.id); setEditForm({}); }} style={{ padding: "5px 8px", border: "1px solid #252538", borderRadius: 8, background: "transparent", color: "#888", fontSize: 11, cursor: "pointer" }}>Modifica</button>
                {categorie.length > 1 && (
                  <button onClick={() => handleDeleteCat(c.id)} style={{ padding: "5px 8px", border: "1px solid #FF6B6B33", borderRadius: 8, background: "transparent", color: "#FF6B6B", fontSize: 11, cursor: "pointer" }}>Elimina</button>
                )}
              </div>
            )}
          </div>
        ))}
        {showNewCat ? (
          <div style={{ paddingTop: 12 }}>
            <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
              <input value={newCat.emoji} onChange={e => setNewCat(n => ({ ...n, emoji: e.target.value }))}
                style={{ ...inputStyle, width: 52, textAlign: "center", fontSize: 18, padding: "8px 4px" }} />
              <input value={newCat.nome} onChange={e => setNewCat(n => ({ ...n, nome: e.target.value }))}
                placeholder="Nome categoria" style={{ ...inputStyle, flex: 1, padding: "8px 10px" }} autoFocus />
              <input type="color" value={newCat.colore} onChange={e => setNewCat(n => ({ ...n, colore: e.target.value }))}
                style={{ width: 36, height: 36, border: "none", background: "none", cursor: "pointer", padding: 2 }} />
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => { setShowNewCat(false); setNewCat({ emoji: "📦", nome: "", colore: "#A8A8A8" }); }} style={{ flex: 1, padding: "8px", border: "1px solid #252538", borderRadius: 10, background: "transparent", color: "#888", fontSize: 12, cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>Annulla</button>
              <button onClick={handleAddCat} disabled={!newCat.nome.trim()} style={{ flex: 1, padding: "8px", border: "none", borderRadius: 10, background: newCat.nome.trim() ? "#6C5CE7" : "#252538", color: newCat.nome.trim() ? "#fff" : "#555", fontSize: 12, fontWeight: 700, cursor: newCat.nome.trim() ? "pointer" : "default", fontFamily: "'DM Sans',sans-serif" }}>Aggiungi</button>
            </div>
          </div>
        ) : (
          <button onClick={() => setShowNewCat(true)} style={{ marginTop: 12, width: "100%", padding: "10px", border: "1px dashed #252538", borderRadius: 10, background: "transparent", color: "#666", fontSize: 13, cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>
            + Nuova categoria
          </button>
        )}
      </div>

      {/* Delete section */}
      <div style={{ background: "#1a1a28", borderRadius: 16, padding: 16, border: "1px solid #2a1a1a" }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: "#FF6B6B", marginBottom: 6 }}>Zona pericolosa</div>
        <div style={{ fontSize: 12, color: "#888", marginBottom: 16, lineHeight: 1.5 }}>
          Elimina definitivamente l'account e tutte le transazioni. Questa azione non può essere annullata.
        </div>

        {fase === "idle" && (
          <button onClick={() => setFase("confirm")} style={{
            width: "100%", padding: "13px", border: "1px solid #FF6B6B33", borderRadius: 12,
            background: "transparent", color: "#FF6B6B", fontFamily: "'DM Sans',sans-serif",
            fontSize: 14, fontWeight: 700, cursor: "pointer",
          }}>
            Elimina account
          </button>
        )}

        {fase === "confirm" && (
          <div>
            <div style={{ fontSize: 13, color: "#FFD93D", marginBottom: 14, textAlign: "center", lineHeight: 1.5 }}>
              ⚠️ Sicuro? Verranno eliminate tutte le transazioni e i dati del gruppo <strong style={{ color: "#eee" }}>{householdName}</strong>.
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={() => setFase("idle")} style={{
                flex: 1, padding: "12px", border: "1px solid #252538", borderRadius: 12,
                background: "transparent", color: "#888", fontFamily: "'DM Sans',sans-serif",
                fontSize: 14, fontWeight: 600, cursor: "pointer",
              }}>Annulla</button>
              <button onClick={() => setFase("pin")} style={{
                flex: 1, padding: "12px", border: "none", borderRadius: 12,
                background: "#FF6B6B22", color: "#FF6B6B", fontFamily: "'DM Sans',sans-serif",
                fontSize: 14, fontWeight: 700, cursor: "pointer",
              }}>Continua</button>
            </div>
          </div>
        )}

        {(fase === "pin" || fase === "deleting") && (
          <div>
            <div style={{ fontSize: 13, color: "#aaa", marginBottom: 10, textAlign: "center" }}>
              Inserisci il PIN per confermare l'eliminazione
            </div>
            <input
              type="password" inputMode="numeric" maxLength={8}
              value={pin} onChange={e => { setPin(e.target.value.replace(/\D/g, "")); setErrore(""); }}
              onKeyDown={e => e.key === "Enter" && eseguiElimina()}
              placeholder="••••"
              autoFocus
              style={{
                ...inputStyle, fontSize: 28, fontWeight: 800,
                fontFamily: "'Space Mono',monospace", textAlign: "center",
                letterSpacing: 10, marginBottom: 10,
                borderColor: errore ? "#FF6B6B" : "#252538",
              }}
            />
            {errore && <div style={{ color: "#FF6B6B", fontSize: 12, textAlign: "center", marginBottom: 10 }}>{errore}</div>}
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={() => { setFase("idle"); setPin(""); setErrore(""); }} style={{
                flex: 1, padding: "12px", border: "1px solid #252538", borderRadius: 12,
                background: "transparent", color: "#888", fontFamily: "'DM Sans',sans-serif",
                fontSize: 14, fontWeight: 600, cursor: "pointer",
              }}>Annulla</button>
              <button onClick={eseguiElimina} disabled={pin.length < 4 || fase === "deleting"} style={{
                flex: 1, padding: "12px", border: "none", borderRadius: 12,
                background: pin.length >= 4 ? "#FF6B6B" : "#2a1a1a",
                color: pin.length >= 4 ? "#fff" : "#555",
                fontFamily: "'DM Sans',sans-serif", fontSize: 14, fontWeight: 700,
                cursor: pin.length >= 4 ? "pointer" : "default",
                opacity: fase === "deleting" ? 0.6 : 1,
              }}>
                {fase === "deleting" ? "Eliminazione..." : "Elimina"}
              </button>
            </div>
          </div>
        )}

        {fase === "done" && (
          <div style={{ textAlign: "center", padding: "10px 0" }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>🗑️</div>
            <div style={{ color: "#4ECDC4", fontWeight: 700 }}>Account eliminato</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main App ───
export default function FinanzaApp() {
  const [authed, setAuthed] = useState(isLoggedIn() && !getSession()?.requiresPinChange);
  const urlParams = new URLSearchParams(window.location.search);
  const [tab, setTab] = useState(urlParams.get("action") === "add" ? "aggiungi" : "home");
  const [initialTipo, setInitialTipo] = useState(urlParams.get("tipo") || "uscita");
  const [initialImporto, setInitialImporto] = useState(urlParams.get("importo") || "");
  const [initialDescrizione, setInitialDescrizione] = useState(urlParams.get("descrizione") || "");
  const [initialCategoria, setInitialCategoria] = useState(urlParams.get("categoria") || "");
  const [initialPagatoDa, setInitialPagatoDa] = useState(urlParams.get("pagatoDa") || "");
  const [shortcutKey, setShortcutKey] = useState(0);
  const [transazioni, setTransazioni] = useState([]);
  const [goals, setGoals] = useState([]);
  const [positions, setPositions] = useState([]);
  const [meseOffset, setMeseOffset] = useState(0);
  const [categorieUscita, setCategorieUscita] = useState(() => getCategorieUscita() || CATEGORIE.filter(c => c.id !== "entrata"));

  // Warm up Render server on app open (fire and forget)
  useEffect(() => { wakeupServer(); }, []);

  // Any 401/403 from the server forces re-auth — catches PIN_CHANGE_REQUIRED state mismatch
  // (old cached session bypasses frontend check but server still enforces it)
  useEffect(() => {
    setAuthErrorHandler(() => setAuthed(false));
    return () => setAuthErrorHandler(null);
  }, []);

  // Shared deep-link handler — used by both URL params and webapp:// scheme.
  // Shortcut: webapp://?action=add&tipo=uscita&importo=12.50&descrizione=Merchant&categoria=cibo&pagatoDa=Gabriele
  const applyDeepLink = useCallback((queryString) => {
    const p = new URLSearchParams(queryString);
    if (p.get("action") !== "add") return false;
    setInitialTipo(p.get("tipo") || "uscita");
    setInitialImporto(p.get("importo") || "");
    setInitialDescrizione(p.get("descrizione") || "");
    setInitialCategoria(p.get("categoria") || "");
    setInitialPagatoDa(p.get("pagatoDa") || "");
    setShortcutKey(k => k + 1);
    setTab("aggiungi");
    return true;
  }, []);

  // webapp:// scheme — fires when Capacitor app is opened via custom URL scheme.
  useEffect(() => {
    let listener;
    CapApp.addListener("appUrlOpen", (event) => {
      const qs = event.url.includes("?") ? event.url.split("?")[1] : "";
      applyDeepLink(qs);
    }).then(l => { listener = l; }).catch(() => {});
    return () => { listener?.remove(); };
  }, [applyDeepLink]);

  // https:// URL params — works on web/PWA and on fresh Capacitor load.
  useEffect(() => {
    function checkUrlParams() {
      const qs = window.location.search.slice(1);
      if (!qs) return;
      if (applyDeepLink(qs)) window.history.replaceState({}, "", window.location.pathname);
    }
    checkUrlParams();
    const handleVisibility = () => { if (document.visibilityState === "visible") checkUrlParams(); };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [applyDeepLink]);

  const persone = getPersone().length > 0 ? getPersone() : DEFAULT_PERSONE;
  const householdName = getHouseholdName();

  // ─── Auto-generate due recurring transactions ───
  const generaRicorrenti = useCallback(async (txList) => {
    const oggi = new Date().toISOString().slice(0, 10);
    const dovute = txList.filter(t =>
      t.ricorrenza?.frequenza && t.ricorrenza?.prossimaData && t.ricorrenza.prossimaData <= oggi
    );
    if (dovute.length === 0) return;
    const nuove = [];
    for (const t of dovute) {
      const nuovaTx = {
        ...t,
        id: generaId(),
        data: t.ricorrenza.prossimaData,
        ricorrenza: {
          frequenza: t.ricorrenza.frequenza,
          prossimaData: calcolaProssimaData(t.ricorrenza.prossimaData, t.ricorrenza.frequenza),
        },
      };
      delete nuovaTx._id;
      try {
        const saved = await addTransaction(nuovaTx);
        nuove.push(saved);
      } catch (e) { console.error("Ricorrente error:", e); }
    }
    if (nuove.length > 0) {
      setTransazioni(prev => [...prev, ...nuove]);
    }
  }, []);

  const loadAll = useCallback(async () => {
    try {
      const localData = await fetchTransactions((serverData) => {
        setTransazioni(serverData);
        generaRicorrenti(serverData);
      });
      setTransazioni(localData);
      generaRicorrenti(localData);
    } catch (err) {
      if (err.message === "Sessione scaduta") { setAuthed(false); return; }
      console.error("Load error:", err);
    }
  }, [generaRicorrenti]);

  const loadPositions = useCallback(async () => {
    try {
      const data = await fetchPositions();
      setPositions(data);
    } catch (e) { console.error("loadPositions:", e); }
  }, []);

  const loadGoals = useCallback(async () => {
    try {
      const data = await fetchGoals();
      setGoals(data || []);
    } catch (e) { console.error("loadGoals:", e); }
  }, []);

  const handleAddGoal = async (goal) => {
    const saved = await addGoal(goal);
    setGoals(prev => [...prev, saved]);
  };

  const handleUpdateGoal = async (id, updates) => {
    await updateGoal(id, updates);
    setGoals(prev => prev.map(g => g.id === id ? { ...g, ...updates } : g));
  };

  const handleDeleteGoal = async (id) => {
    await deleteGoal(id);
    setGoals(prev => prev.filter(g => g.id !== id));
  };

  const loadCategorie = useCallback(async () => {
    const defaults = CATEGORIE.filter(c => c.id !== "entrata");
    try {
      const cats = await fetchCategorie();
      setCategorieUscita(cats || defaults);
    } catch (e) { console.error("loadCategorie:", e); setCategorieUscita(defaults); }
  }, []);

  useEffect(() => { if (authed) { loadAll(); loadPositions(); loadCategorie(); loadGoals(); } }, [authed, loadAll, loadPositions, loadCategorie, loadGoals]);

  function handleLogin() {
    setAuthed(true);
    loadAll();
    loadPositions();
    loadCategorie();
  }
  function handleLogout() {
    logout();
    setAuthed(false);
    setTransazioni([]);
    setPositions([]);
    setCategorieUscita(CATEGORIE.filter(c => c.id !== "entrata"));
    setTab("home");
  }

  async function aggiungiTransazione(t) {
    try {
      const saved = await addTransaction(t);
      setTransazioni(prev => [...prev, saved]);
      
      // Auto-apply goal contributions on entrata
      if (t.tipo === "entrata" && goals?.length > 0) {
        const activeGoals = goals.filter(g => g.autoAdd && (g.contributionType === "percent" || g.contributionType === "fixed"));
        for (const g of activeGoals) {
          let contribution = 0;
          if (g.contributionType === "percent") {
            contribution = t.importo * (g.contributionValue / 100);
          } else if (g.contributionType === "fixed") {
            contribution = g.contributionValue;
          }
          if (contribution > 0) {
            const newAmount = (g.currentAmount || 0) + contribution;
            await updateGoal(g.id, { currentAmount: newAmount });
            setGoals(prev => prev.map(goal => goal.id === g.id ? { ...goal, currentAmount: newAmount } : goal));
          }
        }
      }
      
      setTab("home");
    } catch (err) { console.error("Add error:", err); }
  }

  // Same but without setTab — used by bulk import
  async function aggiungiTransazioneSilente(t) {
    const saved = await addTransaction(t);
    setTransazioni(prev => [...prev, saved]);
    return saved;
  }

  async function aggiungiSaldo(t) {
    try {
      const saved = await addTransaction(t);
      setTransazioni(prev => [...prev, saved]);
    } catch (err) { console.error("Saldo error:", err); }
  }

  async function aggiungiPositioneSilente(pos) {
    const saved = await addPosition(pos);
    setPositions(prev => [...prev, saved]);
    return saved;
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

  const showMonthBar = tab === "home" || tab === "stats";

  return (
    <div style={{ maxWidth: 430, margin: "0 auto", height: "100dvh", background: "#111119", color: "#eee", fontFamily: "'DM Sans', sans-serif", display: "flex", flexDirection: "column", overflow: "hidden", position: "relative" }}>
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
      <div style={{ flex: 1, overflowY: "auto", paddingBottom: "calc(48px + env(safe-area-inset-bottom, 0px))" }}>
        {tab === "home" && <HomeView transazioni={transazioni} onDelete={eliminaTransazione} onEdit={modificaTransazione} onSettle={aggiungiSaldo} persone={persone} meseOffset={meseOffset} categorie={categorieUscita} goals={goals} onAddGoal={handleAddGoal} onUpdateGoal={handleUpdateGoal} onDeleteGoal={handleDeleteGoal} />}
        {tab === "aggiungi" && <AggiungiView key={shortcutKey} onAggiungi={aggiungiTransazione} persone={persone} transazioni={transazioni} categorie={categorieUscita} initialTipo={initialTipo} initialImporto={initialImporto} initialDescrizione={initialDescrizione} initialCategoria={initialCategoria} initialPagatoDa={initialPagatoDa} />}
        {tab === "stats" && <StatsView transazioni={transazioni} persone={persone} meseOffset={meseOffset} categorie={categorieUscita} goals={goals} />}
        {tab === "export" && <ExportView transazioni={transazioni} persone={persone} positions={positions} onImport={aggiungiTransazioneSilente} onImportComplete={loadAll} onImportPosition={aggiungiPositioneSilente} onImportPositionComplete={loadPositions} />}
        {tab === "portfolio" && <PortfolioView />}
        {tab === "impostazioni" && (
          <ImpostazioniView
            householdName={householdName}
            householdId={getSession()?.householdId}
            persone={persone}
            onDeleted={() => { logout(); setAuthed(false); setTransazioni([]); setTab("home"); }}
            categorie={categorieUscita}
            onCategorieChange={(cats) => { setCategorieUscita(cats); saveCategorie(cats); }}
          />
        )}
      </div>
      <TabBar tab={tab} setTab={setTab} householdId={getSession()?.householdId} />
    </div>
  );
}
