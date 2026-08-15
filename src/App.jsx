import { useState, useEffect, useCallback, useRef } from "react";
import { App as CapApp } from "@capacitor/app";
import { Camera } from "@capacitor/camera";
import Tesseract from "tesseract.js";
import { fetchTransactions, addTransaction, deleteTransaction, updateTransaction, isAPIConnected, login, logout, register, changePin, isLoggedIn, getSession, getPersone, getHouseholdName, fetchPositions, addPosition, deletePosition, fetchManualPrices, saveManualPricesRemote, wakeupServer, deleteHousehold, getCategorieUscita, fetchCategorie, saveCategorie, setAuthErrorHandler, fetchGoals, addGoal, updateGoal, deleteGoal, fetchTrips, addTrip, updateTrip, deleteTrip, addTripExpense, deleteTripExpense, fetchAccounts, addAccount, updateAccount, deleteAccount, downloadBackup, restoreBackup, fetchTripCategories, saveTripCategories, createWidgetKey, revokeWidgetKey, createCalendarKey, revokeCalendarKey, getApiBase, requestPinReset, confirmPinReset, setRecoveryEmail, fetchHousehold, fetchTrash, restoreTransaction, permanentDeleteTransaction, emptyTrash, createTripShareLink, revokeTripShareLink, fetchSharedTrip, joinSharedTrip, addSharedTripExpense, updateValutaBase, fetchExchangeRates } from "./api.js";
import { calcolaDebitiMatrix, calcolaSaldiConti, calcolaValorePortfolio, calcolaSettleViaggio, filtraTransazioni, contaFiltriAttivi } from "./lib/finance.js";
import { LANGUAGES, getLang, setLang, t, mese, detectGuestLang } from "./lib/i18n.js";
import { toast, ToastHost } from "./components/Toast.jsx";

// Default categories, seeded client-side only until a household customizes
// them (nothing is written server-side until then — see loadCategorie).
// nome is translated by id; ids/emoji/colore stay fixed so stored transaction
// data and custom-category edits are never affected by the display language.
const CATEGORIE_BASE = [
  { id: "cibo", emoji: "🍕", colore: "#FF6B6B" },
  { id: "trasporti", emoji: "🚗", colore: "#4ECDC4" },
  { id: "casa", emoji: "🏠", colore: "#45B7D1" },
  { id: "salute", emoji: "💊", colore: "#96CEB4" },
  { id: "svago", emoji: "🎮", colore: "#FFEAA7" },
  { id: "shopping", emoji: "🛍️", colore: "#DDA0DD" },
  { id: "bollette", emoji: "💡", colore: "#F0A500" },
  { id: "altro", emoji: "📦", colore: "#A8A8A8" },
  { id: "entrata", emoji: "💰", colore: "#4ECDC4" },
];
function defaultCategorie(lang) {
  return CATEGORIE_BASE.map(c => ({ ...c, nome: t(lang, `cat.${c.id}`) }));
}

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

function generaId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
// Privacy mode: when active, every currency amount renders as dots.
// Module-level flag read by formattaValuta (used in 100+ places); the root
// component keeps it in sync with React state so a toggle re-renders everything.
let importiNascosti = false;
// For compact custom-formatted amounts (chart labels etc.)
function importoOscurabile(str) { return importiNascosti ? "••••" : str; }
function formattaValuta(n) {
  if (importiNascosti) return "€ ••••";
  return new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" }).format(n);
}
function formattaData(d) { return new Date(d).toLocaleDateString("it-IT", { day: "numeric", month: "short" }); }
function evalImporto(val) {
  if (!val) return 0;
  // Replace Italian comma with dot, allow both , and . in input
  const s = String(val).replace(/,/g, ".");
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

function SplitSelector({ pagatoDa, setPagatoDa, splits, setSplits, persone, importo, extraPersone, setExtraPersone, lang = "it" }) {
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

// ─── Receipt Scanner ───
function ReceiptScanner({ onScanComplete }) {
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [previewUrl, setPreviewUrl] = useState(null);
  const fileInputRef = useRef(null);

  async function processImage(imageData) {
    setPreviewUrl(imageData);
    setScanning(true);
    setProgress(10);

    const result = await Tesseract.recognize(imageData, "eng+ita", {
      logger: (m) => {
        if (m.status === "recognizing text") {
          setProgress(Math.round(m.progress * 80) + 10);
        }
      },
    });

    setProgress(90);
    const text = result.data.text;
    const parsed = parseReceiptText(text);

    setProgress(100);
    setTimeout(() => {
      setScanning(false);
      setPreviewUrl(null);
      onScanComplete(parsed);
    }, 500);
  }

  async function captureAndScan() {
    try {
      let imageData;

      try {
        const permission = await Camera.requestPermissions();
        if (permission.camera) {
          const photo = await Camera.getPhoto({
            quality: 80,
            allowEditing: false,
            resultType: "base64",
          });
          if (photo.base64String) {
            imageData = `data:image/jpeg;base64,${photo.base64String}`;
          }
        }
      } catch (e) {
        // Camera not available, fall through to file input
      }

      if (!imageData) {
        fileInputRef.current?.click();
        return;
      }

      await processImage(imageData);
    } catch (e) {
      console.error("Scan error:", e);
    }
  }

  function handleFileSelect(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (ev) => {
      await processImage(ev.target.result);
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  }

  function parseReceiptText(text) {
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const result = { importo: null, descrizione: "", categoria: "" };

    const totalPatterns = [
      /(?:totale|total|amount|sum)[\s:]*[\€\$]?\s*([\d.,]+)/i,
      /(?:€\s*|EUR\s*)\s*([\d.,]+)/i,
      /^[\€\$]?\s*([\d.,]+)\s*$/m,
      /(?:sub\s*total|subtotale)[\s:]*[\€\$]?\s*([\d.,]+)/i,
      /([\d.,]+)\s*[\€\$]\s*$/m,
    ];

    for (const line of lines.reverse()) {
      for (const pat of totalPatterns) {
        const match = line.match(pat);
        if (match) {
          const val = parseFloat(match[1].replace(",", "."));
          if (val > 0 && val < 10000) {
            result.importo = val;
            break;
          }
        }
      }
      if (result.importo) break;
    }

    if (!result.importo) {
      const moneyMatch = text.match(/[\€\$]\s*([\d.,]{2,})/);
      if (moneyMatch) {
        const val = parseFloat(moneyMatch[1].replace(",", "."));
        if (val > 0 && val < 10000) result.importo = val;
      }
    }

    if (lines.length > 0) {
      const firstLine = lines[0];
      if (firstLine.length > 2 && firstLine.length < 50) {
        result.descrizione = firstLine;
      }
    }

    const lowerText = text.toLowerCase();
    const categoryKeywords = {
      cibo: ["panino", "pizza", "caffè", "bar", "ristorante", "supermercato", "coop", "carrefour", "esselunga", "md", "lidl", "conad", "bio", "food", "pasta", "frutta"],
      trasporti: ["benzina", "gasolio", "enel", "energia", "elettrico", "carburante", "q8", "eni", "tamoil", "api", "shell", "totalerg", "bus", "treno", "trenitalia"],
      casa: ["enel", "acea", "vodafone", "tim", "wind", "fastweb", "internet", "luce", "gas", "acqua", "condominio"],
      salute: ["farmacia", "medico", "ospedale", "clinica", "analisi", "laboratorio", "dentista", "visita"],
      svago: ["cinema", "teatro", "concert", "game", "playstation", "xbox", "steam", "netflix", "spotify", "abbonamento"],
      shopping: ["amazon", "ebay", "zalando", "nike", "adidas", "zara", "h&m", "outlet"],
      bollette: ["bolletta", "fattura", "pagamento", "rimborso"],
    };

    for (const [catId, keywords] of Object.entries(categoryKeywords)) {
      for (const kw of keywords) {
        if (lowerText.includes(kw)) {
          result.categoria = catId;
          break;
        }
      }
      if (result.categoria) break;
    }

    return result;
  }

  return (
    <div>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={handleFileSelect}
        style={{ display: "none" }}
      />
      {!scanning && !previewUrl && (
        <button onClick={captureAndScan} style={{
          width: "100%", padding: "14px", border: "2px dashed #6C5CE755",
          borderRadius: 14, cursor: "pointer", background: "#1a1a28",
          color: "#a78bfa", fontSize: 14, fontWeight: 700, fontFamily: "'DM Sans',sans-serif",
          display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
        }}>
          <span style={{ fontSize: 18 }}>📷</span>
          Scansiona scontrino
        </button>
      )}
      {scanning && (
        <div style={{ padding: 20, background: "#1a1a28", borderRadius: 14, textAlign: "center" }}>
          <div style={{ fontSize: 24, marginBottom: 10 }}>🔍</div>
          <div style={{ fontSize: 14, color: "#a78bfa", marginBottom: 8, fontFamily: "'DM Sans',sans-serif" }}>Analisi scontrino...</div>
          <div style={{ height: 4, background: "#252538", borderRadius: 2, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${progress}%`, background: "linear-gradient(90deg, #6C5CE7, #a78bfa)", borderRadius: 2, transition: "width 0.3s" }} />
          </div>
          <div style={{ fontSize: 11, color: "#666", marginTop: 6, fontFamily: "'DM Sans',sans-serif" }}>{progress}%</div>
        </div>
      )}
      {previewUrl && !scanning && (
        <div style={{ marginBottom: 16 }}>
          <img src={previewUrl} alt="Receipt" style={{ width: "100%", borderRadius: 12, opacity: 0.7 }} />
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
  const nomeMese = mese(meseVis.getMonth()) + " " + meseVis.getFullYear();
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
function TabBar({ tab, setTab, householdId, lang = "it" }) {
  const baseTabs = [
    { id: "home", label: t(lang, "nav.home"), icon: "⌂" },
    { id: "aggiungi", label: t(lang, "nav.aggiungi"), icon: "+" },
    { id: "portfolio", label: t(lang, "nav.portfolio"), icon: "📈" },
    { id: "viaggi", label: t(lang, "nav.viaggi"), icon: "✈" },
    { id: "stats", label: t(lang, "nav.stats"), icon: "◔" },
    { id: "export", label: t(lang, "nav.export"), icon: "↓" },
  ];
  const tabs = baseTabs;

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
    viaggi: (active) => (
      <svg width="22" height="22" viewBox="0 0 100 100" fill="none">
        <path d="M50 2C52 2 54 4 55 8L58 28L84 42C88 44 90 47 90 50C90 53 88 54 84 53L58 48L56 62L68 68C70 69 71 71 71 73C71 75 70 76 68 75L55 71L52 82C51 86 50 88 50 88C50 88 49 86 48 82L45 71L32 75C30 76 29 75 29 73C29 71 30 69 32 68L44 62L42 48L16 53C12 54 10 53 10 50C10 47 12 44 16 42L42 28L45 8C46 4 48 2 50 2Z" fill={active ? "#a78bfa" : "#94a3b8"} />
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
function GoalRow({ goal, onUpdate, onDelete, conti = [], lang = "it" }) {
  const [mode, setMode] = useState(null); // null | "versa" | "edit"
  const [amount, setAmount] = useState("");
  const [eNome, setENome] = useState(goal.nome);
  const [eTarget, setETarget] = useState(String(goal.targetAmount || ""));
  const [eDate, setEDate] = useState(goal.targetDate || "");
  const [eCurrent, setECurrent] = useState(String(goal.currentAmount || 0));
  const [eCType, setECType] = useState(goal.contributionType || "manual");
  const [eCValue, setECValue] = useState(goal.contributionValue ? String(goal.contributionValue) : "");
  const [eAuto, setEAuto] = useState(goal.autoAdd === true);
  const [eConto, setEConto] = useState(goal.contoId || "");
  const conto = conti.find(c => c.id === goal.contoId);

  const current = goal.currentAmount || 0;
  const pct = goal.targetAmount > 0 ? (current / goal.targetAmount * 100) : 0;
  const done = goal.targetAmount > 0 && current >= goal.targetAmount;
  const daysLeft = goal.targetDate ? Math.ceil((new Date(goal.targetDate) - new Date()) / (1000*60*60*24)) : null;
  // Monthly pace needed to hit the target by the date
  const mesiRimasti = daysLeft !== null && daysLeft > 0 ? daysLeft / 30.44 : null;
  const alMese = !done && mesiRimasti ? (goal.targetAmount - current) / mesiRimasti : null;
  const isAuto = goal.autoAdd && goal.contributionType !== "manual" && goal.contributionValue > 0;

  function openEdit() {
    setENome(goal.nome); setETarget(String(goal.targetAmount || ""));
    setEDate(goal.targetDate || ""); setECurrent(String(current));
    setECType(goal.contributionType || "manual");
    setECValue(goal.contributionValue ? String(goal.contributionValue) : "");
    setEAuto(goal.autoAdd === true);
    setEConto(goal.contoId || "");
    setMode(mode === "edit" ? null : "edit");
  }

  function handleVersa() {
    const val = parseFloat(amount.replace(",", "."));
    if (!isNaN(val) && val !== 0) {
      onUpdate(goal.id, { currentAmount: Math.max(0, Math.round((current + val) * 100) / 100) });
    }
    setAmount(""); setMode(null);
  }

  function handleSaveEdit() {
    const target = parseFloat(eTarget.replace(",", "."));
    const curr = parseFloat(eCurrent.replace(",", "."));
    if (!eNome.trim() || isNaN(target) || target <= 0) return;
    onUpdate(goal.id, {
      nome: eNome.trim(),
      targetAmount: target,
      targetDate: eDate || null,
      currentAmount: !isNaN(curr) && curr >= 0 ? curr : current,
      contributionType: eCType,
      contributionValue: eCType !== "manual" ? parseFloat(eCValue.replace(",", ".")) || 0 : 0,
      autoAdd: eAuto,
      contoId: eConto || null,
    });
    setMode(null);
  }

  return (
    <div style={{ background: "#111119", borderRadius: 12, padding: 12, border: mode ? "1px solid #6C5CE7" : done ? "1px solid #4ECDC455" : "1px solid #252538" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <GoalGauge current={current} target={goal.targetAmount} size={50} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: "#eee" }}>{goal.nome}</span>
            {done && <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4, background: "#4ECDC422", color: "#4ECDC4" }}>{t(lang, "goals.achieved")}</span>}
            {isAuto && !done && (
              <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4, background: "#6C5CE722", color: "#a78bfa" }}>
                {t(lang, "goals.auto")} {goal.contributionType === "percent" ? `${goal.contributionValue}%` : formattaValuta(goal.contributionValue)}
              </span>
            )}
            {conto && (
              <span style={{ fontSize: 9, fontWeight: 600, padding: "2px 6px", borderRadius: 4, background: "#252538", color: "#999" }}>
                {conto.icona} {conto.nome}
              </span>
            )}
          </div>
          <div style={{ fontSize: 11, color: "#888" }}>
            {formattaValuta(current)} / {formattaValuta(goal.targetAmount)} ({pct.toFixed(0)}%)
            {daysLeft !== null && !done && <span style={{ color: daysLeft < 0 ? "#FF6B6B" : "#666", marginLeft: 8 }}>{daysLeft < 0 ? `${t(lang, "goals.overdueBy")} ${Math.abs(daysLeft)}${t(lang, "goals.daysUnit")}` : `${daysLeft}${t(lang, "stats.daysLeft")}`}</span>}
          </div>
          {alMese !== null && alMese > 0 && (
            <div style={{ fontSize: 10, color: "#F0A500", marginTop: 2 }}>≈ {formattaValuta(alMese)}{t(lang, "goals.perMonthToReach")}</div>
          )}
        </div>
        <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
          {!done && <button onClick={() => { setAmount(""); setMode(mode === "versa" ? null : "versa"); }} title={t(lang, "goals.deposit")} style={{ background: mode === "versa" ? "#4ECDC422" : "none", border: mode === "versa" ? "1px solid #4ECDC4" : "1px solid #252538", borderRadius: 7, color: "#4ECDC4", cursor: "pointer", fontSize: 13, padding: "3px 8px", fontWeight: 700 }}>+</button>}
          <button onClick={openEdit} style={{ background: "none", border: "none", color: "#6C5CE7", cursor: "pointer", fontSize: 14 }}>✏</button>
          <button onClick={() => { if (confirm(t(lang, "confirm.deleteGoal"))) onDelete(goal.id); }} style={{ background: "none", border: "none", color: "#FF6B6B", cursor: "pointer", fontSize: 14 }}>×</button>
        </div>
      </div>

      {/* Quick deposit */}
      {mode === "versa" && (
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <input type="text" inputMode="decimal" autoFocus value={amount} onChange={e => setAmount(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") handleVersa(); if (e.key === "Escape") setMode(null); }}
            placeholder={t(lang, "goals.depositPlaceholder")} style={{ flex: 1, padding: "8px 10px", background: "#1a1a28", border: "1px solid #4ECDC4", borderRadius: 8, color: "#eee", fontSize: 14, fontFamily: "'Space Mono',monospace", outline: "none", minWidth: 0 }} />
          <button onClick={handleVersa} style={{ padding: "8px 14px", background: "#4ECDC4", border: "none", borderRadius: 8, color: "#0a0a12", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>{t(lang, "goals.depositButton")}</button>
        </div>
      )}

      {/* Full edit */}
      {mode === "edit" && (
        <div style={{ marginTop: 10 }}>
          <input type="text" value={eNome} onChange={e => setENome(e.target.value)} placeholder={t(lang, "goals.namePlaceholder")}
            style={{ width: "100%", boxSizing: "border-box", padding: "8px 10px", background: "#1a1a28", border: "1px solid #252538", borderRadius: 8, color: "#eee", fontSize: 13, outline: "none", marginBottom: 8, fontFamily: "'DM Sans',sans-serif" }} />
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <input type="text" inputMode="decimal" value={eTarget} onChange={e => setETarget(e.target.value)} placeholder={t(lang, "goals.targetPlaceholder")}
              style={{ flex: 1, minWidth: 0, padding: "8px 10px", background: "#1a1a28", border: "1px solid #252538", borderRadius: 8, color: "#eee", fontSize: 13, outline: "none", fontFamily: "'Space Mono',monospace" }} />
            <input type="text" inputMode="decimal" value={eCurrent} onChange={e => setECurrent(e.target.value)} placeholder={t(lang, "goals.savedPlaceholder")}
              style={{ flex: 1, minWidth: 0, padding: "8px 10px", background: "#1a1a28", border: "1px solid #252538", borderRadius: 8, color: "#eee", fontSize: 13, outline: "none", fontFamily: "'Space Mono',monospace" }} />
          </div>
          <input type="date" value={eDate} onChange={e => setEDate(e.target.value)}
            style={{ width: "100%", boxSizing: "border-box", padding: "8px 10px", background: "#1a1a28", border: "1px solid #252538", borderRadius: 8, color: "#888", fontSize: 12, outline: "none", marginBottom: 8, colorScheme: "dark" }} />
          {conti.length > 0 && (
            <div style={{ display: "flex", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
              <button onClick={() => setEConto("")} style={{
                padding: "5px 10px", borderRadius: 8, cursor: "pointer", fontSize: 10, fontWeight: 600,
                background: eConto === "" ? "#6C5CE722" : "transparent",
                border: eConto === "" ? "1px solid #6C5CE7" : "1px solid #252538",
                color: eConto === "" ? "#a78bfa" : "#666",
              }}>{t(lang, "goals.noAccount")}</button>
              {conti.map(c => (
                <button key={c.id} onClick={() => setEConto(c.id)} style={{
                  padding: "5px 10px", borderRadius: 8, cursor: "pointer", fontSize: 10, fontWeight: 600,
                  background: eConto === c.id ? "#6C5CE722" : "transparent",
                  border: eConto === c.id ? "1px solid #6C5CE7" : "1px solid #252538",
                  color: eConto === c.id ? "#a78bfa" : "#888",
                }}>{c.icona} {c.nome}</button>
              ))}
            </div>
          )}
          <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
            {["manual", "percent", "fixed"].map(tp => (
              <button key={tp} onClick={() => setECType(tp)} style={{
                flex: 1, padding: "5px 0", borderRadius: 8, cursor: "pointer", fontSize: 10, fontWeight: 600,
                background: eCType === tp ? "#6C5CE722" : "transparent",
                color: eCType === tp ? "#a78bfa" : "#666",
                border: eCType === tp ? "1px solid #6C5CE7" : "1px solid #252538",
              }}>{tp === "manual" ? t(lang, "goals.manual") : tp === "percent" ? t(lang, "goals.percentIncome") : t(lang, "goals.fixedAmount")}</button>
            ))}
          </div>
          {eCType !== "manual" && (
            <>
              <input type="text" inputMode="decimal" value={eCValue} onChange={e => setECValue(e.target.value)}
                placeholder={eCType === "percent" ? t(lang, "goals.percentToSavePlaceholder") : t(lang, "goals.amountToSavePlaceholder")}
                style={{ width: "100%", boxSizing: "border-box", padding: "8px 10px", background: "#1a1a28", border: "1px solid #6C5CE7", borderRadius: 8, color: "#eee", fontSize: 13, outline: "none", marginBottom: 6, fontFamily: "'Space Mono',monospace" }} />
              <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, cursor: "pointer" }}>
                <input type="checkbox" checked={eAuto} onChange={e => setEAuto(e.target.checked)} style={{ width: 14, height: 14 }} />
                <span style={{ fontSize: 11, color: "#aaa" }}>{t(lang, "goals.autoApplyToIncome")}</span>
              </label>
            </>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => setMode(null)} style={{ padding: "8px 12px", background: "none", border: "1px solid #333", borderRadius: 8, color: "#888", fontSize: 12, cursor: "pointer" }}>✕</button>
            <button onClick={handleSaveEdit} disabled={!eNome.trim() || !eTarget} style={{ flex: 1, padding: "8px", background: eNome.trim() && eTarget ? "#6C5CE7" : "#252538", border: "none", borderRadius: 8, color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>{t(lang, "common.save")}</button>
          </div>
        </div>
      )}
    </div>
  );
}

// Goals form component
function GoalsForm({ onAdd, onCancel, conti = [], lang = "it" }) {
  const [nome, setNome] = useState("");
  const [targetAmount, setTargetAmount] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [currentAmount, setCurrentAmount] = useState("");
  const [contributionType, setContributionType] = useState("manual");
  const [contributionValue, setContributionValue] = useState("");
  const [autoAdd, setAutoAdd] = useState(false);
  const [contoId, setContoId] = useState("");
  
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
      contoId: contoId || null,
    });
    setNome(""); setTargetAmount(""); setTargetDate(""); setCurrentAmount("");
    setContributionType("manual"); setContributionValue(""); setAutoAdd(false); setContoId("");
    onCancel?.();
  }
  
  return (
    <div style={{ background: "#111119", borderRadius: 12, padding: 12, marginBottom: 10, border: "1px solid #252538" }}>
      <input type="text" value={nome} onChange={e => setNome(e.target.value)} placeholder={t(lang, "goals.namePlaceholderLong")}
        style={{ ...inputStyle, marginBottom: 8, background: "#1a1a28" }} />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
        <input type="number" inputMode="decimal" value={targetAmount} onChange={e => setTargetAmount(e.target.value)} placeholder={t(lang, "goals.targetPlaceholder")}
          style={{ flex: "1 1 100px", padding: "8px 10px", background: "#1a1a28", border: "1px solid #252538", borderRadius: 8, color: "#eee", fontSize: 13, fontFamily: "'DM Sans',sans-serif", outline: "none" }} />
        <input type="number" inputMode="decimal" value={currentAmount} onChange={e => setCurrentAmount(e.target.value)} placeholder={t(lang, "goals.savedPlaceholderLong")}
          style={{ flex: "1 1 100px", padding: "8px 10px", background: "#1a1a28", border: "1px solid #252538", borderRadius: 8, color: "#eee", fontSize: 13, fontFamily: "'DM Sans',sans-serif", outline: "none" }} />
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
        <input type="date" value={targetDate} onChange={e => setTargetDate(e.target.value)} placeholder={t(lang, "form.date")}
          style={{ flex: "1 1 100px", padding: "8px 10px", background: "#1a1a28", border: "1px solid #252538", borderRadius: 8, color: "#666", fontSize: 12, outline: "none", colorScheme: "dark" }} />
      </div>
      {conti.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 11, color: "#888", marginBottom: 6 }}>{t(lang, "goals.linkedAccount")}</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button onClick={() => setContoId("")} style={{
              padding: "5px 10px", borderRadius: 8, cursor: "pointer", fontSize: 11, fontWeight: 600,
              background: contoId === "" ? "#6C5CE722" : "transparent",
              border: contoId === "" ? "1px solid #6C5CE7" : "1px solid #252538",
              color: contoId === "" ? "#a78bfa" : "#666",
            }}>{t(lang, "form.none")}</button>
            {conti.map(c => (
              <button key={c.id} onClick={() => setContoId(c.id)} style={{
                padding: "5px 10px", borderRadius: 8, cursor: "pointer", fontSize: 11, fontWeight: 600,
                background: contoId === c.id ? "#6C5CE722" : "transparent",
                border: contoId === c.id ? "1px solid #6C5CE7" : "1px solid #252538",
                color: contoId === c.id ? "#a78bfa" : "#888",
              }}>{c.icona} {c.nome}</button>
            ))}
          </div>
        </div>
      )}
      {/* Contribution type */}
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 11, color: "#888", marginBottom: 6 }}>{t(lang, "goals.autoSavings")}</div>
        <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
          {["manual", "percent", "fixed"].map(tp => (
            <button key={tp} onClick={() => setContributionType(tp)} style={{
              flex: 1, padding: "6px 0", borderRadius: 8, cursor: "pointer",
              fontSize: 11, fontWeight: 600,
              background: contributionType === tp ? "#6C5CE722" : "transparent",
              color: contributionType === tp ? "#a78bfa" : "#666",
              border: contributionType === tp ? "1px solid #6C5CE7" : "1px solid #252538",
            }}>
              {tp === "manual" ? t(lang, "goals.manual") : tp === "percent" ? t(lang, "goals.percentIncome") : t(lang, "goals.fixedAmount")}
            </button>
          ))}
        </div>
        {contributionType !== "manual" && (
          <input type="number" inputMode="decimal" value={contributionValue} onChange={e => setContributionValue(e.target.value)}
            placeholder={contributionType === "percent" ? t(lang, "goals.percentToSavePlaceholder") : t(lang, "goals.amountToSavePlaceholder")}
            style={{ width: "100%", padding: "8px 10px", background: "#1a1a28", border: "1px solid #6C5CE7", borderRadius: 8, color: "#eee", fontSize: 13, fontFamily: "'DM Sans',sans-serif", outline: "none" }} />
        )}
      </div>
      {/* Auto-add toggle */}
      <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, cursor: "pointer" }}>
        <input type="checkbox" checked={autoAdd} onChange={e => setAutoAdd(e.target.checked)} style={{ width: 16, height: 16 }} />
        <span style={{ fontSize: 12, color: "#aaa" }}>{t(lang, "goals.autoApplyToIncome")}</span>
      </label>
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={onCancel} style={{ padding: "8px 12px", background: "none", border: "1px solid #333", borderRadius: 8, color: "#888", fontSize: 12 }}>✕</button>
        <button onClick={handleSubmit} disabled={!nome.trim() || !targetAmount} style={{ flex: 1, padding: "8px", background: nome.trim() && targetAmount ? "#6C5CE7" : "#252538", border: "none", borderRadius: 8, color: nome.trim() && targetAmount ? "#fff" : "#555", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>{t(lang, "common.add")}</button>
      </div>
    </div>
  );
}

function ContiCard({ conti, transazioni, goals = [], onAdd, onUpdate, onDelete, lang = "it" }) {
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState(null);
  const [nome, setNome] = useState("");
  const [icona, setIcona] = useState("🏦");
  const [saldoIniziale, setSaldoIniziale] = useState("");
  const [saving, setSaving] = useState(false);
  const ICONE = ["🏦", "💳", "💵", "🐖", "📱", "💰"];

  // Saldo (person-to-person) transactions are intentionally excluded.
  const saldi = calcolaSaldiConti(conti, transazioni);
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
          background: editId === c.id ? "#6C5CE711" : "#111119", marginBottom: 6,
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
        <div style={{ marginTop: 10, padding: 12, background: "#111119", borderRadius: 12, border: "1px solid #6C5CE733" }}>
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

function HomeView({ transazioni, onDelete, onEdit, onSettle, persone, meseOffset, categorie, goals, onAddGoal, onUpdateGoal, onDeleteGoal, conti = [], onAddConto, onUpdateConto, onDeleteConto, positions = [], manualPrices = {}, lang = "it" }) {
  const oggi = new Date();
  const [editId, setEditId] = useState(null);
  const [settlingKey, setSettlingKey] = useState(null);
  const [settleAmount, setSettleAmount] = useState("");
  const [search, setSearch] = useState("");
  const FILTRI_VUOTI = { tipo: "", categoria: "", personaId: "", contoId: "", minImporto: "", maxImporto: "" };
  const [filtri, setFiltri] = useState(FILTRI_VUOTI);
  const [showFiltri, setShowFiltri] = useState(false);
  const [tuttiIMesi, setTuttiIMesi] = useState(false);
  const [showAddGoal, setShowAddGoal] = useState(false);
  const [showStoricoSaldi, setShowStoricoSaldi] = useState(false);

  const meseVis = new Date(oggi.getFullYear(), oggi.getMonth() - meseOffset, 1);
  const nomeMese = mese(meseVis.getMonth()) + " " + meseVis.getFullYear();

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
  const nFiltriAttivi = contaFiltriAttivi(filtri);
  const ricercaAttiva = !!search.trim() || nFiltriAttivi > 0;
  const baseTx = (ricercaAttiva && tuttiIMesi ? transazioni : txMese).filter(t => t.tipo !== "saldo");
  const txOrdinate = filtraTransazioni(baseTx, { ...filtri, query: search }, categorie)
    .sort((a, b) => new Date(b.data) - new Date(a.data));
  const totaleRisultati = ricercaAttiva ? txOrdinate.reduce((s, t) => s + (t.tipo === "uscita" ? -t.importo : t.tipo === "entrata" ? t.importo : 0), 0) : 0;

  const debitiGlobale = calcolaDebitiMatrix(transazioni, persone);
  const debitiMese = calcolaDebitiMatrix(txMese.filter(t => t.tipo !== "saldo"), persone); // saldi esclusi: pagano debiti di mesi precedenti e creerebbero debiti inversi fittizi nella vista mensile
  const allPeople = getAllPersone(transazioni, persone);
  const p1 = persone[0] || DEFAULT_PERSONE[0];
  const p2 = persone[1] || DEFAULT_PERSONE[1];

  const oggiStr = new Date().toISOString().slice(0, 10);
  const ricorrentiInScadenza = transazioni.filter(t =>
    t.ricorrenza?.frequenza && t.ricorrenza?.prossimaData &&
    t.ricorrenza.prossimaData <= oggiStr
  );
  const daVerificareList = transazioni.filter(t => t.daVerificare);

  return (
    <div>
      <div style={{ padding: "14px 16px 20px" }}>
      {/* Saldo card */}
      <div style={{ background: "linear-gradient(135deg, #1e1e30 0%, #2a1f4e 100%)", borderRadius: 20, padding: "24px 20px", marginBottom: 12, border: "1px solid #333355", boxShadow: "0 8px 32px #0005" }}>
        <div style={{ fontSize: 12, color: "#999", letterSpacing: 1, textTransform: "uppercase" }}>{t(lang, "home.balanceOf")} {mese(meseVis.getMonth())}</div>
        <div style={{ fontSize: 36, fontWeight: 800, marginTop: 6, fontFamily: "'Space Mono', monospace", color: saldo >= 0 ? "#4ECDC4" : "#FF6B6B", letterSpacing: -1 }}>
          {saldo >= 0 ? "+" : ""}{formattaValuta(saldo)}
        </div>
        <div style={{ display: "flex", gap: 20, marginTop: 16 }}>
          <div>
            <div style={{ fontSize: 10, color: "#6a6", letterSpacing: 0.5 }}>{t(lang, "home.income")}</div>
            <div style={{ fontSize: 16, fontWeight: 600, color: "#6C6", fontFamily: "'Space Mono',monospace" }}>{formattaValuta(entrate)}</div>
          </div>
          <div>
            <div style={{ fontSize: 10, color: "#a66", letterSpacing: 0.5 }}>{t(lang, "home.expenses")}</div>
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
                ? `"${ricorrentiInScadenza[0].descrizione || ricorrentiInScadenza[0].categoria}" ${t(lang, "home.renewedOne")}`
                : `${ricorrentiInScadenza.length} ${t(lang, "home.renewedMany")}`}
            </div>
            <div style={{ fontSize: 11, color: "#555", marginTop: 2 }}>{t(lang, "home.addedToday")}</div>
          </div>
        </div>
      )}

      {/* Variable recurring — needs amount check */}
      {daVerificareList.length > 0 && (
        <div style={{ background: "#1a1a28", borderRadius: 14, padding: "12px 14px", marginBottom: 12, border: "1px solid #FFB02044", display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 18 }}>⚠️</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#FFB020" }}>
              {daVerificareList.length === 1
                ? `${t(lang, "home.checkAmountOne")} "${daVerificareList[0].descrizione || daVerificareList[0].categoria}"`
                : `${daVerificareList.length} ${t(lang, "home.checkAmountMany")}`}
            </div>
            <div style={{ fontSize: 11, color: "#555", marginTop: 2 }}>{t(lang, "home.variableAmountHint")}</div>
          </div>
        </div>
      )}

      {/* Patrimonio (net worth) card */}
      {(conti.length > 0 || positions.length > 0) && (() => {
        const saldi = calcolaSaldiConti(conti, transazioni);
        const totConti = conti.reduce((s, c) => s + (saldi[c.id] || 0), 0);
        const { valore: totInvestimenti } = calcolaValorePortfolio(positions, manualPrices);
        const patrimonio = totConti + totInvestimenti;
        const accantonati = (goals || []).reduce((s, g) => s + (g.contoId ? (g.currentAmount || 0) : 0), 0);
        return (
          <div style={{ background: "linear-gradient(135deg, #1e1e30 0%, #16281f 100%)", borderRadius: 20, padding: "18px 20px", marginBottom: 16, border: "1px solid #2a4a3a", boxShadow: "0 8px 32px #0005" }}>
            <div style={{ fontSize: 11, color: "#999", letterSpacing: 0.5, textTransform: "uppercase" }}>{t(lang, "home.netWorth")}</div>
            <div style={{ fontSize: 30, fontWeight: 800, fontFamily: "'Space Mono',monospace", color: patrimonio >= 0 ? "#eee" : "#FF6B6B", marginTop: 4 }}>
              {formattaValuta(patrimonio)}
            </div>
            <div style={{ display: "flex", gap: 16, marginTop: 10, flexWrap: "wrap" }}>
              {conti.length > 0 && (
                <div>
                  <div style={{ fontSize: 10, color: "#888" }}>{t(lang, "home.accounts")}</div>
                  <div style={{ fontSize: 13, fontWeight: 700, fontFamily: "'Space Mono',monospace", color: totConti >= 0 ? "#4ECDC4" : "#FF6B6B" }}>{formattaValuta(totConti)}</div>
                </div>
              )}
              {positions.length > 0 && totInvestimenti > 0 && (
                <div>
                  <div style={{ fontSize: 10, color: "#888" }}>{t(lang, "home.investments")}</div>
                  <div style={{ fontSize: 13, fontWeight: 700, fontFamily: "'Space Mono',monospace", color: "#a78bfa" }}>{formattaValuta(totInvestimenti)}</div>
                </div>
              )}
              {accantonati > 0 && (
                <div>
                  <div style={{ fontSize: 10, color: "#888" }}>{t(lang, "home.inGoals")}</div>
                  <div style={{ fontSize: 13, fontWeight: 700, fontFamily: "'Space Mono',monospace", color: "#F0A500" }}>{formattaValuta(accantonati)}</div>
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* Debt card */}
      <ContiCard conti={conti} transazioni={transazioni} goals={goals} onAdd={onAddConto} onUpdate={onUpdateConto} onDelete={onDeleteConto} lang={lang} />

      <div style={{ background: "#1a1a28", borderRadius: 16, padding: 16, marginBottom: 20, border: "1px solid #252538" }}>
        <div style={{ fontSize: 11, color: "#999", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 10 }}>{t(lang, "home.debtBalance")}</div>
        {/* Month debts */}
        <div style={{ fontSize: 10, color: "#777", marginBottom: 6 }}>{mese(meseVis.getMonth())}</div>
        {debitiMese.length === 0 ? <div style={{ fontSize: 13, color: "#888", marginBottom: 8 }}>{t(lang, "home.allSquare")}</div> : (
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
          <div style={{ fontSize: 10, color: "#777", marginBottom: 6 }}>{t(lang, "home.total")}</div>
          {debitiGlobale.length === 0 ? <div style={{ fontSize: 13, color: "#888" }}>{t(lang, "home.allSquare")}</div> : (
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
                      <button onClick={() => setSettleAmount(String(d.importo))} style={{ padding: "9px 10px", border: "1px solid #4ECDC433", borderRadius: 10, background: "#4ECDC411", color: "#4ECDC4", fontSize: 11, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>{t(lang, "home.max")}</button>
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button onClick={() => { setSettlingKey(null); setSettleAmount(""); }} style={{ flex: 1, padding: "9px", border: "1px solid #252538", borderRadius: 10, background: "transparent", color: "#888", fontSize: 12, cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>{t(lang, "home.cancel")}</button>
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
                        {t(lang, "home.confirmSettle")}
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
                  {t(lang, "home.settle")} {pDa.nome} → {pA.nome} ({formattaValuta(d.importo)})
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
              <button onClick={() => setShowStoricoSaldi(v => !v)} style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", background: "none", border: "none", padding: 0, cursor: "pointer", marginBottom: showStoricoSaldi ? 8 : 0 }}>
                <span style={{ fontSize: 10, color: "#777", letterSpacing: 0.5, textTransform: "uppercase" }}>{t(lang, "home.settleHistory")} ({saldati.length})</span>
                <span style={{ fontSize: 10, color: "#6C5CE7", transform: showStoricoSaldi ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.2s ease", display: "inline-block" }}>▼</span>
              </button>
              {showStoricoSaldi && <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                {saldati.map((s, i) => {
                  const pDa = allPeople.find(p => p.id === s.pagatoDa) || { nome: s.pagatoDa, emoji: "👤" };
                  const pA = allPeople.find(p => p.id === s.ricevutoDa) || { nome: s.ricevutoDa, emoji: "👤" };
                  return (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontSize: 12, color: "#4ECDC4" }}>✓</span>
                      <span style={{ fontSize: 11, color: "#666", flex: 1 }}>{pDa.nome} → {pA.nome}</span>
                      <span style={{ fontSize: 11, color: "#4ECDC4", fontFamily: "'Space Mono',monospace", fontWeight: 600 }}>{formattaValuta(s.importo)}</span>
                      <span style={{ fontSize: 10, color: "#555", marginLeft: 4 }}>{formattaData(s.data)}</span>
                      <button onClick={() => onDelete(s.id)} style={{ background: "none", border: "none", color: "#FF6B6B55", cursor: "pointer", fontSize: 12, padding: "0 2px", lineHeight: 1 }} title={t(lang, "home.deleteSettle")}>✕</button>
                    </div>
                  );
                })}
              </div>}
            </div>
          );
        })()}
      </div>

      {/* Savings Goals card */}
      <div style={{ background: "#1a1a28", borderRadius: 16, padding: 16, marginBottom: 20, border: "1px solid #252538" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <div style={{ fontSize: 11, color: "#999", letterSpacing: 0.5, textTransform: "uppercase" }}>{t(lang, "home.savingsGoals")}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {goals?.length > 1 && (
              <span style={{ fontSize: 11, fontFamily: "'Space Mono',monospace", color: "#888" }}>
                <span style={{ color: "#4ECDC4", fontWeight: 700 }}>{formattaValuta(goals.reduce((s, g) => s + (g.currentAmount || 0), 0))}</span>
                {" / "}{formattaValuta(goals.reduce((s, g) => s + (g.targetAmount || 0), 0))}
              </span>
            )}
            <button onClick={() => setShowAddGoal(!showAddGoal)} style={{
              background: "none", border: "none", color: "#6C5CE7", cursor: "pointer", fontSize: 14,
            }}>{showAddGoal ? "✕" : "+"}</button>
          </div>
        </div>

        {/* Add goal form */}
        {showAddGoal && (
          <GoalsForm onAdd={onAddGoal} onCancel={() => setShowAddGoal(false)} conti={conti} lang={lang} />
        )}

        {/* Goals list */}
        {(!goals || goals.length === 0) && !showAddGoal ? (
          <div style={{ fontSize: 12, color: "#666", textAlign: "center", padding: 8 }}>
            {t(lang, "home.noGoals")}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {goals?.map(g => (
              <GoalRow key={g.id} goal={g} onUpdate={onUpdateGoal} onDelete={onDeleteGoal} conti={conti} lang={lang} />
            ))}
          </div>
        )}
      </div>

      {/* Transactions for selected month */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div style={{ fontSize: 13, color: "#999", letterSpacing: 0.5, textTransform: "uppercase" }}>{ricercaAttiva && tuttiIMesi ? t(lang, "home.searchResults") : `${t(lang, "home.transactionsOf")} ${mese(meseVis.getMonth())}`}</div>
        <div style={{ fontSize: 12, color: "#666", fontFamily: "'Space Mono',monospace" }}>{txOrdinate.length}</div>
      </div>
      <div style={{ position: "relative", marginBottom: 8 }}>
        <span style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", fontSize: 14, color: "#555", pointerEvents: "none" }}>🔍</span>
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder={t(lang, "home.searchPlaceholder")}
          style={{ ...inputStyle, paddingLeft: 36, paddingRight: 70, paddingTop: 10, paddingBottom: 10, fontSize: 13 }}
        />
        {search && (
          <button onClick={() => setSearch("")} style={{ position: "absolute", right: 44, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "#555", cursor: "pointer", fontSize: 16, lineHeight: 1, padding: 2 }}>✕</button>
        )}
        <button onClick={() => setShowFiltri(!showFiltri)} style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", background: showFiltri || nFiltriAttivi > 0 ? "#6C5CE722" : "none", border: "1px solid " + (showFiltri || nFiltriAttivi > 0 ? "#6C5CE766" : "transparent"), borderRadius: 8, color: nFiltriAttivi > 0 ? "#a78bfa" : "#777", cursor: "pointer", fontSize: 13, padding: "4px 7px", display: "flex", alignItems: "center", gap: 3 }}>
          ⚙{nFiltriAttivi > 0 && <span style={{ fontSize: 10, fontWeight: 800, fontFamily: "'Space Mono',monospace" }}>{nFiltriAttivi}</span>}
        </button>
      </div>

      {/* Advanced filters panel */}
      {showFiltri && (
        <div style={{ background: "#1a1a28", borderRadius: 14, padding: 12, marginBottom: 8, border: "1px solid #252538", display: "flex", flexDirection: "column", gap: 10 }}>
          {/* Tipo */}
          <div>
            <div style={filterLabelStyle}>{t(lang, "home.filterType")}</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {[{ id: "", label: t(lang, "home.filterAll") }, { id: "uscita", label: t(lang, "home.filterExpenses") }, { id: "entrata", label: t(lang, "home.filterIncome") }, { id: "trasferimento", label: t(lang, "home.filterTransfers") }].map(o => (
                <FilterChip key={o.id || "all"} active={filtri.tipo === o.id} onClick={() => setFiltri({ ...filtri, tipo: o.id })}>{o.label}</FilterChip>
              ))}
            </div>
          </div>
          {/* Categoria */}
          <div>
            <div style={filterLabelStyle}>{t(lang, "home.filterCategory")}</div>
            <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 2, WebkitOverflowScrolling: "touch" }}>
              <FilterChip active={!filtri.categoria} onClick={() => setFiltri({ ...filtri, categoria: "" })}>{t(lang, "home.filterAll")}</FilterChip>
              {categorie.filter(c => c.id !== "entrata").map(c => (
                <FilterChip key={c.id} active={filtri.categoria === c.id} onClick={() => setFiltri({ ...filtri, categoria: filtri.categoria === c.id ? "" : c.id })}>{c.emoji} {c.nome}</FilterChip>
              ))}
            </div>
          </div>
          {/* Persona */}
          <div>
            <div style={filterLabelStyle}>{t(lang, "home.filterPerson")}</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <FilterChip active={!filtri.personaId} onClick={() => setFiltri({ ...filtri, personaId: "" })}>{t(lang, "home.filterAll")}</FilterChip>
              {persone.map(p => (
                <FilterChip key={p.id} active={filtri.personaId === p.id} onClick={() => setFiltri({ ...filtri, personaId: filtri.personaId === p.id ? "" : p.id })}>{p.emoji} {p.nome}</FilterChip>
              ))}
            </div>
          </div>
          {/* Conto */}
          {conti.length > 0 && (
            <div>
              <div style={filterLabelStyle}>{t(lang, "home.filterAccount")}</div>
              <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 2, WebkitOverflowScrolling: "touch" }}>
                <FilterChip active={!filtri.contoId} onClick={() => setFiltri({ ...filtri, contoId: "" })}>{t(lang, "home.filterAllAccounts")}</FilterChip>
                {conti.map(c => (
                  <FilterChip key={c.id} active={filtri.contoId === c.id} onClick={() => setFiltri({ ...filtri, contoId: filtri.contoId === c.id ? "" : c.id })}>{c.icona} {c.nome}</FilterChip>
                ))}
              </div>
            </div>
          )}
          {/* Importo */}
          <div>
            <div style={filterLabelStyle}>{t(lang, "home.filterAmount")} (€)</div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input type="text" inputMode="decimal" value={filtri.minImporto} onChange={e => setFiltri({ ...filtri, minImporto: e.target.value })} placeholder={t(lang, "home.filterMin")} style={{ ...inputStyle, padding: "8px 12px", fontSize: 13, fontFamily: "'Space Mono',monospace" }} />
              <span style={{ color: "#555", fontSize: 12 }}>—</span>
              <input type="text" inputMode="decimal" value={filtri.maxImporto} onChange={e => setFiltri({ ...filtri, maxImporto: e.target.value })} placeholder={t(lang, "home.filterMax")} style={{ ...inputStyle, padding: "8px 12px", fontSize: 13, fontFamily: "'Space Mono',monospace" }} />
            </div>
          </div>
          {nFiltriAttivi > 0 && (
            <button onClick={() => setFiltri(FILTRI_VUOTI)} style={{ background: "none", border: "1px solid #FF6B6B44", borderRadius: 10, color: "#FF6B6B", cursor: "pointer", fontSize: 12, fontWeight: 700, padding: "8px 12px" }}>{t(lang, "home.clearFilters")}</button>
          )}
        </div>
      )}

      {/* Search scope toggle + results summary */}
      {ricercaAttiva && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, gap: 8, flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 6 }}>
            <FilterChip active={!tuttiIMesi} onClick={() => setTuttiIMesi(false)}>{t(lang, "home.thisMonth")} {mese(meseVis.getMonth())}</FilterChip>
            <FilterChip active={tuttiIMesi} onClick={() => setTuttiIMesi(true)}>{t(lang, "home.allMonths")}</FilterChip>
          </div>
          {txOrdinate.length > 0 && (
            <div style={{ fontSize: 11, color: "#888", fontFamily: "'Space Mono',monospace" }}>
              {t(lang, "home.net")}: <span style={{ fontWeight: 700, color: totaleRisultati >= 0 ? "#4ECDC4" : "#FF6B6B" }}>{totaleRisultati >= 0 ? "+" : ""}{formattaValuta(totaleRisultati)}</span>
            </div>
          )}
        </div>
      )}
      {txOrdinate.length === 0 ? (
        <div style={{ color: "#555", textAlign: "center", padding: 40, fontSize: 14 }}>
          {ricercaAttiva ? <>{t(lang, "home.noResults")}{search.trim() ? ` ${t(lang, "home.noResultsFor")} "${search}"` : ""}{nFiltriAttivi > 0 ? ` ${t(lang, "home.withActiveFilters")}` : ""}.{!tuttiIMesi && <><br/><span style={{ fontSize: 12 }}>{t(lang, "home.tryAllMonths")}</span></>}</> : <>{t(lang, "home.noTransactionsIn")} {nomeMese}.<br/>{t(lang, "home.pressToStart")}</>}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {txOrdinate.map(t => (
            <TransactionRow key={t.id} t={t} persone={persone} categorie={categorie} conti={conti} isEditing={editId === t.id}
              onTap={() => setEditId(editId === t.id ? null : t.id)}
              onDelete={() => { onDelete(t.id); setEditId(null); }}
              onSave={(updates) => { onEdit(t.id, updates); setEditId(null); }}
              onCancel={() => setEditId(null)}
              lang={lang}
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

// ─── Filter chip (search & advanced filters) ───
const filterLabelStyle = { fontSize: 10, color: "#777", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 6 };
function FilterChip({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      background: active ? "#6C5CE722" : "#12121e",
      border: "1px solid " + (active ? "#6C5CE7" : "#252538"),
      borderRadius: 10, color: active ? "#a78bfa" : "#999",
      cursor: "pointer", fontSize: 12, fontWeight: active ? 700 : 500,
      padding: "6px 10px", whiteSpace: "nowrap", flexShrink: 0, transition: "all 0.15s",
    }}>{children}</button>
  );
}

// Ricostruisce lo stato iniziale degli split per il form di modifica di una
// transazione esistente. A differenza del form di "nuova spesa" (dove un
// default equo tra tutti è un suggerimento ragionevole), qui la spesa ha già
// uno stato reale salvato e va rispettato:
// - splits presenti → usali così come sono
// - vecchio formato a 2 persone (splitPagante) → converti
// - nessuno split ma pagatoDa presente → spesa "solo mia": il pagante è
//   l'unico partecipante, al 100%, non un default equo tra tutti
// - nessun pagante → nessun partecipante
function initialSplits(t, persone) {
  if (t.splits) return t.splits;
  if (t.splitPagante != null) {
    const payer = t.pagatoDa || persone[0]?.id;
    const otherId = persone.find(p => p.id !== payer)?.id || persone[1]?.id;
    return [
      { personaId: payer, quota: t.splitPagante },
      { personaId: otherId, quota: 100 - t.splitPagante },
    ];
  }
  if (t.pagatoDa) return [{ personaId: t.pagatoDa, quota: 100 }];
  return [];
}

// ─── Transaction Row with inline edit ───
function TransactionRow({ t: tx, persone, categorie, conti = [], isEditing, onTap, onDelete, onSave, onCancel, lang = "it" }) {
  const _ENTRATA_CAT = { id: "entrata", nome: t(lang, "cat.entrata"), emoji: "💰", colore: "#4ECDC4" };
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
      <div style={{ display: "flex", alignItems: "center", gap: 10, background: "#1a1a28", borderRadius: 14, padding: "12px 14px", border: "1px solid #252538" }}>
        <div style={{ width: 40, height: 40, borderRadius: 12, background: "#6C5CE722", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0 }}>⇄</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "#eee", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{tx.descrizione || t(lang, "form.transfer")}</div>
          <div style={{ fontSize: 11, color: "#666" }}>
            {formattaData(tx.data)} · {cDa ? `${cDa.icona} ${cDa.nome}` : "?"} → {cA ? `${cA.icona} ${cA.nome}` : "?"}
          </div>
        </div>
        <div style={{ fontSize: 15, fontWeight: 700, fontFamily: "'Space Mono',monospace", color: "#a78bfa", flexShrink: 0 }}>{formattaValuta(tx.importo)}</div>
        <button onClick={() => { if (confirm(t(lang, "form.deleteTransferConfirm"))) onDelete(); }} style={{ background: "none", border: "none", color: "#FF6B6B55", cursor: "pointer", fontSize: 14, padding: "0 2px", flexShrink: 0 }}>✕</button>
      </div>
    );
  }

  // Compact row
  if (!isEditing) {
    return (
      <div onClick={onTap} style={{ display: "flex", alignItems: "center", gap: 10, background: "#1a1a28", borderRadius: 14, padding: "12px 14px", border: "1px solid #252538", cursor: "pointer", transition: "background 0.2s" }}>
        <div style={{ width: 40, height: 40, borderRadius: 12, background: cat.colore + "22", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0 }}>
          {cat.emoji}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "#eee", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {tx.descrizione || cat.nome}
            {tx.ricorrenza && <span style={{ fontSize: 10, marginLeft: 5, color: "#6C5CE7" }}>🔁</span>}
            {tx.daVerificare && <span title={t(lang, "form.checkAmountTitle")} style={{ fontSize: 10, marginLeft: 5, color: "#FFB020" }}>⚠️</span>}
          </div>
          <div style={{ fontSize: 11, color: "#666", display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
            {formattaData(tx.data)}
            {(() => { const c = conti.find(x => x.id === tx.contoId); return c ? <span title={c.nome} style={{ fontSize: 10 }}>{c.icona}</span> : null; })()}
            {persona && tx.tipo === "uscita" && (() => {
              // Ottieni lista partecipanti con quote
              let participants = [];
              if (tx.splits && Array.isArray(tx.splits) && tx.splits.length > 0) {
                participants = tx.splits.map(s => ({
                  id: s.personaId,
                  quota: s.quota,
                  persona: persone.find(p => p.id === s.personaId) || { id: s.personaId, nome: s.personaId, emoji: "👤", colore: "#888" }
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
          <div style={{ fontSize: 15, fontWeight: 700, fontFamily: "'Space Mono',monospace", color: tx.tipo === "entrata" ? "#4ECDC4" : "#FF6B6B" }}>{tx.tipo === "entrata" ? "+" : "-"}{formattaValuta(tx.importo)}</div>
          {tx.valuta && <div style={{ fontSize: 10, color: "#666", fontFamily: "'Space Mono',monospace" }}>{tx.importoOriginale} {tx.valuta}</div>}
        </div>
      </div>
    );
  }

  // Expanded edit form
  return (
    <div style={{ background: "#1a1a28", borderRadius: 16, padding: "16px", border: "2px solid #6C5CE7", position: "relative", zIndex: 10, overflow: "hidden" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: "#eee" }}>{t(lang, "form.editTransaction")}</div>
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
          }}>{tp === "uscita" ? t(lang, "type.expense") : t(lang, "type.income")}</button>
        ))}
      </div>

      {/* Importo */}
      <div style={{ marginBottom: 12 }}>
        <label style={labelStyle}>{t(lang, "home.filterAmount")} (€)</label>
        <input type="number" inputMode="decimal" value={importo} onChange={e => setImporto(e.target.value)}
          style={{ ...inputStyle, fontSize: 22, fontWeight: 800, fontFamily: "'Space Mono',monospace", textAlign: "center", color: tipo === "uscita" ? "#FF6B6B" : "#4ECDC4", background: "#111119" }} />
      </div>

      {/* Categoria */}
      {tipo === "uscita" && (
        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>{t(lang, "home.filterCategory")}</label>
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
        <SplitSelector pagatoDa={pagatoDa} setPagatoDa={setPagatoDa} splits={splits} setSplits={setSplits} persone={persone} importo={importo} extraPersone={extraPersone} setExtraPersone={setExtraPersone} lang={lang} />
      )}

      {/* Entrata di chi */}
      {tipo === "entrata" && (
        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>{t(lang, "form.whoseIncome")}</label>
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
        <label style={labelStyle}>{t(lang, "form.description")}</label>
        <input type="text" value={descrizione} onChange={e => setDescrizione(e.target.value)} placeholder={t(lang, "form.descriptionPlaceholder")} style={{ ...inputStyle, background: "#111119" }} />
      </div>

      {/* Data */}
      <div style={{ marginBottom: 16 }}>
        <label style={labelStyle}>{t(lang, "form.date")}</label>
        <input type="date" value={data} onChange={e => setData(e.target.value)} style={{ ...inputStyle, background: "#111119", colorScheme: "dark" }} />
      </div>
      {/* Conto */}
      {conti.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <label style={labelStyle}>{t(lang, "home.filterAccount")}</label>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button onClick={() => setEContoId("")} style={{
              padding: "6px 10px", borderRadius: 8, cursor: "pointer", fontSize: 11, fontWeight: 600, fontFamily: "'DM Sans',sans-serif",
              background: eContoId === "" ? "#6C5CE722" : "#111119",
              border: eContoId === "" ? "1px solid #6C5CE7" : "1px solid #252538",
              color: eContoId === "" ? "#a78bfa" : "#666",
            }}>{t(lang, "form.none")}</button>
            {conti.map(c => (
              <button key={c.id} onClick={() => setEContoId(c.id)} style={{
                padding: "6px 10px", borderRadius: 8, cursor: "pointer", fontSize: 11, fontWeight: 600, fontFamily: "'DM Sans',sans-serif",
                background: eContoId === c.id ? "#6C5CE722" : "#111119",
                border: eContoId === c.id ? "1px solid #6C5CE7" : "1px solid #252538",
                color: eContoId === c.id ? "#a78bfa" : "#888",
              }}>{c.icona} {c.nome}</button>
            ))}
          </div>
        </div>
      )}

      {/* Actions */}
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={() => { if (confirm(t(lang, "form.deleteTransactionConfirm"))) onDelete(); }} style={{
          padding: "12px", border: "1px solid #FF6B6B44", borderRadius: 12, cursor: "pointer",
          background: "#FF6B6B11", color: "#FF6B6B", fontSize: 13, fontWeight: 600, flexShrink: 0,
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

// ─── Add ───
// Fallback list shown before the live rates table loads (or if offline) — the
// real option list is the keys of GET /api/exchange-rates, ~160 currencies.
const VALUTE_FALLBACK = ["EUR", "USD", "GBP", "CHF", "JPY", "CAD", "AUD", "CNY", "SEK", "NOK", "PLN"];
const RICORRENZA_IDS = ["no", "settimanale", "mensile", "trimestrale", "annuale"];

function calcolaProssimaData(data, frequenza) {
  const d = new Date(data + "T12:00:00");
  if (frequenza === "settimanale") d.setDate(d.getDate() + 7);
  else if (frequenza === "mensile") d.setMonth(d.getMonth() + 1);
  else if (frequenza === "trimestrale") d.setMonth(d.getMonth() + 3);
  else if (frequenza === "annuale") d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

function AggiungiView({ onAggiungi, persone, transazioni = [], categorie, conti = [], initialTipo = "uscita", initialImporto = "", initialDescrizione = "", initialCategoria = "", initialPagatoDa = "", valutaBase = "EUR", lang = "it" }) {
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
  const [importoVariabile, setImportoVariabile] = useState(false);
  const [contoId, setContoId] = useState("");
  const [contoDa, setContoDa] = useState("");
  const [contoA, setContoA] = useState("");
  const [valuta, setValuta] = useState(valutaBase);
  const [valuteDisponibili, setValuteDisponibili] = useState(VALUTE_FALLBACK);

  useEffect(() => { setValuta(valutaBase); }, [valutaBase]);
  useEffect(() => {
    fetchExchangeRates().then(r => {
      const codes = Object.keys(r.rates || {});
      if (codes.length > 0) setValuteDisponibili(codes.sort());
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (initialImporto) setImportoRaw(initialImporto);
  }, [initialImporto]);

  useEffect(() => {
    if (initialDescrizione) setDescrizione(initialDescrizione);
  }, [initialDescrizione]);

  useEffect(() => {
    if (initialCategoria) {
      const match = categorie.find(c => c.id === initialCategoria || c.nome.toLowerCase() === initialCategoria.toLowerCase());
      if (match) setCategoria(match.id);
    }
  }, [initialCategoria]);

  function handleReceiptScan(parsed) {
    if (parsed.importo) {
      setImportoRaw(String(parsed.importo));
      setImporto(parsed.importo);
    }
    if (parsed.descrizione) {
      setDescrizione(parsed.descrizione);
    }
    if (parsed.categoria) {
      const match = categorie.find(c => c.id === parsed.categoria);
      if (match) setCategoria(match.id);
    }
  }

  function handleSubmit() {
    const val = importo; // already computed from evalImporto
    if (!val || val <= 0) return;
    if (tipo === "trasferimento") {
      if (!contoDa || !contoA || contoDa === contoA) return;
      onAggiungi({
        id: generaId(), tipo: "trasferimento", importo: val,
        categoria: "trasferimento", descrizione: descrizione.trim(), data,
        pagatoDa: null, splits: null, extraPersone: null, intestataA: null,
        contoId: null, contoDa, contoA, ricorrenza: null,
      });
      setImportoRaw(""); setImporto(0); setDescrizione(""); setSalvato(true);
      setTimeout(() => setSalvato(false), 1500);
      return;
    }
    const ricorrenzaData = ricorrenza !== "no" ? {
      frequenza: ricorrenza,
      prossimaData: calcolaProssimaData(data, ricorrenza),
      variabile: importoVariabile,
    } : null;
    onAggiungi({
      id: generaId(), tipo, importo: val,
      categoria: tipo === "entrata" ? "entrata" : categoria,
      descrizione: descrizione.trim(), data,
      pagatoDa: tipo === "uscita" ? pagatoDa : null,
      splits: tipo === "uscita" ? splits : null,
      extraPersone: tipo === "uscita" && extraPersone.length > 0 ? extraPersone : null,
      intestataA: tipo === "entrata" ? intestataA : null,
      contoId: contoId || null,
      ricorrenza: ricorrenzaData,
      valuta: valuta !== valutaBase ? valuta : null,
    });
    setImportoRaw(""); setImporto(0); setDescrizione(""); setRicorrenza("no"); setImportoVariabile(false); setValuta(valutaBase); setSalvato(true);
    setTimeout(() => setSalvato(false), 1500);
  }

  const val = importo || 0;

  return (
    <div style={{ padding: "20px 16px" }}>
      <div style={{ fontSize: 22, fontWeight: 800, color: "#eee", marginBottom: 20 }}>{t(lang, "aggiungi.title")}</div>
      <div style={{ marginBottom: 16 }}><ReceiptScanner onScanComplete={handleReceiptScan} /></div>
      <div style={{ display: "flex", background: "#1a1a28", borderRadius: 14, padding: 4, marginBottom: 20, border: "1px solid #252538" }}>
        {["uscita", "entrata", ...(conti.length >= 2 ? ["trasferimento"] : [])].map(tp => (
          <button key={tp} onClick={() => setTipo(tp)} style={{
            flex: 1, padding: "10px 0", border: "none", borderRadius: 11, cursor: "pointer",
            fontFamily: "'DM Sans',sans-serif", fontSize: 14, fontWeight: 600,
            background: tipo===tp?(tp==="uscita"?"linear-gradient(135deg,#FF6B6B33,#FF6B6B22)":tp==="trasferimento"?"linear-gradient(135deg,#6C5CE733,#6C5CE722)":"linear-gradient(135deg,#4ECDC433,#4ECDC422)"):"transparent",
            color: tipo===tp?(tp==="uscita"?"#FF6B6B":tp==="trasferimento"?"#a78bfa":"#4ECDC4"):"#666",
          }}>{tp === "uscita" ? t(lang, "type.expense") : tp === "entrata" ? t(lang, "type.income") : t(lang, "type.transfer")}</button>
        ))}
      </div>
      <div style={{ marginBottom: 18 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <label style={{ ...labelStyle, marginBottom: 0 }}>{t(lang, "home.filterAmount")}</label>
          {tipo !== "trasferimento" && (
            <select value={valuta} onChange={e => setValuta(e.target.value)} style={{
              background: valuta !== valutaBase ? "#6C5CE722" : "#1a1a28",
              border: `1px solid ${valuta !== valutaBase ? "#6C5CE766" : "#252538"}`,
              borderRadius: 10, color: valuta !== valutaBase ? "#a78bfa" : "#999",
              fontFamily: "'DM Sans',sans-serif", fontSize: 13, fontWeight: 700, letterSpacing: 0.3,
              padding: "8px 14px", cursor: "pointer", appearance: "none", WebkitAppearance: "none",
              backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23999' stroke-width='1.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")",
              backgroundRepeat: "no-repeat", backgroundPosition: "right 10px center", paddingRight: 28,
            }}>
              {valuteDisponibili.map(v => <option key={v} value={v}>{v}</option>)}
            </select>
          )}
        </div>
        <input type="text" ref={importoInputRef} inputMode="decimal" value={importoRaw} onChange={e => { setImportoRaw(e.target.value); setImporto(evalImporto(e.target.value)); }} placeholder="0€"
          style={{ ...inputStyle, fontSize: 28, fontWeight: 800, fontFamily: "'Space Mono',monospace", textAlign: "center", color: tipo==="uscita"?"#FF6B6B":tipo==="trasferimento"?"#a78bfa":"#4ECDC4" }} />
        {valuta !== valutaBase && (
          <div style={{ fontSize: 11, color: "#6C5CE7", textAlign: "center", marginTop: 4 }}>
            {t(lang, "aggiungi.convertedPrefix")} {valutaBase} {t(lang, "aggiungi.convertedSuffix")}
          </div>
        )}
        {isComputed && (
          <div style={{ fontSize: 12, color: "#6C5CE7", textAlign: "center", marginTop: 4, fontFamily: "'Space Mono',monospace" }}>
            = {formattaValuta(computedImporto)}
          </div>
        )}
        {/* Calculator keypad */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6 }}>
            {["+", "-", "*", "/"].map(op => (
              <button key={op} onClick={(e) => { e.preventDefault(); const newVal = importoRaw + op; setImportoRaw(newVal); setImporto(evalImporto(newVal)); importoInputRef.current?.focus(); }}
                style={{ padding: "10px", background: "#1a1a28", border: "1px solid #252538", borderRadius: 10, color: "#6C5CE7", fontSize: 18, fontWeight: 700, cursor: "pointer" }}>
                {op}
              </button>
            ))}
          </div>
          <button onClick={(e) => { e.preventDefault(); setImportoRaw(String(computedImporto)); setImporto(computedImporto); importoInputRef.current?.focus(); }}
            style={{ padding: "10px", background: "#6C5CE7", border: "none", borderRadius: 10, color: "#fff", fontSize: 18, fontWeight: 700, fontFamily: "'Space Mono',monospace", cursor: "pointer" }}>
            = {formattaValuta(computedImporto)}
          </button>
        </div>
      </div>
      {tipo === "uscita" && (
        <>
          <div style={{ marginBottom: 18 }}>
            <label style={labelStyle}>{t(lang, "home.filterCategory")}</label>
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
          <SplitSelector pagatoDa={pagatoDa} setPagatoDa={setPagatoDa} splits={splits} setSplits={setSplits} persone={persone} importo={importo} extraPersone={extraPersone} setExtraPersone={setExtraPersone} lang={lang} />
        </>
      )}
      {tipo === "entrata" && (
        <div style={{ marginBottom: 18 }}>
          <label style={labelStyle}>{t(lang, "form.whoseIncome")}</label>
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
        <label style={labelStyle}>{t(lang, "aggiungi.descriptionOptional")}</label>
        <input
          type="text"
          value={descrizione}
          onChange={e => { setDescrizione(e.target.value); setSuggestOpen(true); }}
          onFocus={() => setSuggestOpen(true)}
          onBlur={() => setTimeout(() => setSuggestOpen(false), 150)}
          placeholder={t(lang, "aggiungi.descriptionPlaceholder")}
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
        <label style={labelStyle}>{t(lang, "form.date")}</label>
        <input type="date" value={data} onChange={e => setData(e.target.value)} style={{ ...inputStyle, colorScheme: "dark" }} />
      </div>
      {tipo === "trasferimento" && (
        <div style={{ marginBottom: 24 }}>
          <label style={labelStyle}>{t(lang, "aggiungi.fromAccount")}</label>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
            {conti.map(c => (
              <button key={c.id} onClick={() => setContoDa(c.id)} style={{
                padding: "8px 12px", borderRadius: 10, cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "'DM Sans',sans-serif",
                background: contoDa === c.id ? "#FF6B6B22" : "#1a1a28",
                border: contoDa === c.id ? "1px solid #FF6B6B" : "1px solid #252538",
                color: contoDa === c.id ? "#FF6B6B" : "#888",
              }}>{c.icona} {c.nome}</button>
            ))}
          </div>
          <label style={labelStyle}>{t(lang, "aggiungi.toAccount")}</label>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {conti.map(c => (
              <button key={c.id} onClick={() => setContoA(c.id)} disabled={c.id === contoDa} style={{
                padding: "8px 12px", borderRadius: 10, cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "'DM Sans',sans-serif",
                background: contoA === c.id ? "#4ECDC422" : "#1a1a28",
                border: contoA === c.id ? "1px solid #4ECDC4" : "1px solid #252538",
                color: c.id === contoDa ? "#333" : contoA === c.id ? "#4ECDC4" : "#888",
                opacity: c.id === contoDa ? 0.4 : 1,
              }}>{c.icona} {c.nome}</button>
            ))}
          </div>
          {contoDa && contoA && contoDa !== contoA && (
            <div style={{ fontSize: 11, color: "#a78bfa", marginTop: 8 }}>
              ⇄ {conti.find(c => c.id === contoDa)?.nome} → {conti.find(c => c.id === contoA)?.nome}
            </div>
          )}
        </div>
      )}
      {conti.length > 0 && tipo !== "trasferimento" && (
        <div style={{ marginBottom: 24 }}>
          <label style={labelStyle}>{t(lang, "home.filterAccount")}</label>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button onClick={() => setContoId("")} style={{
              padding: "8px 12px", borderRadius: 10, cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "'DM Sans',sans-serif",
              background: contoId === "" ? "#6C5CE722" : "#1a1a28",
              border: contoId === "" ? "1px solid #6C5CE7" : "1px solid #252538",
              color: contoId === "" ? "#a78bfa" : "#666",
            }}>{t(lang, "form.none")}</button>
            {conti.map(c => (
              <button key={c.id} onClick={() => setContoId(c.id)} style={{
                padding: "8px 12px", borderRadius: 10, cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "'DM Sans',sans-serif",
                background: contoId === c.id ? "#6C5CE722" : "#1a1a28",
                border: contoId === c.id ? "1px solid #6C5CE7" : "1px solid #252538",
                color: contoId === c.id ? "#a78bfa" : "#888",
              }}>{c.icona} {c.nome}</button>
            ))}
          </div>
        </div>
      )}
      {tipo !== "trasferimento" && <div style={{ marginBottom: 24 }}>
        <label style={labelStyle}>{t(lang, "aggiungi.repeat")}</label>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {RICORRENZA_IDS.map(id => (
            <button key={id} onClick={() => setRicorrenza(id)} style={{
              padding: "8px 14px", borderRadius: 20, cursor: "pointer", fontSize: 12, fontWeight: 600,
              fontFamily: "'DM Sans',sans-serif",
              background: ricorrenza === id ? "#6C5CE722" : "#1a1a28",
              border: ricorrenza === id ? "2px solid #6C5CE7" : "2px solid #252538",
              color: ricorrenza === id ? "#a78bfa" : "#666",
              transition: "all 0.15s",
            }}>{t(lang, `recur.${id}`)}</button>
          ))}
        </div>
        {ricorrenza !== "no" && (
          <>
            <div style={{ fontSize: 11, color: "#6C5CE7", marginTop: 8 }}>
              {t(lang, "aggiungi.nextOccurrence")} {calcolaProssimaData(data, ricorrenza)}
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, cursor: "pointer" }}>
              <input type="checkbox" checked={importoVariabile} onChange={e => setImportoVariabile(e.target.checked)} style={{ width: 16, height: 16, accentColor: "#6C5CE7" }} />
              <span style={{ fontSize: 12, color: "#999" }}>{t(lang, "aggiungi.variableAmountFull")}</span>
            </label>
          </>
        )}
      </div>}
      <button onClick={handleSubmit} style={{
        width: "100%", padding: "16px", border: "none", borderRadius: 16, cursor: "pointer",
        fontSize: 16, fontWeight: 700,
        background: tipo==="uscita"?"linear-gradient(135deg,#FF6B6B,#ee5a5a)":tipo==="trasferimento"?"linear-gradient(135deg,#6C5CE7,#a855f7)":"linear-gradient(135deg,#4ECDC4,#3ab8b0)",
        color: "#fff", boxShadow: tipo==="uscita"?"0 4px 20px #FF6B6B44":"0 4px 20px #4ECDC444",
      }}>{salvato ? t(lang, "form.saved") : tipo === "trasferimento" ? t(lang, "aggiungi.transferSubmit") : t(lang, "aggiungi.saveTransaction")}</button>
    </div>
  );
}

// ─── Viaggi (Trips) View ───
function ViaggiView({ persone, lang = "it" }) {
  const [trips, setTrips] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [selectedTrip, setSelectedTrip] = useState(null);
  const defaultTripCats = [
    { id: "trasporto", emoji: "✈️", nome: t(lang, "tripcat.trasporto"), colore: "#74B9FF" },
    { id: "alloggio", emoji: "🏨", nome: t(lang, "tripcat.alloggio"), colore: "#A29BFE" },
    { id: "cibo", emoji: "🍝", nome: t(lang, "cat.cibo"), colore: "#55EFC4" },
    { id: "attivita", emoji: "🎡", nome: t(lang, "tripcat.attivita"), colore: "#FDCB6E" },
    { id: "shopping", emoji: "🛍️", nome: t(lang, "cat.shopping"), colore: "#FF7675" },
    { id: "altro", emoji: "📦", nome: t(lang, "cat.altro"), colore: "#A8A8A8" },
  ];
  // Categorie sincronizzate sulla casa; localStorage resta come cache/fallback offline
  const [tripCats, setTripCats] = useState(() => {
    try {
      const saved = localStorage.getItem("tripCategories");
      return saved ? JSON.parse(saved) : defaultTripCats;
    } catch { return defaultTripCats; }
  });

  useEffect(() => {
    (async () => {
      const remote = await fetchTripCategories();
      if (remote && remote.length > 0) {
        setTripCats(remote);
        try { localStorage.setItem("tripCategories", JSON.stringify(remote)); } catch {}
      } else {
        // Migrazione one-shot: il server non ha ancora nulla, spingiamo le locali
        try {
          const saved = localStorage.getItem("tripCategories");
          if (saved) await saveTripCategories(JSON.parse(saved));
        } catch {}
      }
    })();
  }, []);

  const [nome, setNome] = useState("");
  const [descrizione, setDescrizione] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [partecipanti, setPartecipanti] = useState([]);
  const [newPersonName, setNewPersonName] = useState("");

  const [settlingTrip, setSettlingTrip] = useState(null);
  const [settleFrom, setSettleFrom] = useState("");
  const [settleTo, setSettleTo] = useState("");
  const [settleAmount, setSettleAmount] = useState("");
  const [expandedExpenses, setExpandedExpenses] = useState({});

  function toggleExpenses(tripId) {
    setExpandedExpenses(prev => ({ ...prev, [tripId]: !prev[tripId] }));
  }

  const [shareBusyId, setShareBusyId] = useState(null);

  async function handleShareTrip(tripId) {
    setShareBusyId(tripId);
    try {
      const token = await createTripShareLink(tripId);
      setTrips(prev => prev.map(t => t.id === tripId ? { ...t, shareToken: token } : t));
      const url = `${window.location.origin}${window.location.pathname}?viaggio=${token}`;
      await navigator.clipboard?.writeText(url).catch(() => {});
      toast(t(lang, "viaggi.linkCopied"), "success");
    } catch (e) { toast(`${t(lang, "toast.errorPrefix")} ${e.message}`, "error"); }
    setShareBusyId(null);
  }

  async function handleRevokeShare(tripId) {
    if (!confirm(t(lang, "viaggi.confirmRevoke"))) return;
    setShareBusyId(tripId);
    try {
      await revokeTripShareLink(tripId);
      setTrips(prev => prev.map(t => t.id === tripId ? { ...t, shareToken: undefined } : t));
      toast(t(lang, "viaggi.linkRevoked"), "success");
    } catch (e) { toast(`${t(lang, "toast.errorPrefix")} ${e.message}`, "error"); }
    setShareBusyId(null);
  }

  function handleCopyShareLink(token) {
    const url = `${window.location.origin}${window.location.pathname}?viaggio=${token}`;
    navigator.clipboard?.writeText(url);
    toast(t(lang, "viaggi.linkCopiedShort"), "success");
  }

  const [showCatManager, setShowCatManager] = useState(false);
  const [editingCatId, setEditingCatId] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [showNewCat, setShowNewCat] = useState(false);
  const [newCat, setNewCat] = useState({ emoji: "📦", nome: "", colore: "#A8A8A8" });

  useEffect(() => { loadTrips(); }, []);

  async function saveTripCats(cats) {
    setTripCats(cats);
    try { localStorage.setItem("tripCategories", JSON.stringify(cats)); } catch {}
    const ok = await saveTripCategories(cats);
    if (!ok) toast(t(lang, "toast.categoriesLocalOnly"), "error");
  }

  async function loadTrips() {
    try { setTrips(await fetchTrips()); } catch (e) { console.error(e); }
    setLoading(false);
  }

  async function handleAddTrip() {
    if (!nome.trim()) return;
    const allPars = [...persone.map(p => ({ id: p.id, nome: p.nome, emoji: p.emoji, colore: p.colore })), ...partecipanti];
    const trip = await addTrip({ nome: nome.trim(), descrizione: descrizione.trim(), startDate, endDate, partecipanti: allPars });
    setTrips([trip, ...trips]);
    setNome(""); setDescrizione(""); setStartDate(""); setEndDate(""); setPartecipanti([]); setShowAdd(false);
  }

  async function handleDeleteTrip(id) {
    if (!confirm(t(lang, "viaggi.confirmDeleteTrip"))) return;
    try {
      await deleteTrip(id);
      setTrips(trips.filter(t => t.id !== id));
    } catch (e) {
      toast(`${t(lang, "toast.errorDeletePrefix")} ${e.message}`, "error");
    }
  }

  async function handleAddExpense(tripId, expense) {
    const exp = await addTripExpense(tripId, expense);
    setTrips(trips.map(t => t.id === tripId ? { ...t, expenses: [...t.expenses, exp] } : t));
  }

  async function handleDeleteExpense(tripId, expId) {
    await deleteTripExpense(tripId, expId);
    setTrips(trips.map(t => t.id === tripId ? { ...t, expenses: t.expenses.filter(e => e.id !== expId) } : t));
  }

  const [settlingId, setSettlingId] = useState(null);

  async function handleMarkSettled(trip, settlements) {
    const nameOf = (id) => (trip.partecipanti || []).find(p => p.id === id)?.nome || id;
    const riepilogo = settlements.map(s => `${nameOf(s.da)} → ${nameOf(s.a)}: ${formattaValuta(s.importo)}`).join("\n");
    if (!confirm(`${t(lang, "viaggi.confirmSettlePrefix")} "${trip.nome}" ${t(lang, "viaggi.confirmSettleSuffix")}\n${riepilogo}`)) return;
    setSettlingId(trip.id);
    try {
      const oggi = new Date().toISOString().slice(0, 10);
      for (const s of settlements) {
        await addTransaction({
          tipo: "saldo",
          importo: s.importo,
          categoria: "saldo_viaggio",
          descrizione: `Saldo viaggio: ${trip.nome} (${nameOf(s.da)} → ${nameOf(s.a)})`,
          data: oggi,
          pagatoDa: s.da,
          ricevutoDa: s.a,
        });
      }
      await updateTrip(trip.id, { settled: true });
      setTrips(trips.map(t => t.id === trip.id ? { ...t, settled: true } : t));
    } catch (e) {
      toast(`${t(lang, "toast.errorSavePrefix")} ${e.message}`, "error");
    }
    setSettlingId(null);
  }

  function addGuest() {
    if (!newPersonName.trim()) return;
    const colors = ["#E17055", "#74B9FF", "#55EFC4", "#FDCB6E", "#A29BFE", "#FF7675", "#00CEC9"];
    const p = { id: newPersonName.trim().toLowerCase().replace(/\s+/g, "_"), nome: newPersonName.trim(), emoji: "👤", colore: colors[partecipanti.length % colors.length] };
    setPartecipanti([...partecipanti, p]);
    setNewPersonName("");
  }

  function handleSaveTripCat(id) {
    const updated = tripCats.map(c => c.id === id ? { ...c, ...editForm } : c);
    saveTripCats(updated);
    setEditingCatId(null);
  }
  function handleDeleteTripCat(id) {
    const updated = tripCats.filter(c => c.id !== id);
    saveTripCats(updated);
  }
  function handleAddTripCat() {
    if (!newCat.nome.trim()) return;
    const newId = newCat.nome.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "") + "_" + Date.now().toString(36);
    const without = tripCats.filter(c => c.id !== "altro");
    const altro = tripCats.find(c => c.id === "altro");
    const updated = [...without, { ...newCat, id: newId }, ...(altro ? [altro] : [])];
    saveTripCats(updated);
    setShowNewCat(false);
    setNewCat({ emoji: "📦", nome: "", colore: "#A8A8A8" });
  }

  const calculateSettle = calcolaSettleViaggio;

  const allColors = ["#E17055", "#74B9FF", "#55EFC4", "#FDCB6E", "#A29BFE", "#FF7675", "#00CEC9", "#FAB1A0"];
  const tripColors = {};

  if (loading) return <div style={{ padding: 40, textAlign: "center", color: "#888" }}>{t(lang, "viaggi.loading")}</div>;

  return (
    <div style={{ padding: "20px 16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div style={{ fontSize: 22, fontWeight: 800, color: "#eee" }}>{t(lang, "viaggi.title")}</div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => setShowCatManager(!showCatManager)} style={{ background: "none", border: "none", cursor: "pointer", color: showCatManager ? "#6C5CE7" : "#888", fontSize: 16, padding: "4px 8px" }}>⚙</button>
          <button onClick={() => setShowAdd(!showAdd)} style={{ background: showAdd ? "#6C5CE722" : "none", border: showAdd ? "1px solid #6C5CE7" : "1px solid #252538", borderRadius: 10, cursor: "pointer", color: showAdd ? "#6C5CE7" : "#888", fontSize: 18, padding: "4px 12px" }}>{showAdd ? "✕" : "+"}</button>
        </div>
      </div>

      {showCatManager && (
        <div style={{ background: "#1a1a28", borderRadius: 16, padding: 16, marginBottom: 20, border: "2px solid #6C5CE7" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#eee", marginBottom: 14 }}>{t(lang, "viaggi.categories")}</div>
          {tripCats.map(c => (
            <div key={c.id}>
              {editingCatId === c.id ? (
                <div style={{ padding: "10px 0", borderBottom: "1px solid #252538" }}>
                  <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
                    <input value={editForm.emoji || c.emoji} onChange={e => setEditForm(f => ({ ...f, emoji: e.target.value }))}
                      style={{ ...inputStyle, width: 52, textAlign: "center", fontSize: 18, padding: "8px 4px" }} />
                    <input value={editForm.nome || c.nome} onChange={e => setEditForm(f => ({ ...f, nome: e.target.value }))}
                      placeholder={t(lang, "viaggi.categoryNamePlaceholder")} style={{ ...inputStyle, flex: 1, padding: "8px 10px" }} />
                    <input type="color" value={editForm.colore || c.colore} onChange={e => setEditForm(f => ({ ...f, colore: e.target.value }))}
                      style={{ width: 36, height: 36, border: "none", background: "none", cursor: "pointer", padding: 2 }} />
                  </div>
                  <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                    <button onClick={() => setEditingCatId(null)} style={{ padding: "6px 12px", background: "transparent", border: "1px solid #444", borderRadius: 8, color: "#888", fontSize: 12, cursor: "pointer" }}>{t(lang, "common.cancel")}</button>
                    <button onClick={() => handleSaveTripCat(c.id)} style={{ padding: "6px 12px", background: "#6C5CE7", border: "none", borderRadius: 8, color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>{t(lang, "common.save")}</button>
                  </div>
                </div>
              ) : (
                <div style={{ display: "flex", alignItems: "center", padding: "10px 0", borderBottom: "1px solid #252538" }}>
                  <span style={{ fontSize: 16, marginRight: 8 }}>{c.emoji}</span>
                  <span style={{ flex: 1, color: "#ccc", fontSize: 14 }}>{c.nome}</span>
                  <div style={{ width: 16, height: 16, borderRadius: 4, background: c.colore, marginRight: 8 }} />
                  <button onClick={() => { setEditingCatId(c.id); setEditForm(c); }} style={{ background: "none", border: "none", color: "#666", cursor: "pointer", fontSize: 14, padding: "4px 8px" }}>✏</button>
                  <button onClick={() => handleDeleteTripCat(c.id)} style={{ background: "none", border: "none", color: "#FF6B6B", cursor: "pointer", fontSize: 14, padding: "4px 8px" }}>×</button>
                </div>
              )}
            </div>
          ))}
          {showNewCat ? (
            <div style={{ padding: "10px 0" }}>
              <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
                <input value={newCat.emoji} onChange={e => setNewCat(c => ({ ...c, emoji: e.target.value }))}
                  style={{ ...inputStyle, width: 52, textAlign: "center", fontSize: 18, padding: "8px 4px" }} />
                <input value={newCat.nome} onChange={e => setNewCat(c => ({ ...c, nome: e.target.value }))}
                  placeholder={t(lang, "viaggi.newCategoryPlaceholder")} style={{ ...inputStyle, flex: 1, padding: "8px 10px" }} />
                <input type="color" value={newCat.colore} onChange={e => setNewCat(c => ({ ...c, colore: e.target.value }))}
                  style={{ width: 36, height: 36, border: "none", background: "none", cursor: "pointer", padding: 2 }} />
              </div>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button onClick={() => setShowNewCat(false)} style={{ padding: "6px 12px", background: "transparent", border: "1px solid #444", borderRadius: 8, color: "#888", fontSize: 12, cursor: "pointer" }}>{t(lang, "common.cancel")}</button>
                <button onClick={handleAddTripCat} style={{ padding: "6px 12px", background: "#6C5CE7", border: "none", borderRadius: 8, color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>{t(lang, "common.add")}</button>
              </div>
            </div>
          ) : (
            <button onClick={() => setShowNewCat(true)} style={{ marginTop: 12, width: "100%", padding: "10px", background: "transparent", border: "1px dashed #333", borderRadius: 10, color: "#666", fontSize: 13, cursor: "pointer" }}>{t(lang, "settings.newCategory")}</button>
          )}
        </div>
      )}

      {showAdd && (
        <div style={{ background: "#1a1a28", borderRadius: 16, padding: 16, marginBottom: 20, border: "2px solid #6C5CE7" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#eee", marginBottom: 12, fontFamily: "'DM Sans',sans-serif" }}>{t(lang, "viaggi.newTrip")}</div>
          <input type="text" value={nome} onChange={e => setNome(e.target.value)} placeholder={t(lang, "viaggi.tripNamePlaceholder")} style={{ ...inputStyle, marginBottom: 10 }} />
          <input type="text" value={descrizione} onChange={e => setDescrizione(e.target.value)} placeholder={t(lang, "viaggi.descriptionPlaceholder")} style={{ ...inputStyle, marginBottom: 10 }} />
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} placeholder={t(lang, "viaggi.from")} style={{ ...inputStyle, flex: 1 }} />
            <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} placeholder={t(lang, "viaggi.to")} style={{ ...inputStyle, flex: 1 }} />
          </div>
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 11, color: "#888", marginBottom: 6 }}>{t(lang, "viaggi.extraParticipantsPrefix")} {persone.length} {t(lang, "viaggi.extraParticipantsSuffix")}</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {[...persone.map(p => ({ ...p, isMembro: true })), ...partecipanti].map(p => (
                <div key={p.id} style={{ padding: "6px 10px", borderRadius: 10, background: p.colore + "22", border: `1px solid ${p.colore}55`, color: p.colore, fontSize: 12, fontFamily: "'DM Sans',sans-serif" }}>
                  {p.emoji} {p.nome}
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <input type="text" value={newPersonName} onChange={e => setNewPersonName(e.target.value)} placeholder={t(lang, "viaggi.guestNamePlaceholder")} onKeyDown={e => e.key === "Enter" && addGuest()} style={{ ...inputStyle, flex: 1 }} />
              <button onClick={addGuest} style={{ padding: "8px 14px", background: "#6C5CE7", border: "none", borderRadius: 10, color: "#fff", fontSize: 12, fontWeight: 700, fontFamily: "'DM Sans',sans-serif" }}>{t(lang, "common.add")}</button>
            </div>
          </div>
          <button onClick={handleAddTrip} disabled={!nome.trim()} style={{ width: "100%", padding: "12px", background: nome.trim() ? "#6C5CE7" : "#252538", border: "none", borderRadius: 12, color: "#fff", fontSize: 14, fontWeight: 700, fontFamily: "'DM Sans',sans-serif", cursor: nome.trim() ? "pointer" : "default" }}>{t(lang, "viaggi.createTrip")}</button>
        </div>
      )}

      {trips.length === 0 ? (
        <div style={{ color: "#555", textAlign: "center", padding: 40 }}>{t(lang, "viaggi.noTrips")}<br/>{t(lang, "viaggi.tapToCreate")}</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {trips.map(trip => {
            const allP = trip.partecipanti || [];
            tripColors[trip.id] = tripColors[trip.id] || {};
            allP.forEach((p, i) => { tripColors[trip.id][p.id] = allColors[i % allColors.length]; });
            const nameOf = (id) => allP.find(p => p.id === id)?.nome || id;
            const total = trip.expenses?.reduce((s, e) => s + e.importo, 0) || 0;
            const settlements = calculateSettle(trip);
            const isSettling = settlingTrip === trip.id;

            return (
              <div key={trip.id} style={{ background: "#1a1a28", borderRadius: 16, padding: 16, border: "1px solid #252538" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 16, fontWeight: 700, color: "#eee", fontFamily: "'DM Sans',sans-serif" }}>
                      {trip.nome}
                      {trip.settled && <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, color: "#55EFC4", background: "#55EFC422", border: "1px solid #55EFC455", borderRadius: 6, padding: "2px 8px", verticalAlign: "middle" }}>{trip.autoSettled ? t(lang, "viaggi.autoSettled") : t(lang, "viaggi.settled")}</span>}
                    </div>
                    <div style={{ fontSize: 12, color: "#666", fontFamily: "'DM Sans',sans-serif" }}>{trip.descrizione}</div>
                    <div style={{ fontSize: 11, color: "#555", marginTop: 4, fontFamily: "'DM Sans',sans-serif" }}>
                      {trip.startDate && trip.endDate ? `${trip.startDate} → ${trip.endDate}` : trip.startDate || trip.endDate || ""}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
                    {!trip.settled && (
                      trip.shareToken ? (
                        <button onClick={() => handleCopyShareLink(trip.shareToken)} title={t(lang, "viaggi.copyInviteLink")} style={{ background: "#6C5CE722", border: "1px solid #6C5CE7", borderRadius: 8, color: "#a78bfa", cursor: "pointer", fontSize: 11, fontWeight: 700, padding: "6px 8px" }}>🔗</button>
                      ) : (
                        <button onClick={() => handleShareTrip(trip.id)} disabled={shareBusyId === trip.id} title={t(lang, "viaggi.inviteSomeone")} style={{ background: "none", border: "1px solid #252538", borderRadius: 8, color: "#888", cursor: shareBusyId === trip.id ? "default" : "pointer", fontSize: 11, fontWeight: 700, padding: "6px 8px" }}>🔗</button>
                      )
                    )}
                    <button onClick={() => handleDeleteTrip(trip.id)} style={{ background: "none", border: "none", color: "#FF6B6B", cursor: "pointer", fontSize: 18 }}>×</button>
                  </div>
                </div>

                {trip.shareToken && !trip.settled && (
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "#111119", border: "1px solid #252538", borderRadius: 10, padding: "8px 10px", marginBottom: 10 }}>
                    <span style={{ fontSize: 11, color: "#888", fontFamily: "'DM Sans',sans-serif" }}>{t(lang, "viaggi.inviteActive")}</span>
                    <button onClick={() => handleRevokeShare(trip.id)} disabled={shareBusyId === trip.id} style={{ background: "none", border: "none", color: "#FF6B6B", fontSize: 11, fontWeight: 700, cursor: shareBusyId === trip.id ? "default" : "pointer", fontFamily: "'DM Sans',sans-serif" }}>{t(lang, "viaggi.revoke")}</button>
                  </div>
                )}

                <div style={{ marginBottom: 10 }}>
                  <span style={{ fontSize: 14, fontWeight: 700, fontFamily: "'Space Mono',monospace", color: "#a78bfa" }}>{formattaValuta(total)}</span>
                  <span style={{ fontSize: 11, color: "#666", marginLeft: 6, fontFamily: "'DM Sans',sans-serif" }}>({trip.expenses?.length || 0} {t(lang, "viaggi.expenses")})</span>
                </div>

                {!trip.settled && settlements.length > 0 && (
                  <div style={{ background: "#111119", borderRadius: 12, padding: 12, marginBottom: 10 }}>
                    <div style={{ fontSize: 11, color: "#888", marginBottom: 8, fontFamily: "'DM Sans',sans-serif" }}>{t(lang, "viaggi.toSettle")}</div>
                    {settlements.map((s, i) => (
                      <div key={i} style={{ fontSize: 12, marginBottom: 4, fontFamily: "'DM Sans',sans-serif" }}>
                        <span style={{ color: tripColors[trip.id][s.da] }}>{nameOf(s.da)}</span> → <span style={{ color: tripColors[trip.id][s.a] }}>{nameOf(s.a)}</span>: <span style={{ fontFamily: "'Space Mono',monospace" }}>{formattaValuta(s.importo)}</span>
                      </div>
                    ))}
                    <button onClick={() => handleMarkSettled(trip, settlements)} disabled={settlingId === trip.id}
                      style={{ width: "100%", marginTop: 8, padding: "10px", background: settlingId === trip.id ? "#252538" : "#55EFC422", border: "1px solid #55EFC455", borderRadius: 10, color: "#55EFC4", fontSize: 12, fontWeight: 700, fontFamily: "'DM Sans',sans-serif", cursor: settlingId === trip.id ? "default" : "pointer" }}>
                      {settlingId === trip.id ? t(lang, "viaggi.saving") : t(lang, "viaggi.markSettled")}
                    </button>
                  </div>
                )}

                {trip.expenses && trip.expenses.length > 0 && (
                  <div style={{ marginBottom: 10 }}>
                    <button onClick={() => toggleExpenses(trip.id)} style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", background: "#111119", border: "1px solid #252538", borderRadius: 10, padding: "10px 12px", cursor: "pointer", marginBottom: expandedExpenses[trip.id] ? 6 : 0 }}>
                      <span style={{ fontSize: 12, color: "#888", fontFamily: "'DM Sans',sans-serif" }}>{t(lang, "viaggi.expenses")} ({trip.expenses.length})</span>
                      <span style={{ fontSize: 11, color: "#6C5CE7", transform: expandedExpenses[trip.id] ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.2s ease", display: "inline-block" }}>▼</span>
                    </button>
                    {expandedExpenses[trip.id] && trip.expenses.map((e, i) => (
                      <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid #252538", fontFamily: "'DM Sans',sans-serif" }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 13, color: "#ccc" }}>{e.descrizione || t(lang, "viaggi.expenseFallback")}</div>
                          <div style={{ fontSize: 11, color: "#666" }}>{e.categoria} · {e.pagatoDa}</div>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <div style={{ fontSize: 13, fontFamily: "'Space Mono',monospace", color: "#a78bfa" }}>{formattaValuta(e.importo)}</div>
                          {!trip.settled && <button onClick={() => handleDeleteExpense(trip.id, e.id)} style={{ background: "none", border: "none", color: "#FF6B6B", cursor: "pointer", fontSize: 14 }}>×</button>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {!trip.settled && <TripExpenseForm trip={trip} onAdd={exp => handleAddExpense(trip.id, exp)} categorie={tripCats} lang={lang} />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TripExpenseForm({ trip, onAdd, categorie, lang = "it" }) {
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
    <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid #252538" }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <input type="number" inputMode="decimal" value={importo} onChange={e => setImporto(e.target.value)} placeholder="€" style={{ ...inputStyle, flex: 1, fontFamily: "'Space Mono',monospace" }} />
        <select value={pagatoDa} onChange={e => setPagatoDa(e.target.value)} style={{ ...inputStyle, flex: 1, fontFamily: "'DM Sans',sans-serif" }}>
          {allPars.map(p => <option key={p.id} value={p.id}>{p.nome}</option>)}
        </select>
      </div>
      <input type="text" value={descrizione} onChange={e => setDescrizione(e.target.value)} placeholder={t(lang, "viaggi.expenseDescriptionPlaceholder")} style={{ ...inputStyle, marginBottom: 8 }} />
      <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
        {categorie.map(c => (
          <button key={c.id} onClick={() => setCategoria(c.id)} style={{ padding: "6px 10px", borderRadius: 8, border: categoria === c.id ? `2px solid ${c.colore}` : "1px solid #252538", background: categoria === c.id ? c.colore + "22" : "#1a1a28", color: categoria === c.id ? c.colore : "#666", fontSize: 11, fontFamily: "'DM Sans',sans-serif", cursor: "pointer" }}>
            {c.emoji} {c.nome}
          </button>
        ))}
      </div>
      <button onClick={handleAdd} disabled={!importo} style={{ width: "100%", padding: "10px", background: importo ? "#6C5CE7" : "#252538", border: "none", borderRadius: 10, color: "#fff", fontSize: 13, fontWeight: 700, fontFamily: "'DM Sans',sans-serif", cursor: importo ? "pointer" : "default" }}>{t(lang, "viaggi.addExpense")}</button>
    </div>
  );
}

// ─── Trip guest view — reached via ?viaggio=<token>, no household PIN required ───
function guestTripDefaultCategorie(lang) {
  return [
    { id: "trasporto", emoji: "✈️", nome: t(lang, "tripcat.trasporto"), colore: "#74B9FF" },
    { id: "alloggio", emoji: "🏨", nome: t(lang, "tripcat.alloggio"), colore: "#A29BFE" },
    { id: "cibo", emoji: "🍝", nome: t(lang, "cat.cibo"), colore: "#55EFC4" },
    { id: "attivita", emoji: "🎡", nome: t(lang, "tripcat.attivita"), colore: "#FDCB6E" },
    { id: "shopping", emoji: "🛍️", nome: t(lang, "cat.shopping"), colore: "#FF7675" },
    { id: "altro", emoji: "📦", nome: t(lang, "cat.altro"), colore: "#A8A8A8" },
  ];
}

function TripGuestView({ token }) {
  const [lang] = useState(() => detectGuestLang());
  const [trip, setTrip] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [me, setMe] = useState(null); // { id, nome } — this guest's identity, remembered locally per token
  const [nomeInput, setNomeInput] = useState("");
  const [joining, setJoining] = useState(false);

  const lsKey = `guest-trip-identity-${token}`;

  async function load() {
    setLoading(true);
    try {
      const data = await fetchSharedTrip(token);
      setTrip(data);
      try {
        const saved = JSON.parse(localStorage.getItem(lsKey) || "null");
        if (saved && (data.partecipanti || []).some(p => p.id === saved.id)) setMe(saved);
      } catch {}
    } catch (e) {
      setError(e.message || t(lang, "guest.invalidLink"));
    }
    setLoading(false);
  }

  useEffect(() => { load(); }, [token]);

  async function handleJoin() {
    if (!nomeInput.trim()) return;
    setJoining(true);
    try {
      const p = await joinSharedTrip(token, nomeInput.trim());
      setMe(p);
      try { localStorage.setItem(lsKey, JSON.stringify(p)); } catch {}
      await load();
    } catch (e) { toast(`${t(lang, "toast.errorPrefix")} ${e.message}`, "error"); }
    setJoining(false);
  }

  if (loading) return <div style={{ padding: 40, textAlign: "center", color: "#666" }}>{t(lang, "viaggi.loading")}</div>;
  if (error || !trip) return (
    <div style={{ padding: 40, textAlign: "center", color: "#FF6B6B" }}>
      {error || t(lang, "guest.invalidLink")}
    </div>
  );

  const nameOf = (id) => (trip.partecipanti || []).find(p => p.id === id)?.nome || id;
  const total = trip.expenses?.reduce((s, e) => s + e.importo, 0) || 0;
  const settlements = calcolaSettleViaggio(trip);

  return (
    <div style={{ maxWidth: 430, margin: "0 auto", minHeight: "100dvh", background: "#111119", color: "#eee", fontFamily: "'DM Sans', sans-serif", padding: "24px 16px" }}>
      <ToastHost />
      <div style={{ fontSize: 11, color: "#6C5CE7", letterSpacing: 1, textTransform: "uppercase", marginBottom: 4 }}>{t(lang, "guest.invitedTo")}</div>
      <div style={{ fontSize: 24, fontWeight: 800, marginBottom: 4 }}>{trip.nome}</div>
      {trip.descrizione && <div style={{ fontSize: 13, color: "#888", marginBottom: 4 }}>{trip.descrizione}</div>}
      <div style={{ fontSize: 12, color: "#555", marginBottom: 20 }}>
        {trip.startDate && trip.endDate ? `${trip.startDate} → ${trip.endDate}` : trip.startDate || trip.endDate || ""}
        {trip.settled && <span style={{ marginLeft: 8, color: "#55EFC4", fontWeight: 700 }}>{t(lang, "guest.closed")}</span>}
      </div>

      {!me && !trip.settled && (
        <div style={{ background: "#1a1a28", borderRadius: 16, padding: 16, border: "1px solid #252538", marginBottom: 20 }}>
          <div style={{ fontSize: 13, color: "#ccc", marginBottom: 10 }}>{t(lang, "guest.whatsYourName")}</div>
          <input type="text" value={nomeInput} onChange={e => setNomeInput(e.target.value)} onKeyDown={e => e.key === "Enter" && handleJoin()}
            placeholder={t(lang, "guest.yourName")} autoFocus style={{ ...inputStyle, marginBottom: 10 }} />
          <button onClick={handleJoin} disabled={!nomeInput.trim() || joining} style={{
            width: "100%", padding: "12px", border: "none", borderRadius: 12,
            background: nomeInput.trim() ? "#6C5CE7" : "#252538", color: "#fff",
            fontSize: 14, fontWeight: 700, cursor: nomeInput.trim() ? "pointer" : "default",
          }}>{joining ? "..." : t(lang, "guest.joinTrip")}</button>
        </div>
      )}

      {!me && trip.settled && (
        <div style={{ fontSize: 12, color: "#666", marginBottom: 20 }}>{t(lang, "guest.tripClosedReadonly")}</div>
      )}

      {me && (
        <div style={{ fontSize: 12, color: "#666", marginBottom: 16 }}>{t(lang, "guest.participatingAs")} <strong style={{ color: "#a78bfa" }}>{me.nome}</strong></div>
      )}

      <div style={{ marginBottom: 16 }}>
        <span style={{ fontSize: 16, fontWeight: 700, fontFamily: "'Space Mono',monospace", color: "#a78bfa" }}>{formattaValuta(total)}</span>
        <span style={{ fontSize: 12, color: "#666", marginLeft: 6 }}>{t(lang, "guest.total")} · {trip.expenses?.length || 0} {t(lang, "viaggi.expenses")}</span>
      </div>

      {settlements.length > 0 && (
        <div style={{ background: "#1a1a28", borderRadius: 14, padding: 14, marginBottom: 16, border: "1px solid #252538" }}>
          <div style={{ fontSize: 11, color: "#888", marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>{trip.settled ? t(lang, "guest.settledLikeThis") : t(lang, "viaggi.toSettle")}</div>
          {settlements.map((s, i) => (
            <div key={i} style={{ fontSize: 13, marginBottom: 4 }}>
              {nameOf(s.da)} → {nameOf(s.a)}: <span style={{ fontFamily: "'Space Mono',monospace" }}>{formattaValuta(s.importo)}</span>
            </div>
          ))}
        </div>
      )}

      {trip.expenses && trip.expenses.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, color: "#888", marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>{t(lang, "guest.expenses")}</div>
          {trip.expenses.map((e, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid #252538" }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, color: "#ccc" }}>{e.descrizione || t(lang, "viaggi.expenseFallback")}</div>
                <div style={{ fontSize: 11, color: "#666" }}>{e.categoria} · {nameOf(e.pagatoDa)}</div>
              </div>
              <div style={{ fontSize: 13, fontFamily: "'Space Mono',monospace", color: "#a78bfa" }}>{formattaValuta(e.importo)}</div>
            </div>
          ))}
        </div>
      )}

      {me && !trip.settled && (
        <GuestExpenseForm trip={trip} me={me} token={token} categorie={guestTripDefaultCategorie(lang)} onAdded={load} lang={lang} />
      )}
    </div>
  );
}

function GuestExpenseForm({ trip, me, token, categorie, onAdded, lang = "it" }) {
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

// ─── Scanner ───

const labelStyle = { display: "block", fontSize: 11, color: "#888", marginBottom: 6, letterSpacing: 0.5, textTransform: "uppercase" };
const inputStyle = { width: "100%", maxWidth: "100%", padding: "14px 16px", background: "#1a1a28", border: "1px solid #252538", borderRadius: 14, color: "#eee", fontSize: 15, fontFamily: "'DM Sans',sans-serif", outline: "none", boxSizing: "border-box", WebkitAppearance: "none" };

// ─── Stats ───
function StatsView({ transazioni, persone, meseOffset, categorie, goals, lang = "it" }) {
  const oggi = new Date();
  const meseVis = new Date(oggi.getFullYear(), oggi.getMonth() - meseOffset, 1);
  const nomeMese = mese(meseVis.getMonth()) + " " + meseVis.getFullYear();
  const txMese = transazioni.filter(t => { const d=new Date(t.data); return d.getMonth()===meseVis.getMonth()&&d.getFullYear()===meseVis.getFullYear(); });
  const usciteMese = txMese.filter(t => t.tipo === "uscita");
  const totalUscite = usciteMese.reduce((s,t) => s+t.importo, 0);
  const totalEntrate = txMese.filter(t=>t.tipo==="entrata").reduce((s,t)=>s+t.importo,0)
    + txMese.filter(t=>t.tipo==="saldo"&&!persone.some(p=>p.id===t.pagatoDa)).reduce((s,t)=>s+t.importo,0);
  const perCategoria = categorie.map(cat=>({...cat,valore:usciteMese.filter(t=>t.categoria===cat.id).reduce((s,t)=>s+t.importo,0)})).filter(c=>c.valore>0).sort((a,b)=>b.valore-a.valore);
  const ultimi6 = Array.from({length:6},(_,i)=>{const m=new Date(oggi.getFullYear(),oggi.getMonth()-(5-i),1);return{label:mese(m.getMonth()),valore:transazioni.filter(t=>t.tipo==="uscita"&&new Date(t.data).getMonth()===m.getMonth()&&new Date(t.data).getFullYear()===m.getFullYear()).reduce((s,t)=>s+t.importo,0),colore:"#6C5CE7"};});
  const spesoPerPersona = persone.map(p => ({
    ...p,
    speso: usciteMese.filter(t => t.pagatoDa === p.id).reduce((s, t) => s + t.importo, 0),
  }));
  const debitiMese = calcolaDebitiMatrix(txMese.filter(t => t.tipo !== "saldo"), persone); // saldi esclusi: pagano debiti di mesi precedenti e creerebbero debiti inversi fittizi nella vista mensile

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
    if (deltaPct > 15) insights.push({ icon: "📈", color: "#FF6B6B", text: `${t(lang, "stats.expensesUpPrefix")} ${Math.round(deltaPct)}% ${t(lang, "stats.comparedTo")} ${mese(mesePrecedente.getMonth(), lang)}` });
    else if (deltaPct < -15) insights.push({ icon: "📉", color: "#4ECDC4", text: `${t(lang, "stats.expensesDownPrefix")} ${Math.round(Math.abs(deltaPct))}% ${t(lang, "stats.comparedTo")} ${mese(mesePrecedente.getMonth(), lang)}` });
    else insights.push({ icon: "➡️", color: "#F0A500", text: `${t(lang, "stats.expensesStablePrefix")} ${mese(mesePrecedente.getMonth(), lang)} (${deltaPct >= 0 ? "+" : ""}${Math.round(deltaPct)}%)` });
  }
  if (savingRate > 20) insights.push({ icon: "💪", color: "#4ECDC4", text: `${t(lang, "stats.savingRateLabel")}: ${Math.round(savingRate)}% ${t(lang, "stats.excellentSuffix")}` });
  else if (savingRate > 0) insights.push({ icon: "💡", color: "#F0A500", text: `${t(lang, "stats.savingRateLabel")}: ${Math.round(savingRate)}%` });
  else if (totalEntrate > 0) insights.push({ icon: "⚠️", color: "#FF6B6B", text: t(lang, "stats.spendingMoreThanEarn") });
  if (maxTx) {
    const maxCat = categorie.find(c=>c.id===maxTx.categoria);
    insights.push({ icon: "🏷️", color: "#DDA0DD", text: `${t(lang, "stats.biggestExpense")}: ${formattaValuta(maxTx.importo)} — ${maxTx.descrizione || maxCat?.nome || ""}` });
  }
  if (topDay.totale > 0) insights.push({ icon: "📅", color: "#45B7D1", text: `${t(lang, "stats.mostExpensiveDay")}: ${topDay.giorno} ${mese(meseVis.getMonth(), lang)} (${formattaValuta(topDay.totale)})` });
  const catUp = catTrends.find(c => c.delta > 30 && c.curr > 20);
  const catDown = catTrends.find(c => c.delta < -30 && c.prev > 20);
  if (catUp) insights.push({ icon: catUp.emoji, color: catUp.colore, text: `${catUp.nome} +${Math.round(catUp.delta)}% ${t(lang, "stats.vsLastMonth")} (${formattaValuta(catUp.curr)})` });
  if (catDown) insights.push({ icon: catDown.emoji, color: catDown.colore, text: `${catDown.nome} ${Math.round(catDown.delta)}% ${t(lang, "stats.vsLastMonth")} (${formattaValuta(catDown.curr)})` });
  if (mediaGiornaliera > 0) insights.push({ icon: "📊", color: "#6C5CE7", text: `${t(lang, "stats.dailyAverage")}: ${formattaValuta(mediaGiornaliera)}/${t(lang, "stats.perDay")}` });

  return (
    <div>
      <div style={{ padding: "14px 16px 20px" }}>
      <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
        <div style={{ flex: 1, background: "#1a1a28", borderRadius: 16, padding: "16px 14px", border: "1px solid #252538" }}>
          <div style={{ fontSize: 10, color: "#6a6", letterSpacing: 0.5, textTransform: "uppercase" }}>{t(lang, "stats.income")}</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: "#4ECDC4", fontFamily: "'Space Mono',monospace", marginTop: 4 }}>{formattaValuta(totalEntrate)}</div>
        </div>
        <div style={{ flex: 1, background: "#1a1a28", borderRadius: 16, padding: "16px 14px", border: "1px solid #252538" }}>
          <div style={{ fontSize: 10, color: "#a66", letterSpacing: 0.5, textTransform: "uppercase" }}>{t(lang, "stats.expenses")}</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: "#FF6B6B", fontFamily: "'Space Mono',monospace", marginTop: 4 }}>{formattaValuta(totalUscite)}</div>
        </div>
      </div>
      {spesoPerPersona.some(p => p.speso > 0) && (
        <div style={{ background: "#1a1a28", borderRadius: 16, padding: "14px 16px", marginBottom: 16, border: "1px solid #252538" }}>
          <div style={{ fontSize: 11, color: "#999", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 10 }}>{t(lang, "stats.whoPaid")}</div>
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
                    <span>{pDa.emoji} {pDa.nome} {t(lang, "stats.owes")} <strong style={{ color: pA.colore }}>{formattaValuta(d.importo)}</strong> {t(lang, "stats.owesToConnector")} {pA.nome}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
      {perCategoria.length > 0 && (
        <div style={{ background: "#1a1a28", borderRadius: 20, padding: 20, marginBottom: 24, border: "1px solid #252538" }}>
          <div style={{ fontSize: 12, color: "#999", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 16 }}>{t(lang, "stats.expensesByCategory")}</div>
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
          <div style={{ fontSize: 12, color: "#999", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 16 }}>{t(lang, "home.savingsGoals")}</div>
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
                    <div style={{ fontSize: 10, color: "#F0A500", marginTop: 4 }}>{daysLeft}{t(lang, "stats.daysLeft")}</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
      <div style={{ background: "#1a1a28", borderRadius: 20, padding: 20, border: "1px solid #252538", marginBottom: 24 }}>
        <div style={{ fontSize: 12, color: "#999", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 16 }}>{t(lang, "stats.expenseTrend6m")}</div>
        <MiniChart dati={ultimi6} />
      </div>

      {numTransazioni > 0 && (
        <>
          <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
            <div style={{ flex: 1, background: "#1a1a28", borderRadius: 16, padding: "14px", border: "1px solid #252538", textAlign: "center" }}>
              <div style={{ fontSize: 10, color: "#999", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 4 }}>{t(lang, "stats.transactionsCount")}</div>
              <div style={{ fontSize: 26, fontWeight: 800, color: "#6C5CE7", fontFamily: "'Space Mono',monospace" }}>{numTransazioni}</div>
            </div>
            <div style={{ flex: 1, background: "#1a1a28", borderRadius: 16, padding: "14px", border: "1px solid #252538", textAlign: "center" }}>
              <div style={{ fontSize: 10, color: "#999", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 4 }}>{t(lang, "stats.avgExpense")}</div>
              <div style={{ fontSize: 18, fontWeight: 800, color: "#FF6B6B", fontFamily: "'Space Mono',monospace" }}>{formattaValuta(spesaMedia)}</div>
            </div>
            <div style={{ flex: 1, background: "#1a1a28", borderRadius: 16, padding: "14px", border: "1px solid #252538", textAlign: "center" }}>
              <div style={{ fontSize: 10, color: "#999", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 4 }}>{t(lang, "stats.dailyFreq")}</div>
              <div style={{ fontSize: 18, fontWeight: 800, color: "#4ECDC4", fontFamily: "'Space Mono',monospace" }}>{(numTransazioni / giorniMese).toFixed(1)}<span style={{ fontSize: 11, color: "#888" }}>/g</span></div>
            </div>
          </div>
          <div style={{ background: "#1a1a28", borderRadius: 20, padding: 20, marginBottom: 16, border: "1px solid #252538" }}>
            <div style={{ fontSize: 12, color: "#999", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 14 }}>{t(lang, "stats.amountDistribution")}</div>
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
            <div style={{ fontSize: 12, color: "#999", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 14 }}>{t(lang, "stats.dailyHeatmap")}</div>
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
              <span style={{ fontSize: 9, color: "#666" }}>{t(lang, "stats.less")}</span>
              {[0, 0.25, 0.5, 0.75, 1].map((v, i) => (
                <div key={i} style={{ width: 14, height: 14, borderRadius: 3, background: v === 0 ? "#1e1e2e" : `rgba(108, 92, 231, ${0.15 + v * 0.85})` }} />
              ))}
              <span style={{ fontSize: 9, color: "#666" }}>{t(lang, "stats.more")}</span>
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
              <div style={{ fontSize: 12, color: "#999", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 14 }}>{t(lang, "stats.insightsTitle")}</div>
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
              <div style={{ fontSize: 12, color: "#999", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 14 }}>{t(lang, "stats.comparisonVs")} {mese(mesePrecedente.getMonth(), lang)}</div>
              {/* Uscite comparison */}
              <div style={{ marginBottom: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                  <span style={{ fontSize: 11, color: "#888" }}>{t(lang, "stats.expenses")}</span>
                  <span style={{ fontSize: 12, fontWeight: 700, fontFamily: "'Space Mono',monospace", color: deltaPct > 0 ? "#FF6B6B" : "#4ECDC4" }}>
                    {deltaPct >= 0 ? "+" : ""}{Math.round(deltaPct)}%
                  </span>
                </div>
                <div style={{ display: "flex", gap: 4, height: 20 }}>
                  <div style={{ position: "relative", flex: 1, background: "#252538", borderRadius: 6, overflow: "hidden" }}>
                    <div style={{ position: "absolute", inset: 0, width: `${Math.min(100, totalUscitePrec / Math.max(totalUscite, totalUscitePrec) * 100)}%`, background: "#FF6B6B44", borderRadius: 6 }} />
                    <div style={{ position: "relative", padding: "2px 8px", fontSize: 10, color: "#aaa" }}>{mese(mesePrecedente.getMonth(), lang)} {formattaValuta(totalUscitePrec)}</div>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 4, height: 20, marginTop: 4 }}>
                  <div style={{ position: "relative", flex: 1, background: "#252538", borderRadius: 6, overflow: "hidden" }}>
                    <div style={{ position: "absolute", inset: 0, width: `${Math.min(100, totalUscite / Math.max(totalUscite, totalUscitePrec) * 100)}%`, background: "#FF6B6B88", borderRadius: 6 }} />
                    <div style={{ position: "relative", padding: "2px 8px", fontSize: 10, color: "#eee", fontWeight: 600 }}>{mese(meseVis.getMonth(), lang)} {formattaValuta(totalUscite)}</div>
                  </div>
                </div>
              </div>
              {/* Entrate comparison */}
              {(totalEntrate > 0 || totalEntratePrec > 0) && (
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                    <span style={{ fontSize: 11, color: "#888" }}>{t(lang, "stats.income")}</span>
                    {deltaEntPct !== null && <span style={{ fontSize: 12, fontWeight: 700, fontFamily: "'Space Mono',monospace", color: deltaEntPct >= 0 ? "#4ECDC4" : "#FF6B6B" }}>
                      {deltaEntPct >= 0 ? "+" : ""}{Math.round(deltaEntPct)}%
                    </span>}
                  </div>
                  <div style={{ display: "flex", gap: 4, height: 20 }}>
                    <div style={{ position: "relative", flex: 1, background: "#252538", borderRadius: 6, overflow: "hidden" }}>
                      <div style={{ position: "absolute", inset: 0, width: `${Math.min(100, totalEntratePrec / Math.max(totalEntrate, totalEntratePrec, 1) * 100)}%`, background: "#4ECDC444", borderRadius: 6 }} />
                      <div style={{ position: "relative", padding: "2px 8px", fontSize: 10, color: "#aaa" }}>{mese(mesePrecedente.getMonth(), lang)} {formattaValuta(totalEntratePrec)}</div>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 4, height: 20, marginTop: 4 }}>
                    <div style={{ position: "relative", flex: 1, background: "#252538", borderRadius: 6, overflow: "hidden" }}>
                      <div style={{ position: "absolute", inset: 0, width: `${Math.min(100, totalEntrate / Math.max(totalEntrate, totalEntratePrec, 1) * 100)}%`, background: "#4ECDC488", borderRadius: 6 }} />
                      <div style={{ position: "relative", padding: "2px 8px", fontSize: 10, color: "#eee", fontWeight: 600 }}>{mese(meseVis.getMonth(), lang)} {formattaValuta(totalEntrate)}</div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Category trends vs previous month */}
          {catTrends.length > 0 && totalUscitePrec > 0 && (
            <div style={{ background: "#1a1a28", borderRadius: 20, padding: 20, marginBottom: 16, border: "1px solid #252538" }}>
              <div style={{ fontSize: 12, color: "#999", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 14 }}>{t(lang, "stats.categoryTrend")}</div>
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
              <div style={{ fontSize: 12, color: "#999", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 14 }}>{t(lang, "stats.savingRate")}</div>
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
                  <text x="40" y="50" textAnchor="middle" fill="#888" fontSize="7" fontFamily="'DM Sans',sans-serif">{t(lang, "stats.savingsShort")}</text>
                </svg>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, color: "#ccc", marginBottom: 4 }}>
                    {savingRate > 30 ? t(lang, "stats.savingMsgExcellent") :
                     savingRate > 15 ? t(lang, "stats.savingMsgGood") :
                     savingRate > 0 ? t(lang, "stats.savingMsgLow") :
                     t(lang, "stats.savingMsgNegative")}
                  </div>
                  <div style={{ fontSize: 11, color: "#888" }}>
                    {t(lang, "stats.saved")}: {formattaValuta(Math.max(0, totalEntrate - totalUscite))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {perCategoria.length === 0 && <div style={{ color: "#555", textAlign: "center", padding: 40, fontSize: 14 }}>{t(lang, "stats.noDataThisMonth")}</div>}

      {/* ─── Storico saldi 12 mesi ─── */}
      {(() => {
        const mesi12 = Array.from({ length: 12 }, (_, i) => {
          const d = new Date(oggi.getFullYear(), oggi.getMonth() - (11 - i), 1);
          const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
          const txM = transazioni.filter(t => t.data?.slice(0, 7) === ym);
          const e = txM.filter(t => t.tipo === "entrata").reduce((s, t) => s + t.importo, 0);
          const u = txM.filter(t => t.tipo === "uscita").reduce((s, t) => s + t.importo, 0);
          return { label: mese(d.getMonth(), lang), anno: d.getFullYear(), ym, entrate: e, uscite: u, saldo: e - u };
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
            <div style={{ fontSize: 12, color: "#999", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 14 }}>{t(lang, "stats.history12m")}</div>

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
                <div style={{ width: 10, height: 10, borderRadius: 2, background: "#4ECDC4" }} /> {t(lang, "stats.income")}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, color: "#888" }}>
                <div style={{ width: 10, height: 10, borderRadius: 2, background: "#FF6B6B" }} /> {t(lang, "stats.expenses")}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, color: "#888" }}>
                <div style={{ width: 16, height: 2, borderRadius: 1, background: "#a78bfa" }} /> {t(lang, "stats.netBalance")}
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
                    <div style={{ fontSize: 9, color: "#555", textTransform: "uppercase", letterSpacing: 0.5 }}>{t(lang, "stats.bestMonth")}</div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#4ECDC4", fontFamily: "'Space Mono',monospace", marginTop: 2 }}>{best.label}</div>
                    <div style={{ fontSize: 10, color: "#4ECDC4" }}>{best.saldo >= 0 ? "+" : ""}{formattaValuta(best.saldo)}</div>
                  </div>
                  <div style={{ flex: 1, background: "#111119", borderRadius: 10, padding: "8px 10px" }}>
                    <div style={{ fontSize: 9, color: "#555", textTransform: "uppercase", letterSpacing: 0.5 }}>{t(lang, "stats.worstMonth")}</div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#FF6B6B", fontFamily: "'Space Mono',monospace", marginTop: 2 }}>{worst.label}</div>
                    <div style={{ fontSize: 10, color: "#FF6B6B" }}>{worst.saldo >= 0 ? "+" : ""}{formattaValuta(worst.saldo)}</div>
                  </div>
                  <div style={{ flex: 1, background: "#111119", borderRadius: 10, padding: "8px 10px" }}>
                    <div style={{ fontSize: 9, color: "#555", textTransform: "uppercase", letterSpacing: 0.5 }}>{t(lang, "stats.avgExpensesLabel")}</div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#F0A500", fontFamily: "'Space Mono',monospace", marginTop: 2 }}>
                      {formattaValuta(avgUscite)}
                    </div>
                    <div style={{ fontSize: 10, color: "#555" }}>{t(lang, "stats.perMonth")}</div>
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
function PortfolioView({ lang = "it" }) {
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

  // Aggregate by ticker with average-cost accounting.
  // Trades are processed chronologically: a sell reduces cost basis by qty × average
  // cost, and realizes qty × (sell price − average cost) as P&L. Fully closed
  // positions are kept separately with their realized P&L.
  const holdings = [];
  const closedHoldings = [];
  const tickerMap = {};
  const sortedPositions = [...positions].sort((a, b) =>
    (a.dataAcquisto || "").localeCompare(b.dataAcquisto || "") ||
    (a.createdAt || "").localeCompare(b.createdAt || "")
  );
  for (const p of sortedPositions) {
    if (!tickerMap[p.ticker]) {
      tickerMap[p.ticker] = { ticker: p.ticker, nome: p.nome || p.ticker, quantita: 0, costoTotale: 0, realizzato: 0, trades: [] };
    }
    const h = tickerMap[p.ticker];
    if (p.tipo === "sell") {
      const avg = h.quantita > 0.0001 ? h.costoTotale / h.quantita : 0;
      const sellQ = Math.min(p.quantita, h.quantita); // guard against overselling
      h.realizzato += sellQ * (p.prezzoAcquisto - avg);
      h.costoTotale -= sellQ * avg;
      h.quantita -= sellQ;
      if (h.quantita < 0.0001) { h.quantita = 0; h.costoTotale = 0; }
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
    } else if (h.trades.some(t => t.tipo === "sell")) {
      h.ultimaData = h.trades[h.trades.length - 1]?.dataAcquisto || "";
      closedHoldings.push(h);
    }
  }
  closedHoldings.sort((a, b) => (b.ultimaData || "").localeCompare(a.ultimaData || ""));
  const totalRealizzato = [...holdings, ...closedHoldings].reduce((s, h) => s + h.realizzato, 0);

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
    const opWord = trades.length > 1 ? `${trades.length} ${t(lang, "portfolio.confirmDeleteHoldingAll")}` : t(lang, "portfolio.confirmDeleteHoldingOne");
    if (!confirm(`${t(lang, "portfolio.confirmDeleteHoldingPrefix")} ${opWord} ${t(lang, "portfolio.confirmDeleteHoldingSuffix")}`)) return;
    await Promise.all(trades.map(tr => deletePosition(tr.id)));
    const ids = new Set(trades.map(tr => tr.id));
    setPositions(prev => prev.filter(p => !ids.has(p.id)));
  }

  async function handleDeleteTrade(trade) {
    const what = trade.tipo === "sell" ? t(lang, "portfolio.confirmDeleteTradeSell") : t(lang, "portfolio.confirmDeleteTradeBuy");
    if (!confirm(`${t(lang, "portfolio.confirmDeleteTradePrefix")} ${what} ${t(lang, "portfolio.confirmDeleteTradeConnector")} ${trade.dataAcquisto} (${trade.quantita} ${t(lang, "portfolio.units")})?`)) return;
    try {
      await deletePosition(trade.id);
      setPositions(prev => prev.filter(p => p.id !== trade.id));
    } catch (e) { toast(`${t(lang, "toast.errorDeletePrefix")} ${e.message}`, "error"); }
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

  if (loading) return <div style={{ padding: 40, textAlign: "center", color: "#888" }}>{t(lang, "portfolio.loading")}</div>;

  return (
    <div style={{ padding: "20px 16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 800, color: "#eee" }}>{t(lang, "nav.portfolio")}</div>
          <div style={{ fontSize: 12, color: "#888" }}>{holdings.length} {t(lang, "portfolio.tickers")}</div>
        </div>
        <button onClick={() => setShowAdd(!showAdd)} style={{
            background: showAdd ? "#6C5CE722" : "none", border: showAdd ? "1px solid #6C5CE7" : "1px solid #252538",
            borderRadius: 8, cursor: "pointer", color: showAdd ? "#6C5CE7" : "#888", fontSize: 16, padding: "4px 10px",
          }}>{showAdd ? "✕" : "+"}</button>
      </div>

      {/* Summary card */}
      {(holdings.length > 0 || closedHoldings.length > 0) && (
        <div style={{ background: "linear-gradient(135deg, #1e1e30 0%, #2a1f4e 100%)", borderRadius: 20, padding: "20px", marginBottom: 16, border: "1px solid #333355", boxShadow: "0 8px 32px #0005" }}>
          <div style={{ fontSize: 11, color: "#999", letterSpacing: 0.5, textTransform: "uppercase" }}>{t(lang, "portfolio.totalValue")}</div>
          <div style={{ fontSize: 32, fontWeight: 800, fontFamily: "'Space Mono',monospace", color: "#eee", marginTop: 4 }}>
            {formattaValuta(totalValore)}
          </div>
          <div style={{ display: "flex", gap: 16, marginTop: 12, flexWrap: "wrap" }}>
            <div>
              <div style={{ fontSize: 10, color: "#888" }}>{t(lang, "portfolio.invested")}</div>
              <div style={{ fontSize: 14, fontWeight: 600, fontFamily: "'Space Mono',monospace", color: "#aaa" }}>{formattaValuta(totalInvestito)}</div>
            </div>
            <div>
              <div style={{ fontSize: 10, color: "#888" }}>{t(lang, "portfolio.unrealizedPL")}</div>
              <div style={{ fontSize: 14, fontWeight: 700, fontFamily: "'Space Mono',monospace", color: totalPL >= 0 ? "#4ECDC4" : "#FF6B6B" }}>
                {totalPL >= 0 ? "+" : ""}{formattaValuta(totalPL)} ({totalPLPct >= 0 ? "+" : ""}{totalPLPct.toFixed(1)}%)
              </div>
            </div>
            {Math.abs(totalRealizzato) > 0.005 && (
              <div>
                <div style={{ fontSize: 10, color: "#888" }}>{t(lang, "portfolio.realizedPL")}</div>
                <div style={{ fontSize: 14, fontWeight: 700, fontFamily: "'Space Mono',monospace", color: totalRealizzato >= 0 ? "#4ECDC4" : "#FF6B6B" }}>
                  {totalRealizzato >= 0 ? "+" : ""}{formattaValuta(totalRealizzato)}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Add form */}
      {showAdd && (
        <div style={{ background: "#1a1a28", borderRadius: 16, padding: 16, marginBottom: 16, border: "2px solid #6C5CE7" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#eee", marginBottom: 12 }}>{t(lang, "portfolio.addPosition")}</div>

          {/* Buy/Sell toggle */}
          <div style={{ display: "flex", background: "#111119", borderRadius: 12, padding: 3, marginBottom: 12, border: "1px solid #252538" }}>
            {["buy", "sell"].map(tp => (
              <button key={tp} onClick={() => setTradeType(tp)} style={{
                flex: 1, padding: "8px 0", border: "none", borderRadius: 10, cursor: "pointer",
                fontSize: 13, fontWeight: 600,
                background: tradeType === tp ? (tp === "buy" ? "#4ECDC422" : "#FF6B6B22") : "transparent",
                color: tradeType === tp ? (tp === "buy" ? "#4ECDC4" : "#FF6B6B") : "#666",
              }}>{tp === "buy" ? t(lang, "portfolio.buy") : t(lang, "portfolio.sell")}</button>
            ))}
          </div>

          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>{t(lang, "portfolio.ticker")}</label>
              <input type="text" value={ticker} onChange={e => setTicker(e.target.value.toUpperCase())} placeholder="AAPL"
                style={{ ...inputStyle, fontSize: 16, fontWeight: 700, fontFamily: "'Space Mono',monospace", textTransform: "uppercase", background: "#111119" }} />
            </div>
            <div style={{ flex: 2 }}>
              <label style={labelStyle}>{t(lang, "portfolio.nameOptional")}</label>
              <input type="text" value={nome} onChange={e => setNome(e.target.value)} placeholder="Apple Inc."
                style={{ ...inputStyle, background: "#111119" }} />
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>{t(lang, "portfolio.quantity")}</label>
              <input type="number" inputMode="decimal" value={quantita} onChange={e => setQuantita(e.target.value)} placeholder="10"
                style={{ ...inputStyle, fontFamily: "'Space Mono',monospace", background: "#111119" }} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>{t(lang, "portfolio.purchasePrice")}</label>
              <input type="number" inputMode="decimal" value={prezzoAcquisto} onChange={e => setPrezzoAcquisto(e.target.value)} placeholder="150.00"
                style={{ ...inputStyle, fontFamily: "'Space Mono',monospace", background: "#111119" }} />
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>{t(lang, "portfolio.purchaseDate")}</label>
              <input type="date" value={dataAcquisto} onChange={e => setDataAcquisto(e.target.value)}
                style={{ ...inputStyle, background: "#111119", colorScheme: "dark" }} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>{t(lang, "portfolio.notes")}</label>
              <input type="text" value={note} onChange={e => setNote(e.target.value)} placeholder="..."
                style={{ ...inputStyle, background: "#111119" }} />
            </div>
          </div>
          <button onClick={handleAdd} disabled={adding || !ticker || !quantita || !prezzoAcquisto} style={{
            width: "100%", padding: "12px", border: "none", borderRadius: 12, cursor: "pointer",
            fontSize: 14, fontWeight: 700, color: "#fff",
            background: ticker && quantita && prezzoAcquisto ? (tradeType === "buy" ? "linear-gradient(135deg, #4ECDC4, #3ab8b0)" : "linear-gradient(135deg, #FF6B6B, #e05050)") : "#252538",
            opacity: adding ? 0.6 : 1,
          }}>{adding ? t(lang, "viaggi.saving") : (tradeType === "buy" ? t(lang, "portfolio.addBuy") : t(lang, "portfolio.recordSell"))}</button>
        </div>
      )}

      {/* Holdings list */}
      {holdings.length === 0 ? (
        <div style={{ color: "#555", textAlign: "center", padding: 40, fontSize: 14 }}>
          {t(lang, "portfolio.noPositions")}<br/>{t(lang, "portfolio.tapToAddTicker")}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {/* Sort selector */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 11, color: "#555", flexShrink: 0 }}>{t(lang, "portfolio.sortBy")}</span>
            <select value={sortPortfolio} onChange={e => setSortPortfolio(e.target.value)} style={{
              flex: 1, background: "#1a1a28", border: "1px solid #252538", borderRadius: 8,
              color: "#aaa", fontSize: 12, padding: "6px 8px", fontFamily: "'DM Sans',sans-serif",
              colorScheme: "dark", cursor: "pointer",
            }}>
              <option value="valore-desc">{t(lang, "portfolio.sortValueDesc")}</option>
              <option value="valore-asc">{t(lang, "portfolio.sortValueAsc")}</option>
              <option value="pl-desc">{t(lang, "portfolio.sortPlDesc")}</option>
              <option value="pl-asc">{t(lang, "portfolio.sortPlAsc")}</option>
              <option value="plpct-desc">{t(lang, "portfolio.sortPlPctDesc")}</option>
              <option value="plpct-asc">{t(lang, "portfolio.sortPlPctAsc")}</option>
              <option value="investito-desc">{t(lang, "portfolio.sortInvestedDesc")}</option>
              <option value="investito-asc">{t(lang, "portfolio.sortInvestedAsc")}</option>
              <option value="ticker-asc">{t(lang, "portfolio.sortTickerAsc")}</option>
              <option value="ticker-desc">{t(lang, "portfolio.sortTickerDesc")}</option>
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
                        <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 5px", borderRadius: 4, background: "#F0A50022", color: "#F0A500", letterSpacing: 0.3, flexShrink: 0 }}>{t(lang, "portfolio.manualBadge")}</span>
                      )}
                    </div>
                    <div style={{ fontSize: 11, color: "#666", marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {h.quantita.toFixed(h.quantita % 1 === 0 ? 0 : 2)} {t(lang, "portfolio.units")} × {formattaValuta(h.prezzoMedio)} {t(lang, "portfolio.avgSuffix")}
                    </div>
                  </div>
                  <div style={{ textAlign: "right", flexShrink: 0, maxWidth: "48%" }}>
                    <div style={{ fontSize: 15, fontWeight: 700, fontFamily: "'Space Mono',monospace", color: "#eee", wordBreak: "break-all" }}>
                      {prezzoCorrente > 0 ? formattaValuta(valoreCorrente) : "—"}
                    </div>
                    {totalValore > 0 && (
                      <div style={{ fontSize: 9, color: "#666", fontFamily: "'Space Mono',monospace" }}>{(valoreCorrente / totalValore * 100).toFixed(1)}{t(lang, "portfolio.ofPortfolio")}</div>
                    )}
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
                      <span style={{ fontSize: 11, color: "#555" }}>{t(lang, "portfolio.enterManualPrice")}</span>
                    ) : null}
                  </div>

                  {/* Edit ✏ + Delete × — always on right, never wrap */}
                  {!isEditing && (
                    <div style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
                      <button onClick={() => startEditPrice(h.ticker, manuale)} title={t(lang, "portfolio.updatePriceManually")} style={{
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
                  }}>✏ {t(lang, "portfolio.enterManualPrice")}</button>
                )}

                {/* Inline manual price editor */}
                {isEditing && (
                  <div style={{ marginTop: 10, padding: "12px", background: "#111119", borderRadius: 12, border: "1px solid #6C5CE733" }}>
                    <div style={{ fontSize: 11, color: "#a78bfa", fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 8 }}>
                      {t(lang, "portfolio.manualPricePrefix")} {h.ticker}
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
                      }}>{t(lang, "common.save")}</button>
                      <button onClick={() => setEditingTicker(null)} style={{
                        padding: "10px 14px", background: "none", border: "1px solid #333", borderRadius: 10,
                        color: "#888", fontSize: 14, cursor: "pointer", fontFamily: "'DM Sans',sans-serif",
                      }}>✕</button>
                    </div>
                    {manuale && (
                      <button onClick={() => handleClearManualPrice(h.ticker)} style={{
                        marginTop: 8, background: "none", border: "none", color: "#FF6B6B88", cursor: "pointer",
                        fontSize: 11, fontFamily: "'DM Sans',sans-serif", padding: 0,
                      }}>{t(lang, "portfolio.removeManualPrice")}</button>
                    )}
                    <div style={{ fontSize: 10, color: "#555", marginTop: 8 }}>
                      {t(lang, "portfolio.apiPriceNote")}
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
                    {expandedTicker === h.ticker ? t(lang, "portfolio.hideHistory") : `${t(lang, "portfolio.viewTrades")} ${h.trades.length} ${t(lang, "portfolio.trades")}`}
                  </button>
                )}

                {/* Expandable trade history */}
                {expandedTicker === h.ticker && h.trades && h.trades.length > 0 && (
                  <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid #252538" }}>
                    <div style={{ fontSize: 10, color: "#888", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 8 }}>{t(lang, "portfolio.tradeHistory")}</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      {[...h.trades].sort((a, b) => new Date(b.dataAcquisto) - new Date(a.dataAcquisto)).map((tr, i) => (
                        <div key={tr.id || i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", background: "#111119", borderRadius: 8 }}>
                          <span style={{ fontSize: 10, color: "#666", minWidth: 60 }}>{tr.dataAcquisto}</span>
                          <span style={{ fontSize: 11, fontWeight: 600, color: tr.tipo === "sell" ? "#FF6B6B" : "#4ECDC4", minWidth: 35 }}>
                            {tr.tipo === "sell" ? "SELL" : "BUY"}
                          </span>
                          <span style={{ flex: 1, fontSize: 12, color: "#ccc", fontFamily: "'Space Mono',monospace" }}>{tr.quantita} {t(lang, "portfolio.units")}</span>
                          <span style={{ fontSize: 12, color: "#aaa", fontFamily: "'Space Mono',monospace" }}>@{formattaValuta(tr.prezzoAcquisto)}</span>
                          <button onClick={() => handleDeleteTrade(tr)} title={t(lang, "portfolio.deleteThisTrade")} style={{ background: "none", border: "none", color: "#FF6B6B66", cursor: "pointer", fontSize: 13, lineHeight: 1, padding: "2px 4px" }}>✕</button>
                        </div>
                      ))}
                    </div>
                    {Math.abs(h.realizzato) > 0.005 && (
                      <div style={{ marginTop: 8, fontSize: 11, color: "#888", display: "flex", justifyContent: "space-between" }}>
                        <span>{t(lang, "portfolio.realizedPL")} ({h.ticker})</span>
                        <span style={{ fontFamily: "'Space Mono',monospace", fontWeight: 700, color: h.realizzato >= 0 ? "#4ECDC4" : "#FF6B6B" }}>
                          {h.realizzato >= 0 ? "+" : ""}{formattaValuta(h.realizzato)}
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Closed positions */}
      {closedHoldings.length > 0 && (
        <div style={{ background: "#1a1a28", borderRadius: 20, padding: 16, marginTop: 16, border: "1px solid #252538" }}>
          <div style={{ fontSize: 12, color: "#999", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 12 }}>{t(lang, "portfolio.closedPositions")}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {closedHoldings.map(h => (
              <div key={h.ticker} style={{ background: "#111119", borderRadius: 12, padding: "10px 12px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ fontSize: 13, fontWeight: 800, color: "#aaa", fontFamily: "'Space Mono',monospace" }}>{h.ticker}</span>
                    <span style={{ fontSize: 10, color: "#666", marginLeft: 6 }}>{h.nome}</span>
                    <div style={{ fontSize: 10, color: "#555", marginTop: 2 }}>{t(lang, "portfolio.closedOn")} {h.ultimaData} · {h.trades.length} {t(lang, "portfolio.trades")}</div>
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 700, fontFamily: "'Space Mono',monospace", color: h.realizzato >= 0 ? "#4ECDC4" : "#FF6B6B", flexShrink: 0 }}>
                    {h.realizzato >= 0 ? "+" : ""}{formattaValuta(h.realizzato)}
                  </div>
                  <button onClick={() => setExpandedTicker(expandedTicker === h.ticker ? null : h.ticker)} style={{ background: "none", border: "none", color: "#6C5CE7", cursor: "pointer", fontSize: 11, padding: "2px 4px", flexShrink: 0 }}>
                    {expandedTicker === h.ticker ? "▲" : "▼"}
                  </button>
                  <button onClick={() => handleDeleteHolding(h.trades)} style={{ background: "none", border: "none", color: "#555", cursor: "pointer", fontSize: 14, padding: "2px 4px", flexShrink: 0 }}>×</button>
                </div>
                {expandedTicker === h.ticker && (
                  <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
                    {[...h.trades].sort((a, b) => new Date(b.dataAcquisto) - new Date(a.dataAcquisto)).map((tr, i) => (
                      <div key={tr.id || i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 8px", background: "#1a1a28", borderRadius: 8 }}>
                        <span style={{ fontSize: 10, color: "#666", minWidth: 60 }}>{tr.dataAcquisto}</span>
                        <span style={{ fontSize: 11, fontWeight: 600, color: tr.tipo === "sell" ? "#FF6B6B" : "#4ECDC4", minWidth: 35 }}>{tr.tipo === "sell" ? "SELL" : "BUY"}</span>
                        <span style={{ flex: 1, fontSize: 12, color: "#ccc", fontFamily: "'Space Mono',monospace" }}>{tr.quantita} {t(lang, "portfolio.units")}</span>
                        <span style={{ fontSize: 12, color: "#aaa", fontFamily: "'Space Mono',monospace" }}>@{formattaValuta(tr.prezzoAcquisto)}</span>
                        <button onClick={() => handleDeleteTrade(tr)} title={t(lang, "portfolio.deleteThisTrade")} style={{ background: "none", border: "none", color: "#FF6B6B66", cursor: "pointer", fontSize: 13, lineHeight: 1, padding: "2px 4px" }}>✕</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Allocation pie chart */}
      {holdings.length >= 2 && totalValore > 0 && (
        <div style={{ background: "#1a1a28", borderRadius: 20, padding: 20, marginTop: 16, border: "1px solid #252538" }}>
          <div style={{ fontSize: 12, color: "#999", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 14 }}>{t(lang, "portfolio.allocation")}</div>
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
        <div style={{ background: "#1a1a28", borderRadius: 20, padding: 20, marginTop: 16, border: "1px solid #252538", overflow: "hidden" }}>
          <div style={{ fontSize: 12, color: "#999", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 14 }}>{t(lang, "portfolio.profitLoss")}</div>
          <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 100, minWidth: "max-content" }}>
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
                <div key={h.ticker} style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 44, flexShrink: 0 }}>
                  <div style={{ width: 28, height, background: isPositive ? "#4ECDC4" : "#FF6B6B", borderRadius: "4px 4px 0 0", transition: "height 0.5s" }} />
                  <span style={{ fontSize: 9, color: "#888", marginTop: 4, whiteSpace: "nowrap" }}>{h.ticker}</span>
                  <span style={{ fontSize: 8, color: isPositive ? "#4ECDC4" : "#FF6B6B", whiteSpace: "nowrap" }}>{importoOscurabile(`${isPositive ? "+" : ""}${pl >= 1000 ? (pl/1000).toFixed(1) + "k" : pl.toFixed(0)}€`)}</span>
                </div>
              );
            })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Export View ───
const ALL_COLUMN_IDS = ["data", "tipo", "importo", "categoria", "descrizione", "pagatoDa", "ricevutoDa", "partecipanti", "conto"];

// ─── Splitwise CSV parser ───
// Splitwise format: Data, Descrizione, Categorie, Costo, Valuta, <one column per person>
// Each person column holds the NET balance: positive = paid more than their share.
function parseSplitwiseRows(rawRows, persone) {
  const righe = [];
  const errori = [];
  const extraMap = {};
  let extraCount = 0;

  const metaCols = ["Data", "Date", "Descrizione", "Description", "Categorie", "Categories", "Costo", "Cost", "Valuta", "Currency"];
  const first = rawRows.find(r => Object.keys(r).length > 0) || {};
  const nameCols = Object.keys(first).filter(k => !metaCols.includes(k.trim()) && k.trim() !== "");

  // Splitwise category → app category (nome). Adjust to taste.
  const CAT_MAP = {
    "ristorante": "Cibo",
    "alimentari": "Cibo",
    "trasporti": "Trasporti",
    "trasporti - altro": "Trasporti",
    "casa": "Casa",
    "generali": "Altro",
  };

  function resolvePersona(nome) {
    const p = persone.find(x => x.nome.toLowerCase() === nome.toLowerCase());
    if (p) return p.id;
    const id = nome.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "") || `extra${extraCount}`;
    if (!extraMap[id]) {
      extraMap[id] = { id, nome, emoji: "👤", colore: COLORI_EXTRA[extraCount % COLORI_EXTRA.length] };
      extraCount++;
    }
    return id;
  }

  // Excel stores dates as serial numbers (days since 1899-12-30).
  // Splitwise timestamps are near midnight, so round to the nearest day.
  function excelSerialToISO(v) {
    const n = parseFloat(v);
    if (isNaN(n) || n < 20000 || n > 60000) return null;
    return new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000).toISOString().slice(0, 10);
  }

  rawRows.forEach((row, i) => {
    const num = i + 2;
    let data = String(row["Data"] || row["Date"] || "").trim();
    if (/^\d+(\.\d+)?$/.test(data)) data = excelSerialToISO(data) || data;
    const descrizione = String(row["Descrizione"] || row["Description"] || "").trim();

    // Skip blank rows and the final "Bilancio totale" summary row
    if (!data && !descrizione) return;
    const descLow = descrizione.toLowerCase();
    if (descLow.includes("bilancio totale") || descLow.includes("total balance")) return;

    if (!data.match(/^\d{4}-\d{2}-\d{2}$/)) {
      errori.push(`Riga ${num}: data non valida ("${data}") — formato atteso YYYY-MM-DD`);
      return;
    }

    const costo = parseFloat(String(row["Costo"] ?? row["Cost"] ?? "").replace(",", "."));
    if (isNaN(costo) || costo <= 0) {
      errori.push(`Riga ${num}: costo non valido ("${row["Costo"]}")`);
      return;
    }

    // Net balance per person for this expense
    const nets = nameCols.map(n => ({
      nome: n.trim(),
      net: parseFloat(String(row[n] ?? "0").replace(",", ".")) || 0,
    }));

    // All zeros → expense fully self-paid: nothing to split, skip
    if (nets.every(x => Math.abs(x.net) < 0.005)) return;

    // Payer = person with the largest positive net (Splitwise single-payer rows)
    const payer = nets.reduce((a, b) => (b.net > a.net ? b : a));
    if (payer.net <= 0) {
      errori.push(`Riga ${num}: nessun pagante rilevato ("${descrizione}")`);
      return;
    }

    // Actual share of each participant:
    //   payer's share  = costo − suo net
    //   others' share  = −(loro net)   (persone a 0 sono escluse dalla spesa)
    const shares = nets
      .map(x => ({
        nome: x.nome,
        share: x.nome === payer.nome ? costo - x.net : Math.max(0, -x.net),
      }))
      .filter(x => x.share > 0.005);

    const splits = shares.map(x => ({
      personaId: resolvePersona(x.nome),
      quota: Math.round((x.share / costo) * 10000) / 100,
    }));

    // Fix rounding so quotas sum to exactly 100
    const totQ = splits.reduce((s, x) => s + x.quota, 0);
    if (splits.length && Math.abs(totQ - 100) > 0.001) {
      const last = splits[splits.length - 1];
      last.quota = Math.round((last.quota + 100 - totQ) * 100) / 100;
    }

    const catRaw = String(row["Categorie"] || row["Categories"] || "").trim().toLowerCase();
    const categoria = CAT_MAP[catRaw] || "Altro";

    righe.push({
      data,
      tipo: "uscita",
      importo: costo,
      categoria,
      descrizione,
      pagatoDa: resolvePersona(payer.nome),
      ricevutoDa: null,
      splits,
      extraPersone: null, // filled after the loop
    });
  });

  const extraList = Object.values(extraMap);
  if (extraList.length > 0) righe.forEach(r => { r.extraPersone = extraList; });

  return { righe, errori };
}

function ExportView({ transazioni, persone, positions, conti = [], onImport, onImportComplete, onImportPosition, onImportPositionComplete, lang = "it" }) {
  const oggi = new Date();
  const [meseDa, setMeseDa] = useState(`${oggi.getFullYear()}-${String(oggi.getMonth()+1).padStart(2,"0")}`);
  const [meseA, setMeseA] = useState(meseDa);
  const [colonne, setColonne] = useState(ALL_COLUMN_IDS);
  const [ordinamento, setOrdinamento] = useState("data-asc");
  const [esportando, setEsportando] = useState(false);
  const [includiPortfolio, setIncludiPortfolio] = useState(false);

  // Import state
  const [importando, setImportando] = useState(false);
  const [importPreview, setImportPreview] = useState(null);
  const [importPortfolioPreview, setImportPortfolioPreview] = useState(null);
  const [importFile, setImportFile] = useState(null);

  // Backup state
  const [backupBusy, setBackupBusy] = useState(false);
  const [restorePreview, setRestorePreview] = useState(null);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreDone, setRestoreDone] = useState(null);

  async function handleDownloadBackup() {
    setBackupBusy(true);
    try {
      const data = await downloadBackup();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `backup-finanza-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) { toast(`${t(lang, "toast.errorBackupPrefix")} ${e.message}`, "error"); }
    setBackupBusy(false);
  }

  async function handleRestoreFile(file) {
    setRestoreDone(null);
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (data.formato !== "balance-tracker-backup") { toast(t(lang, "toast.notABackupFile"), "error"); return; }
      setRestorePreview({ data, counts: {
        transazioni: (data.transactions || []).length,
        conti: (data.accounts || []).length,
        obiettivi: (data.goals || []).length,
        viaggi: (data.trips || []).length,
        posizioni: (data.positions || []).length,
        prezzi: Object.keys(data.manualPrices || {}).length,
      }});
    } catch (e) { toast(`${t(lang, "toast.fileUnreadablePrefix")} ${e.message}`, "error"); }
  }

  async function handleConfirmRestore() {
    if (!restorePreview) return;
    setRestoreBusy(true);
    try {
      const res = await restoreBackup(restorePreview.data);
      setRestoreDone(res.counts);
      setRestorePreview(null);
      setTimeout(() => window.location.reload(), 2500);
    } catch (e) { toast(`${t(lang, "toast.errorRestorePrefix")} ${e.message}`, "error"); }
    setRestoreBusy(false);
  }

  function toggleColonna(id) {
    setColonne(prev => prev.includes(id) ? prev.filter(c => c !== id) : [...prev, id]);
  }

  function selezionaTutte() { setColonne(ALL_COLUMN_IDS); }
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

      // ── Splitwise CSV auto-detection ──
      const headerKeys = Object.keys(rawRows.find(r => Object.keys(r).length > 0) || {});
      const isSplitwise =
        (headerKeys.includes("Costo") || headerKeys.includes("Cost")) &&
        (headerKeys.includes("Valuta") || headerKeys.includes("Currency"));
      if (isSplitwise) {
        setImportPreview(parseSplitwiseRows(rawRows, persone));
        return; // "finally" already resets importando
      }

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
      toast(`${t(lang, "toast.errorParsePrefix")} ${err.message}`, "error");
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
    if (okTx > 0) parts.push(`${okTx} ${t(lang, "export.transactions")}`);
    if (okPos > 0) parts.push(`${okPos} ${t(lang, "export.portfolioPositions")}`);
    const errParts = [];
    if (failTx > 0) errParts.push(`${failTx} ${t(lang, "export.transactions")}`);
    if (failPos > 0) errParts.push(`${failPos} ${t(lang, "export.positions")}`);
    toast(`${t(lang, "toast.importCompletePrefix")} ${parts.join(` ${t(lang, "toast.and")} `)} ${t(lang, "toast.importedSuffix")}${errParts.length ? `, ${t(lang, "toast.errorsSuffix")} ${errParts.join(", ")}` : ""}.`, "success");
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
        if (colonne.includes("tipo")) row["Tipo"] = t.tipo === "saldo" ? "Saldo" : t.tipo === "trasferimento" ? "Giroconto" : t.tipo === "uscita" ? "Uscita" : "Entrata";
        if (colonne.includes("importo")) row["Importo (€)"] = t.importo;
        if (colonne.includes("categoria")) row["Categoria"] = t.tipo === "saldo" ? "" : (t.categoria || "");
        if (colonne.includes("descrizione")) row["Descrizione"] = t.descrizione || "";
        if (colonne.includes("conto")) {
          if (t.tipo === "trasferimento") {
            const cDa = conti.find(c => c.id === t.contoDa); const cA = conti.find(c => c.id === t.contoA);
            row["Conto"] = `${cDa?.nome || "?"} → ${cA?.nome || "?"}`;
          } else {
            row["Conto"] = conti.find(c => c.id === t.contoId)?.nome || "";
          }
        }
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
      toast(`${t(lang, "toast.errorExportPrefix")} ${err.message}`, "error");
    } finally {
      setEsportando(false);
    }
  }

  // Generate month options (last 24 months)
  const mesiOptions = [];
  for (let i = 0; i < 24; i++) {
    const d = new Date(oggi.getFullYear(), oggi.getMonth() - i, 1);
    const val = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
    const label = `${mese(d.getMonth(), lang)} ${d.getFullYear()}`;
    mesiOptions.push({ val, label });
  }

  const sortOptions = [
    { val: "data-asc", label: t(lang, "export.sortDateAsc") },
    { val: "data-desc", label: t(lang, "export.sortDateDesc") },
    { val: "importo-desc", label: t(lang, "export.sortAmountDesc") },
    { val: "importo-asc", label: t(lang, "export.sortAmountAsc") },
    { val: "categoria-asc", label: t(lang, "export.sortCategoryAsc") },
    { val: "pagatoDa-asc", label: t(lang, "export.sortPaidByAsc") },
  ];

  return (
    <div style={{ padding: "20px 16px" }}>
      {/* ─── IMPORT SECTION ─── */}
      <div style={{ fontSize: 22, fontWeight: 800, color: "#eee", marginBottom: 6 }}>{t(lang, "export.importTitle")}</div>
      <div style={{ fontSize: 13, color: "#888", marginBottom: 16 }}>
        {t(lang, "export.importHint")}
      </div>

      <label style={{
        display: "block", padding: "18px 16px", borderRadius: 16, cursor: "pointer",
        border: "2px dashed #252538", background: "#1a1a28", textAlign: "center",
        color: importFile ? "#ccc" : "#555", fontSize: 13, marginBottom: 12, transition: "all 0.2s",
      }}>
        <span style={{ fontSize: 22, display: "block", marginBottom: 6 }}>📂</span>
        {importFile ? importFile.name : t(lang, "export.chooseFile")}
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
          {t(lang, "export.analyzing")}
        </div>
      )}

      {importPreview && !importando && (
        <div style={{ background: "#1a1a28", borderRadius: 16, padding: 16, marginBottom: 16, border: "1px solid #252538" }}>
          <div style={{ fontWeight: 700, color: "#eee", marginBottom: 10, fontSize: 14 }}>{t(lang, "export.importPreview")}</div>
          <div style={{ fontSize: 13, color: "#4ECDC4", marginBottom: importPreview.errori.length ? 8 : 0 }}>
            ✓ {importPreview.righe.length} {t(lang, "export.validTransactions")}
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
                      {importoOscurabile(`${r.tipo === "uscita" ? "-" : r.tipo === "saldo" ? "↔" : "+"}€${r.importo.toFixed(2)}`)}
                    </span>
                  </div>
                ))}
                {importPreview.righe.length > 3 && (
                  <div style={{ fontSize: 11, color: "#555", marginTop: 2 }}>+ {t(lang, "export.moreRows")} {importPreview.righe.length - 3} {t(lang, "export.rows")}</div>
                )}
              </div>
              <button onClick={confermaImport} disabled={importando} style={{
                marginTop: 14, width: "100%", padding: "14px", border: "none",
                borderRadius: 14, cursor: "pointer", fontFamily: "'DM Sans',sans-serif",
                fontSize: 15, fontWeight: 700,
                background: "linear-gradient(135deg, #4ECDC4, #26a69a)",
                color: "#fff", boxShadow: "0 4px 20px #4ECDC433",
              }}>
                {t(lang, "export.importItems")} {(importPreview?.righe?.length || 0) + (importPortfolioPreview?.posizioni?.length || 0)} {t(lang, "export.items")}
              </button>
            </>
          )}
        </div>
      )}

      {/* Portfolio sheet preview */}
      {importPortfolioPreview && !importando && (
        <div style={{ background: "#1a1a28", borderRadius: 16, padding: 16, marginBottom: 16, border: "1px solid #252538" }}>
          <div style={{ fontWeight: 700, color: "#eee", marginBottom: 8, fontSize: 14 }}>{t(lang, "export.portfolioFound")}</div>
          <div style={{ fontSize: 13, color: "#4ECDC4", marginBottom: importPortfolioPreview.errori.length ? 8 : 0 }}>
            ✓ {importPortfolioPreview.posizioni.length} {t(lang, "export.validPositions")}
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
                <span>{p.tipo === "sell" ? t(lang, "export.sell") : t(lang, "export.buy")} {p.quantita} {t(lang, "portfolio.units")} × €{p.prezzoAcquisto}</span>
              </div>
            ))}
            {importPortfolioPreview.posizioni.length > 3 && (
              <div style={{ fontSize: 11, color: "#555", marginTop: 2 }}>+ {t(lang, "export.more")} {importPortfolioPreview.posizioni.length - 3}...</div>
            )}
          </div>
        </div>
      )}

      <div style={{ borderTop: "1px solid #1e1e2e", margin: "24px 0" }} />

      {/* ─── EXPORT SECTION ─── */}
      <div style={{ fontSize: 22, fontWeight: 800, color: "#eee", marginBottom: 6 }}>{t(lang, "export.exportTitle")}</div>
      <div style={{ fontSize: 13, color: "#888", marginBottom: 20 }}>{t(lang, "export.exportHint")}</div>

      {/* Month range */}
      <div style={{ display: "flex", gap: 10, marginBottom: 18 }}>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>{t(lang, "export.fromMonth")}</label>
          <select value={meseDa} onChange={e => { setMeseDa(e.target.value); if (e.target.value > meseA) setMeseA(e.target.value); }}
            style={{ ...inputStyle, colorScheme: "dark", cursor: "pointer" }}>
            {mesiOptions.map(m => <option key={m.val} value={m.val}>{m.label}</option>)}
          </select>
        </div>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>{t(lang, "export.toMonth")}</label>
          <select value={meseA} onChange={e => setMeseA(e.target.value)}
            style={{ ...inputStyle, colorScheme: "dark", cursor: "pointer" }}>
            {mesiOptions.filter(m => m.val >= meseDa).map(m => <option key={m.val} value={m.val}>{m.label}</option>)}
          </select>
        </div>
      </div>

      {/* Column selector */}
      <div style={{ marginBottom: 18 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <label style={{ ...labelStyle, marginBottom: 0 }}>{t(lang, "export.columnsToExport")}</label>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={selezionaTutte} style={{ background: "none", border: "none", color: "#6C5CE7", fontSize: 11, cursor: "pointer", fontWeight: 600 }}>{t(lang, "export.all")}</button>
            <button onClick={deselezionaTutte} style={{ background: "none", border: "none", color: "#888", fontSize: 11, cursor: "pointer", fontWeight: 600 }}>{t(lang, "export.minimum")}</button>
          </div>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {ALL_COLUMN_IDS.map(id => {
            const active = colonne.includes(id);
            return (
              <button key={id} onClick={() => toggleColonna(id)} style={{
                padding: "7px 12px", borderRadius: 10, cursor: "pointer",
                fontSize: 12, fontWeight: 600, fontFamily: "'DM Sans',sans-serif",
                background: active ? "#6C5CE722" : "#1a1a28",
                border: active ? "2px solid #6C5CE7" : "2px solid #252538",
                color: active ? "#6C5CE7" : "#888",
                transition: "all 0.2s",
              }}>{t(lang, `col.${id}`)}</button>
            );
          })}
        </div>
      </div>

      {/* Sort order */}
      <div style={{ marginBottom: 18 }}>
        <label style={labelStyle}>{t(lang, "export.sortOrder")}</label>
        <select value={ordinamento} onChange={e => setOrdinamento(e.target.value)}
          style={{ ...inputStyle, colorScheme: "dark", cursor: "pointer" }}>
          {sortOptions.map(s => <option key={s.val} value={s.val}>{s.label}</option>)}
        </select>
      </div>

      {/* Preview */}
      <div style={{ background: "#1a1a28", borderRadius: 16, padding: "14px 16px", marginBottom: 20, border: "1px solid #252538" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 13, color: "#ccc", fontWeight: 600 }}>{ordinate.length} {t(lang, "export.transactions")}</div>
            <div style={{ fontSize: 11, color: "#888", marginTop: 2 }}>{colonne.length} {t(lang, "export.columnsSelected")}</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: "#FF6B6B", fontFamily: "'Space Mono',monospace" }}>
              {formattaValuta(ordinate.filter(t => t.tipo === "uscita").reduce((s, t) => s + t.importo, 0))}
            </div>
            <div style={{ fontSize: 10, color: "#888" }}>{t(lang, "export.totalExpenses")}</div>
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
            <div style={{ fontSize: 13, color: "#ccc", fontWeight: 600 }}>{t(lang, "export.includePortfolio")}</div>
            <div style={{ fontSize: 11, color: "#555" }}>{positions.length} {t(lang, "export.positionsToSheet")}</div>
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
        {esportando ? t(lang, "export.generatingFile") : ordinate.length === 0 ? t(lang, "export.noTransactionsInPeriod") : `${t(lang, "export.downloadXlsx")} (${ordinate.length} ${t(lang, "export.rowsPlain")})`}
      </button>

      {/* ─── BACKUP SECTION ─── */}
      <div style={{ fontSize: 22, fontWeight: 800, color: "#eee", marginTop: 32, marginBottom: 6 }}>{t(lang, "export.backupTitle")}</div>
      <div style={{ fontSize: 13, color: "#888", marginBottom: 16 }}>
        {t(lang, "export.backupHint")}
      </div>
      <button onClick={handleDownloadBackup} disabled={backupBusy} style={{
        width: "100%", padding: "14px", border: "1px solid #4ECDC455", borderRadius: 14, cursor: "pointer",
        fontSize: 14, fontWeight: 700, background: "#4ECDC411", color: "#4ECDC4",
        fontFamily: "'DM Sans',sans-serif", marginBottom: 12, opacity: backupBusy ? 0.6 : 1,
      }}>{backupBusy ? t(lang, "export.preparing") : t(lang, "export.downloadBackup")}</button>

      <label style={{
        display: "block", padding: "14px 16px", borderRadius: 14, cursor: "pointer",
        border: "1px dashed #252538", background: "#1a1a28", textAlign: "center",
        color: "#888", fontSize: 13, marginBottom: 12,
      }}>
        {t(lang, "export.restoreFromBackup")}
        <input type="file" accept=".json,application/json" style={{ display: "none" }}
          onChange={e => { const f = e.target.files?.[0]; if (f) handleRestoreFile(f); e.target.value = ""; }} />
      </label>

      {restorePreview && (
        <div style={{ background: "#1a1a28", borderRadius: 16, padding: 16, marginBottom: 16, border: "1px solid #F0A50055" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#F0A500", marginBottom: 8 }}>{t(lang, "export.backupContents")}{restorePreview.data.creato ? ` (${restorePreview.data.creato.slice(0, 10)})` : ""}</div>
          <div style={{ fontSize: 12, color: "#aaa", lineHeight: 1.7 }}>
            {restorePreview.counts.transazioni} {t(lang, "export.transactions")} · {restorePreview.counts.conti} {t(lang, "export.accounts")} · {restorePreview.counts.obiettivi} {t(lang, "export.goals")} · {restorePreview.counts.viaggi} {t(lang, "export.trips")} · {restorePreview.counts.posizioni} {t(lang, "export.portfolioTrades")} · {restorePreview.counts.prezzi} {t(lang, "export.manualPrices")}
          </div>
          <div style={{ fontSize: 11, color: "#F0A500", marginTop: 10 }}>
            {t(lang, "export.restoreWarning")}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button onClick={() => setRestorePreview(null)} style={{ padding: "10px 14px", background: "none", border: "1px solid #333", borderRadius: 10, color: "#888", fontSize: 13, cursor: "pointer" }}>{t(lang, "common.cancel")}</button>
            <button onClick={handleConfirmRestore} disabled={restoreBusy} style={{ flex: 1, padding: "10px", background: "linear-gradient(135deg,#F0A500,#e08e00)", border: "none", borderRadius: 10, color: "#111", fontSize: 13, fontWeight: 700, cursor: "pointer", opacity: restoreBusy ? 0.6 : 1 }}>
              {restoreBusy ? t(lang, "export.restoring") : t(lang, "export.confirmRestore")}
            </button>
          </div>
        </div>
      )}

      {restoreDone && (
        <div style={{ background: "#4ECDC411", borderRadius: 16, padding: 16, marginBottom: 16, border: "1px solid #4ECDC455", fontSize: 13, color: "#4ECDC4" }}>
          {t(lang, "export.restoreComplete")}: {restoreDone.transactions} {t(lang, "export.transactions")}, {restoreDone.accounts} {t(lang, "export.accounts")}, {restoreDone.goals} {t(lang, "export.goals")}, {restoreDone.trips} {t(lang, "export.trips")}, {restoreDone.positions} {t(lang, "export.trades")}. {t(lang, "export.reloadingApp")}
        </div>
      )}
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
  const [lang] = useState(() => detectGuestLang());
  const [mode, setMode] = useState("login"); // "login" | "register" | "change-pin"

  // Login state — numpad
  const [pin, setPin] = useState("");
  const [loginErrore, setLoginErrore] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);
  const [pinShake, setPinShake] = useState(false);
  const PIN_LEN = 6; // lunghezza minima di riferimento per i puntini (non aziona più l'auto-submit)

  // Register state
  const [regNome, setRegNome] = useState("");
  const [regPersone, setRegPersone] = useState([{ nome: "", emoji: "😀" }, { nome: "", emoji: "😊" }]);
  const [regPin, setRegPin] = useState("");
  const [regPinConferma, setRegPinConferma] = useState("");
  const [regEmail, setRegEmail] = useState("");
  const [regErrore, setRegErrore] = useState("");
  const [regLoading, setRegLoading] = useState(false);
  const [regSuccesso, setRegSuccesso] = useState(false);
  const [emojiPickerIdx, setEmojiPickerIdx] = useState(null); // which persona's picker is open

  // Forgot-PIN state: "email" (chiedi indirizzo) → "code" (codice + nuovo PIN)
  const [forgotStep, setForgotStep] = useState(null); // null | "email" | "code"
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotCode, setForgotCode] = useState("");
  const [forgotNewPin, setForgotNewPin] = useState("");
  const [forgotNewPinConferma, setForgotNewPinConferma] = useState("");
  const [forgotErrore, setForgotErrore] = useState("");
  const [forgotLoading, setForgotLoading] = useState(false);
  const [forgotMsg, setForgotMsg] = useState("");

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
      if (newPin.length < 6) return setChangePinErrore(t(lang, "login.pinMin6"));
      setChangePinErrore("");
      setChangePinStep("confirm");
    } else {
      if (newPin !== newPinConferma) {
        setChangePinErrore(t(lang, "login.pinMismatch"));
        setNewPinConferma("");
        return;
      }
      setChangePinLoading(true);
      setChangePinErrore("");
      try {
        await changePin(newPin);
        onLogin();
      } catch (err) {
        setChangePinErrore(err.message || t(lang, "login.errorUpdatePin"));
        setNewPin(""); setNewPinConferma(""); setChangePinStep("new");
      } finally {
        setChangePinLoading(false);
      }
    }
  }

  const submitRef = useRef(null);
  submitRef.current = async (p) => {
    setLoginLoading(true); setLoginErrore(""); setLoginFromCache(false); setLoginSubtitle("");

    // Show "server waking up" hint after 4s if still loading
    const hintTimer = setTimeout(() => {
      setLoginSubtitle(t(lang, "login.serverWakingUp"));
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
      setLoginErrore(err.message || t(lang, "login.invalidPin"));
      setPinShake(true);
      setTimeout(() => { setPinShake(false); setPin(""); }, 450);
    }
    finally {
      clearTimeout(hintTimer);
      setLoginSubtitle("");
      setLoginLoading(false);
    }
  };

  // Auto-submit solo all'ottava cifra (lunghezza massima): non possiamo
  // sapere quante cifre ha il PIN dell'utente finché non l'ha finito di
  // digitare, quindi per ogni lunghezza inferiore si aspetta il tocco
  // esplicito sul pulsante "Accedi".
  useEffect(() => {
    if (pin.length === 8 && !loginLoading) {
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
    if (!regNome.trim()) return setRegErrore(t(lang, "login.enterGroupName"));
    if (personeValide.length === 0) return setRegErrore(t(lang, "login.addAtLeastOnePerson"));
    if (regPin.length < 6) return setRegErrore(t(lang, "login.pinMin6"));
    if (regPin !== regPinConferma) return setRegErrore(t(lang, "login.pinMismatch"));
    if (regEmail.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(regEmail.trim())) return setRegErrore(t(lang, "login.invalidEmail"));
    setRegLoading(true);
    try {
      await register({ nome: regNome.trim(), persone: personeValide.map(p => ({ nome: p.nome.trim(), emoji: p.emoji })), pin: regPin, email: regEmail.trim() || undefined });
      setRegSuccesso(true);
      setTimeout(() => onLogin(), 1200);
    } catch (err) {
      setRegErrore(err.message || t(lang, "login.errorRegistration"));
    } finally { setRegLoading(false); }
  }

  function addPersona() { if (regPersone.length < 6) setRegPersone(p => [...p, { nome: "", emoji: "🙂" }]); }
  function removePersona(i) { setRegPersone(p => p.filter((_, idx) => idx !== i)); setEmojiPickerIdx(null); }
  function updatePersonaNome(i, val) { setRegPersone(p => p.map((x, idx) => idx === i ? { ...x, nome: val } : x)); }
  function updatePersonaEmoji(i, emoji) { setRegPersone(p => p.map((x, idx) => idx === i ? { ...x, emoji } : x)); setEmojiPickerIdx(null); }

  function openForgotPin() {
    setForgotStep("email"); setForgotEmail(""); setForgotCode(""); setForgotNewPin("");
    setForgotNewPinConferma(""); setForgotErrore(""); setForgotMsg("");
  }
  function closeForgotPin() { setForgotStep(null); }

  async function handleForgotRequest() {
    setForgotErrore("");
    if (!forgotEmail.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(forgotEmail.trim()))
      return setForgotErrore(t(lang, "toast.enterValidEmail"));
    setForgotLoading(true);
    try {
      const res = await requestPinReset(forgotEmail.trim());
      setForgotMsg(res.message || t(lang, "login.emailLinkedMsg"));
      setForgotStep("code");
    } catch (err) {
      setForgotErrore(err.message || t(lang, "login.requestFailed"));
    } finally { setForgotLoading(false); }
  }

  async function handleForgotConfirm() {
    setForgotErrore("");
    if (!/^\d{6}$/.test(forgotCode.trim())) return setForgotErrore(t(lang, "login.enterCode6"));
    if (!/^\d{6,8}$/.test(forgotNewPin)) return setForgotErrore(t(lang, "login.newPinLength"));
    if (forgotNewPin !== forgotNewPinConferma) return setForgotErrore(t(lang, "login.pinMismatch"));
    setForgotLoading(true);
    try {
      await confirmPinReset({ email: forgotEmail.trim(), code: forgotCode.trim(), newPin: forgotNewPin });
      closeForgotPin();
      onLogin();
    } catch (err) {
      setForgotErrore(err.message || t(lang, "login.resetFailed"));
    } finally { setForgotLoading(false); }
  }

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
      <div style={{ fontSize: 11, color: "#555", letterSpacing: 2, marginBottom: 32 }}>{t(lang, "header.tracker")}</div>

      {/* PIN change screen */}
      {mode === "change-pin" && (
        <div style={{ width: "100%", maxWidth: 300, textAlign: "center" }}>
          <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>{t(lang, "login.updatePin")}</div>
          <div style={{ fontSize: 13, color: "#888", marginBottom: 24 }}>
            {changePinStep === "new" ? t(lang, "login.choosePinMin6") : t(lang, "login.confirmNewPin")}
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
            }}>{changePinStep === "new" ? t(lang, "login.next") : (changePinLoading ? t(lang, "conti.saving") : t(lang, "login.savePin"))}</button>
          )}
        </div>
      )}

      {/* Mode toggle — hidden during PIN change */}
      {mode !== "change-pin" && <div style={{ display: "flex", background: "#1a1a28", borderRadius: 12, padding: 4, marginBottom: 28, width: "100%", maxWidth: 300 }}>
        {[["login", t(lang, "login.login")], ["register", t(lang, "login.createAccount")]].map(([m, label]) => (
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
              {loginLoading ? t(lang, "login.loggingIn") : t(lang, "login.enterPin")}
            </div>
            {loginSubtitle && (
              <div style={{ textAlign: "center", color: "#6C5CE7", fontSize: 11, marginTop: 4, letterSpacing: 0.3 }}>
                {loginSubtitle}
              </div>
            )}

            <PinDots value={pin} maxLen={Math.max(PIN_LEN, pin.length)} shake={pinShake} />

            {loginErrore && (
              <div style={{ textAlign: "center", color: "#FF6B6B", fontSize: 13, fontWeight: 600, marginBottom: 16 }}>
                {loginErrore}
              </div>
            )}

            <NumPad onDigit={onDigit} onDelete={onDelete} disabled={loginLoading} />

            {/* Spazio sempre riservato: mostrare/nascondere il pulsante con
                opacity invece di montarlo/smontarlo evita che il tastierino
                si sposti mentre l'utente sta ancora digitando il PIN. */}
            {(() => {
              const showAccedi = pin.length >= 4 && pin.length < 8;
              return (
                <div style={{ minHeight: 72 }}>
                  <button
                    onClick={() => submitRef.current(pin)}
                    disabled={loginLoading || !showAccedi}
                    style={{
                      ...sBtn, marginTop: 20, background: "linear-gradient(135deg, #6C5CE7, #a855f7)", color: "#fff",
                      opacity: showAccedi ? (loginLoading ? 0.6 : 1) : 0,
                      pointerEvents: showAccedi ? "auto" : "none",
                      transition: "opacity 0.2s ease",
                    }}
                  >
                    {loginLoading ? t(lang, "login.loggingInShort") : t(lang, "login.login")}
                  </button>
                </div>
              );
            })()}

            <div style={{ textAlign: "center", marginTop: 4 }}>
              <button onClick={openForgotPin} style={{ background: "none", border: "none", color: "#666", fontSize: 12, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", textDecoration: "underline" }}>
                {t(lang, "login.forgotPin")}
              </button>
            </div>
          </>
        ) : regSuccesso ? (
          <div style={{ textAlign: "center", padding: 20 }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>🎉</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: "#4ECDC4" }}>{t(lang, "login.accountCreated")}</div>
            <div style={{ fontSize: 13, color: "#888", marginTop: 6 }}>{t(lang, "login.loggingIn")}</div>
          </div>
        ) : (
          <>
            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>{t(lang, "login.groupName")}</label>
              <input type="text" value={regNome} onChange={e => setRegNome(e.target.value)} placeholder={t(lang, "login.groupNamePlaceholder")}
                style={smallInput} autoFocus />
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>{t(lang, "login.people")}</label>
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
                        placeholder={`${t(lang, "login.personPrefix")} ${i + 1}`} style={{ ...smallInput, flex: 1 }} />
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
                  <button onClick={addPersona} style={{ background: "none", border: "1px dashed #333", borderRadius: 10, color: "#666", cursor: "pointer", padding: "10px", fontSize: 13, fontFamily: "'DM Sans',sans-serif" }}>{t(lang, "login.addPerson")}</button>
                )}
              </div>
            </div>

            <div style={{ marginBottom: 10 }}>
              <label style={labelStyle}>{t(lang, "login.pinLabel")}</label>
              <input type="password" inputMode="numeric" maxLength={8} value={regPin}
                onChange={e => setRegPin(e.target.value.replace(/\D/g, ""))}
                placeholder="••••" style={{ ...smallInput, fontFamily: "'Space Mono',monospace", letterSpacing: 8, textAlign: "center" }} />
            </div>

            <div style={{ marginBottom: 6 }}>
              <label style={labelStyle}>{t(lang, "login.confirmPinLabel")}</label>
              <input type="password" inputMode="numeric" maxLength={8} value={regPinConferma}
                onChange={e => setRegPinConferma(e.target.value.replace(/\D/g, ""))}
                onKeyDown={e => e.key === "Enter" && handleRegister()}
                placeholder="••••" style={{
                  ...smallInput, fontFamily: "'Space Mono',monospace", letterSpacing: 8, textAlign: "center",
                  borderColor: regPinConferma && regPin !== regPinConferma ? "#FF6B6B" : "#252538",
                }} />
            </div>

            <div style={{ marginBottom: 6 }}>
              <label style={labelStyle}>{t(lang, "login.recoveryEmailLabel")}</label>
              <input type="email" inputMode="email" value={regEmail}
                onChange={e => setRegEmail(e.target.value)}
                onKeyDown={e => e.key === "Enter" && handleRegister()}
                placeholder="tuaemail@esempio.com" style={smallInput} />
              <div style={{ fontSize: 11, color: "#666", marginTop: 6 }}>{t(lang, "login.recoveryEmailHint")}</div>
            </div>

            {regErrore && <div style={{ marginTop: 10, textAlign: "center", color: "#FF6B6B", fontSize: 13, fontWeight: 600 }}>{regErrore}</div>}

            <button onClick={handleRegister} disabled={regLoading} style={{
              ...sBtn, background: "linear-gradient(135deg, #6C5CE7, #a855f7)", color: "#fff", opacity: regLoading ? 0.6 : 1,
            }}>{regLoading ? t(lang, "login.creating") : t(lang, "login.createAccount")}</button>
          </>
        )}
      </div>}

      {forgotStep && (
        <div style={{
          position: "fixed", inset: 0, background: "#000000cc", zIndex: 1000,
          display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
        }}>
          <div style={{ background: "#1a1a28", borderRadius: 20, padding: 24, width: "100%", maxWidth: 340, border: "1px solid #252538" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: "#eee" }}>{t(lang, "login.forgotPinTitle")}</div>
              <button onClick={closeForgotPin} style={{ background: "none", border: "none", color: "#666", fontSize: 18, cursor: "pointer" }}>✕</button>
            </div>

            {forgotStep === "email" ? (
              <>
                <div style={{ fontSize: 13, color: "#888", marginBottom: 16 }}>
                  {t(lang, "login.forgotPinEmailHint")}
                </div>
                <input type="email" inputMode="email" autoFocus value={forgotEmail}
                  onChange={e => setForgotEmail(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && handleForgotRequest()}
                  placeholder="tuaemail@esempio.com" style={{ ...smallInput, marginBottom: 12 }} />
                {forgotErrore && <div style={{ color: "#FF6B6B", fontSize: 13, fontWeight: 600, marginBottom: 10, textAlign: "center" }}>{forgotErrore}</div>}
                <button onClick={handleForgotRequest} disabled={forgotLoading} style={{
                  ...sBtn, marginTop: 4, background: "linear-gradient(135deg, #6C5CE7, #a855f7)", color: "#fff", opacity: forgotLoading ? 0.6 : 1,
                }}>{forgotLoading ? t(lang, "login.sendingCode") : t(lang, "login.sendCode")}</button>
              </>
            ) : (
              <>
                {forgotMsg && <div style={{ fontSize: 12, color: "#4ECDC4", marginBottom: 14, textAlign: "center" }}>{forgotMsg}</div>}

                <label style={labelStyle}>{t(lang, "login.codeReceivedLabel")}</label>
                <input type="text" inputMode="numeric" maxLength={6} value={forgotCode}
                  onChange={e => setForgotCode(e.target.value.replace(/\D/g, ""))}
                  placeholder="123456" style={{ ...smallInput, fontFamily: "'Space Mono',monospace", letterSpacing: 6, textAlign: "center", marginBottom: 12 }} />

                <label style={labelStyle}>{t(lang, "login.newPinLabel")}</label>
                <input type="password" inputMode="numeric" maxLength={8} value={forgotNewPin}
                  onChange={e => setForgotNewPin(e.target.value.replace(/\D/g, ""))}
                  placeholder="••••••" style={{ ...smallInput, fontFamily: "'Space Mono',monospace", letterSpacing: 8, textAlign: "center", marginBottom: 12 }} />

                <label style={labelStyle}>{t(lang, "login.confirmNewPinLabel")}</label>
                <input type="password" inputMode="numeric" maxLength={8} value={forgotNewPinConferma}
                  onChange={e => setForgotNewPinConferma(e.target.value.replace(/\D/g, ""))}
                  onKeyDown={e => e.key === "Enter" && handleForgotConfirm()}
                  placeholder="••••••" style={{
                    ...smallInput, fontFamily: "'Space Mono',monospace", letterSpacing: 8, textAlign: "center", marginBottom: 6,
                    borderColor: forgotNewPinConferma && forgotNewPin !== forgotNewPinConferma ? "#FF6B6B" : "#252538",
                  }} />

                {forgotErrore && <div style={{ color: "#FF6B6B", fontSize: 13, fontWeight: 600, marginTop: 6, textAlign: "center" }}>{forgotErrore}</div>}

                <button onClick={handleForgotConfirm} disabled={forgotLoading} style={{
                  ...sBtn, background: "linear-gradient(135deg, #4ECDC4, #3ab8b0)", color: "#0a0a12", opacity: forgotLoading ? 0.6 : 1,
                }}>{forgotLoading ? t(lang, "login.resettingPin") : t(lang, "login.resetPinAndLogin")}</button>

                <button onClick={() => setForgotStep("email")} style={{ width: "100%", background: "none", border: "none", color: "#666", fontSize: 12, cursor: "pointer", marginTop: 10, textDecoration: "underline" }}>
                  {t(lang, "login.noCodeRetry")}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ImpostazioniView({ householdName, householdId, persone, onDeleted, categorie, onCategorieChange, onRestoreTransazione, valutaBase = "EUR", onValutaBaseChange, lang = "it", onLangChange }) {
  const [valutaBusy, setValutaBusy] = useState(false);
  const [valuteDisponibili, setValuteDisponibili] = useState(VALUTE_FALLBACK);

  useEffect(() => {
    fetchExchangeRates().then(r => {
      const codes = Object.keys(r.rates || {});
      if (codes.length > 0) setValuteDisponibili(codes.sort());
    }).catch(() => {});
  }, []);

  async function handleValutaBaseChange(nuovaValuta) {
    if (nuovaValuta === valutaBase) return;
    setValutaBusy(true);
    try {
      await updateValutaBase(nuovaValuta);
      onValutaBaseChange?.(nuovaValuta);
      toast(`${t(lang, "toast.currencyBaseSetPrefix")} ${nuovaValuta}`, "success");
    } catch (e) {
      toast(e.message || t(lang, "toast.errorCurrencyUpdate"), "error");
    } finally {
      setValutaBusy(false);
    }
  }

  const [fase, setFase] = useState("idle"); // idle | confirm | pin | deleting | done
  const [pin, setPin] = useState("");
  const [errore, setErrore] = useState("");

  // Email di recupero
  const [hasRecoveryEmail, setHasRecoveryEmail] = useState(null); // null = ancora in caricamento
  const [recoveryEmailErrDetail, setRecoveryEmailErrDetail] = useState("");
  const [recoveryEmailInput, setRecoveryEmailInput] = useState("");
  const [recoveryEmailBusy, setRecoveryEmailBusy] = useState(false);
  const [editingRecoveryEmail, setEditingRecoveryEmail] = useState(false);

  useEffect(() => { loadRecoveryEmailStatus(); }, []);

  function loadRecoveryEmailStatus() {
    setHasRecoveryEmail(null);
    setRecoveryEmailErrDetail("");
    let done = false;
    (async () => {
      try {
        const h = await fetchHousehold(); // ora rifiuta (throw) su risposta non-ok, non torna più null silenziosamente
        if (!done) setHasRecoveryEmail(!!h.hasRecoveryEmail);
      } catch (e) {
        if (!done) { setHasRecoveryEmail("error"); setRecoveryEmailErrDetail(e.message || t(lang, "settings.unknownError")); }
      }
    })();
    const timeoutId = setTimeout(() => { if (!done) { done = true; setHasRecoveryEmail(prev => prev === null ? "error" : prev); setRecoveryEmailErrDetail(prev => prev || t(lang, "settings.recoveryEmailTimeout")); } }, 8000);
    return () => { done = true; clearTimeout(timeoutId); };
  }

  async function handleSaveRecoveryEmail() {
    const email = recoveryEmailInput.trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      toast(t(lang, "toast.enterValidEmail"), "error");
      return;
    }
    setRecoveryEmailBusy(true);
    try {
      await setRecoveryEmail(email);
      setHasRecoveryEmail(true);
      setEditingRecoveryEmail(false);
      setRecoveryEmailInput("");
      toast(t(lang, "toast.recoveryEmailSaved"), "success");
    } catch (e) { toast(`${t(lang, "toast.errorPrefix")} ${e.message}`, "error"); }
    setRecoveryEmailBusy(false);
  }

  // Widget key state
  const [widgetUrl, setWidgetUrl] = useState(null);
  const [widgetBusy, setWidgetBusy] = useState(false);

  async function handleCreateWidgetKey() {
    setWidgetBusy(true);
    try {
      const key = await createWidgetKey();
      setWidgetUrl(`${getApiBase()}/api/widget?key=${key}`);
      toast(t(lang, "toast.widgetKeyGenerated"), "success");
    } catch (e) { toast(`${t(lang, "toast.errorPrefix")} ${e.message}`, "error"); }
    setWidgetBusy(false);
  }

  async function handleRevokeWidgetKey() {
    if (!confirm(t(lang, "confirm.revokeWidgetKey"))) return;
    setWidgetBusy(true);
    try {
      await revokeWidgetKey();
      setWidgetUrl(null);
      toast(t(lang, "toast.widgetKeyRevoked"), "success");
    } catch (e) { toast(`${t(lang, "toast.errorPrefix")} ${e.message}`, "error"); }
    setWidgetBusy(false);
  }

  // Calendar sync key state
  const [calendarUrl, setCalendarUrl] = useState(null);
  const [calendarBusy, setCalendarBusy] = useState(false);

  async function handleCreateCalendarKey() {
    setCalendarBusy(true);
    try {
      const key = await createCalendarKey();
      setCalendarUrl(`${getApiBase()}/api/calendar.ics?key=${key}`);
      toast(t(lang, "toast.calendarKeyGenerated"), "success");
    } catch (e) { toast(`${t(lang, "toast.errorPrefix")} ${e.message}`, "error"); }
    setCalendarBusy(false);
  }

  async function handleRevokeCalendarKey() {
    if (!confirm(t(lang, "confirm.revokeCalendarKey"))) return;
    setCalendarBusy(true);
    try {
      await revokeCalendarKey();
      setCalendarUrl(null);
      toast(t(lang, "toast.calendarKeyRevoked"), "success");
    } catch (e) { toast(`${t(lang, "toast.errorPrefix")} ${e.message}`, "error"); }
    setCalendarBusy(false);
  }

  // Cestino (trash) state
  const [cestinoAperto, setCestinoAperto] = useState(false);
  const [cestino, setCestino] = useState([]);
  const [cestinoLoading, setCestinoLoading] = useState(false);
  const [cestinoBusyId, setCestinoBusyId] = useState(null);

  async function loadCestino() {
    setCestinoLoading(true);
    try { setCestino(await fetchTrash()); } catch (e) { toast(`${t(lang, "toast.errorLoadTrashPrefix")} ${e.message}`, "error"); }
    setCestinoLoading(false);
  }

  function toggleCestino() {
    const next = !cestinoAperto;
    setCestinoAperto(next);
    if (next) loadCestino();
  }

  async function handleRestore(id) {
    setCestinoBusyId(id);
    try {
      const restored = await restoreTransaction(id);
      setCestino(prev => prev.filter(t => t.id !== id));
      onRestoreTransazione?.(restored);
      toast(t(lang, "toast.txRestored"), "success");
    } catch (e) { toast(`${t(lang, "toast.errorRestoreTxPrefix")} ${e.message}`, "error"); }
    setCestinoBusyId(null);
  }

  async function handlePermanentDelete(id) {
    if (!confirm(t(lang, "confirm.permanentDeleteTx"))) return;
    setCestinoBusyId(id);
    try {
      await permanentDeleteTransaction(id);
      setCestino(prev => prev.filter(t => t.id !== id));
      toast(t(lang, "toast.txPermanentlyDeleted"), "success");
    } catch (e) { toast(`${t(lang, "toast.errorPrefix")} ${e.message}`, "error"); }
    setCestinoBusyId(null);
  }

  async function handleEmptyCestino() {
    if (cestino.length === 0) return;
    if (!confirm(`${t(lang, "confirm.emptyTrashPrefix")} ${cestino.length} ${t(lang, "confirm.emptyTrashSuffix")}`)) return;
    try {
      await emptyTrash();
      setCestino([]);
      toast(t(lang, "toast.trashEmptied"), "success");
    } catch (e) { toast(`${t(lang, "toast.errorPrefix")} ${e.message}`, "error"); }
  }

  function giorniRimanenti(deletedAt) {
    const eliminato = new Date(deletedAt);
    const scadenza = new Date(eliminato.getTime() + 30 * 24 * 60 * 60 * 1000);
    const giorni = Math.ceil((scadenza - new Date()) / (24 * 60 * 60 * 1000));
    return Math.max(giorni, 0);
  }

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
      setErrore(err.message || t(lang, "settings.deleteAccountErrorFallback"));
      setFase("pin");
    }
  }

  return (
    <div style={{ padding: "20px 16px" }}>
      <div style={{ fontSize: 22, fontWeight: 800, color: "#eee", marginBottom: 4 }}>{t(lang, "settings.title")}</div>
      <div style={{ fontSize: 13, color: "#888", marginBottom: 24 }}>{t(lang, "settings.subtitle")}</div>

      {/* Household info card */}
      <div style={{ background: "#1a1a28", borderRadius: 16, padding: "16px", marginBottom: 24, border: "1px solid #252538" }}>
        <div style={{ fontSize: 11, color: "#555", letterSpacing: 1, marginBottom: 8, textTransform: "uppercase" }}>{t(lang, "settings.activeGroup")}</div>
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

      {/* Language */}
      <div style={{ background: "#1a1a28", borderRadius: 16, padding: "16px", marginBottom: 24, border: "1px solid #252538" }}>
        <div style={{ fontSize: 11, color: "#555", letterSpacing: 1, marginBottom: 8, textTransform: "uppercase" }}>{t(lang, "settings.language")}</div>
        <select value={lang} onChange={e => onLangChange?.(e.target.value)} style={{
          width: "100%", padding: "10px 12px", background: "#12121a", border: "1px solid #252538", borderRadius: 10,
          color: "#eee", fontSize: 14, fontWeight: 600, cursor: "pointer",
        }}>
          {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
        </select>
      </div>

      {/* Email di recupero PIN */}
      <div style={{ background: "#1a1a28", borderRadius: 16, padding: "16px", marginBottom: 24, border: "1px solid #252538" }}>
        <div style={{ fontSize: 11, color: "#555", letterSpacing: 1, marginBottom: 8, textTransform: "uppercase" }}>{t(lang, "settings.recoveryEmail")}</div>
        {hasRecoveryEmail === null ? (
          <div style={{ fontSize: 12, color: "#666" }}>{t(lang, "common.loading")}</div>
        ) : hasRecoveryEmail === "error" ? (
          <>
            <div style={{ fontSize: 12, color: "#F0A500", marginBottom: 6 }}>{t(lang, "settings.recoveryEmailCheckFailed")}</div>
            {recoveryEmailErrDetail && (
              <div style={{ fontSize: 10, color: "#888", fontFamily: "'Space Mono',monospace", marginBottom: 10, wordBreak: "break-word" }}>{recoveryEmailErrDetail}</div>
            )}
            <button onClick={loadRecoveryEmailStatus} style={{
              padding: "10px 14px", background: "#F0A50022", border: "1px solid #F0A50055", borderRadius: 10,
              color: "#F0A500", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "'DM Sans',sans-serif",
            }}>{t(lang, "settings.retry")}</button>
          </>
        ) : hasRecoveryEmail && !editingRecoveryEmail ? (
          <>
            <div style={{ fontSize: 12, color: "#4ECDC4", marginBottom: 10 }}>{t(lang, "settings.recoveryEmailSetHint")}</div>
            <button onClick={() => setEditingRecoveryEmail(true)} style={{
              padding: "10px 14px", background: "none", border: "1px solid #252538", borderRadius: 10,
              color: "#888", fontSize: 12, cursor: "pointer", fontFamily: "'DM Sans',sans-serif",
            }}>{t(lang, "settings.changeEmail")}</button>
          </>
        ) : (
          <>
            <div style={{ fontSize: 12, color: "#888", lineHeight: 1.5, marginBottom: 12 }}>
              {hasRecoveryEmail ? t(lang, "settings.enterNewRecoveryEmail") : t(lang, "settings.recoveryEmailMissingHint")}
            </div>
            <input type="email" inputMode="email" value={recoveryEmailInput} onChange={e => setRecoveryEmailInput(e.target.value)}
              placeholder="tuaemail@esempio.com" style={{
                width: "100%", boxSizing: "border-box", padding: "10px 12px", background: "#111119", border: "1px solid #252538",
                borderRadius: 10, color: "#eee", fontSize: 14, fontFamily: "'DM Sans',sans-serif", outline: "none", marginBottom: 10,
              }} />
            <div style={{ display: "flex", gap: 8 }}>
              {editingRecoveryEmail && (
                <button onClick={() => { setEditingRecoveryEmail(false); setRecoveryEmailInput(""); }} style={{
                  padding: "10px 14px", background: "none", border: "1px solid #333", borderRadius: 10, color: "#888", fontSize: 13, cursor: "pointer",
                }}>{t(lang, "common.cancel")}</button>
              )}
              <button onClick={handleSaveRecoveryEmail} disabled={recoveryEmailBusy} style={{
                flex: 1, padding: "10px", background: recoveryEmailInput.trim() ? "linear-gradient(135deg, #6C5CE7, #a855f7)" : "#252538",
                border: "none", borderRadius: 10, color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer",
                fontFamily: "'DM Sans',sans-serif", opacity: recoveryEmailBusy ? 0.6 : 1,
              }}>{recoveryEmailBusy ? t(lang, "settings.savingEmail") : t(lang, "settings.saveEmail")}</button>
            </div>
          </>
        )}
      </div>

      {/* Widget iPhone card */}
      <div style={{ background: "#1a1a28", borderRadius: 16, padding: "16px", marginBottom: 24, border: "1px solid #252538" }}>
        <div style={{ fontSize: 11, color: "#555", letterSpacing: 1, marginBottom: 8, textTransform: "uppercase" }}>{t(lang, "settings.widget")}</div>
        <div style={{ fontSize: 12, color: "#888", lineHeight: 1.5, marginBottom: 12 }}>
          {t(lang, "settings.widgetHint")}
        </div>
        {widgetUrl ? (
          <div>
            <div style={{ fontSize: 10, color: "#F0A500", marginBottom: 6 }}>{t(lang, "settings.widgetCopyNow")}</div>
            <div onClick={() => { navigator.clipboard?.writeText(widgetUrl); toast(t(lang, "toast.urlCopied"), "success"); }} style={{
              background: "#111119", border: "1px solid #4ECDC455", borderRadius: 10, padding: "10px 12px",
              fontSize: 10, fontFamily: "'Space Mono',monospace", color: "#4ECDC4", wordBreak: "break-all", cursor: "pointer", marginBottom: 10,
            }}>{widgetUrl}</div>
            <button onClick={() => { navigator.clipboard?.writeText(widgetUrl); toast(t(lang, "toast.urlCopied"), "success"); }} style={{
              width: "100%", padding: "10px", background: "#4ECDC422", border: "1px solid #4ECDC455", borderRadius: 10,
              color: "#4ECDC4", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", marginBottom: 8,
            }}>{t(lang, "settings.copyUrl")}</button>
          </div>
        ) : (
          <button onClick={handleCreateWidgetKey} disabled={widgetBusy} style={{
            width: "100%", padding: "12px", background: "#6C5CE722", border: "1px solid #6C5CE7", borderRadius: 10,
            color: "#a78bfa", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", marginBottom: 8, opacity: widgetBusy ? 0.6 : 1,
          }}>{widgetBusy ? t(lang, "settings.generatingKey") : t(lang, "settings.generateWidgetKey")}</button>
        )}
        <button onClick={handleRevokeWidgetKey} disabled={widgetBusy} style={{
          width: "100%", padding: "10px", background: "none", border: "1px solid #FF6B6B33", borderRadius: 10,
          color: "#FF6B6B99", fontSize: 12, cursor: "pointer", fontFamily: "'DM Sans',sans-serif",
        }}>{t(lang, "settings.revokeExistingKey")}</button>
        <div style={{ fontSize: 10, color: "#555", marginTop: 8 }}>
          {t(lang, "settings.widgetRegenerateHint")}
        </div>
      </div>

      {/* Calendar sync card */}
      <div style={{ background: "#1a1a28", borderRadius: 16, padding: "16px", marginBottom: 24, border: "1px solid #252538" }}>
        <div style={{ fontSize: 11, color: "#555", letterSpacing: 1, marginBottom: 8, textTransform: "uppercase" }}>{t(lang, "settings.calendar")}</div>
        <div style={{ fontSize: 12, color: "#888", lineHeight: 1.5, marginBottom: 12 }}>
          {t(lang, "settings.calendarHint")}
        </div>
        {calendarUrl ? (
          <div>
            <div onClick={() => { navigator.clipboard?.writeText(calendarUrl); toast(t(lang, "toast.urlCopied"), "success"); }} style={{
              background: "#111119", border: "1px solid #4ECDC455", borderRadius: 10, padding: "10px 12px",
              fontSize: 10, fontFamily: "'Space Mono',monospace", color: "#4ECDC4", wordBreak: "break-all", cursor: "pointer", marginBottom: 10,
            }}>{calendarUrl}</div>
            <button onClick={() => { navigator.clipboard?.writeText(calendarUrl); toast(t(lang, "toast.urlCopied"), "success"); }} style={{
              width: "100%", padding: "10px", background: "#4ECDC422", border: "1px solid #4ECDC455", borderRadius: 10,
              color: "#4ECDC4", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", marginBottom: 8,
            }}>{t(lang, "settings.copyUrl")}</button>
          </div>
        ) : (
          <button onClick={handleCreateCalendarKey} disabled={calendarBusy} style={{
            width: "100%", padding: "12px", background: "#6C5CE722", border: "1px solid #6C5CE7", borderRadius: 10,
            color: "#a78bfa", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", marginBottom: 8, opacity: calendarBusy ? 0.6 : 1,
          }}>{calendarBusy ? t(lang, "settings.generatingKey") : t(lang, "settings.generateCalendarKey")}</button>
        )}
        <button onClick={handleRevokeCalendarKey} disabled={calendarBusy} style={{
          width: "100%", padding: "10px", background: "none", border: "1px solid #FF6B6B33", borderRadius: 10,
          color: "#FF6B6B99", fontSize: 12, cursor: "pointer", fontFamily: "'DM Sans',sans-serif",
        }}>{t(lang, "settings.revokeExistingKey")}</button>
        <div style={{ fontSize: 10, color: "#555", marginTop: 8 }}>
          {t(lang, "settings.calendarSubscribeHint")}
        </div>
      </div>

      {/* Category editor */}
      <div style={{ background: "#1a1a28", borderRadius: 16, padding: 16, marginBottom: 24, border: "1px solid #252538" }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: "#eee", marginBottom: 14 }}>{t(lang, "settings.categories")}</div>
        {categorie.map(c => (
          <div key={c.id}>
            {editingCatId === c.id ? (
              <div style={{ padding: "10px 0", borderBottom: "1px solid #252538" }}>
                <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
                  <input value={editForm.emoji || c.emoji} onChange={e => setEditForm(f => ({ ...f, emoji: e.target.value }))}
                    style={{ ...inputStyle, width: 52, textAlign: "center", fontSize: 18, padding: "8px 4px" }} />
                  <input value={editForm.nome ?? c.nome} onChange={e => setEditForm(f => ({ ...f, nome: e.target.value }))}
                    placeholder={t(lang, "viaggi.categoryNamePlaceholder")} style={{ ...inputStyle, flex: 1, padding: "8px 10px" }} />
                  <input type="color" value={editForm.colore || c.colore} onChange={e => setEditForm(f => ({ ...f, colore: e.target.value }))}
                    style={{ width: 36, height: 36, border: "none", background: "none", cursor: "pointer", padding: 2 }} />
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => setEditingCatId(null)} style={{ flex: 1, padding: "8px", border: "1px solid #252538", borderRadius: 10, background: "transparent", color: "#888", fontSize: 12, cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>{t(lang, "common.cancel")}</button>
                  <button onClick={() => handleSaveEdit(c.id)} style={{ flex: 1, padding: "8px", border: "none", borderRadius: 10, background: "#6C5CE7", color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>{t(lang, "common.save")}</button>
                </div>
              </div>
            ) : (
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0", borderBottom: "1px solid #252538" }}>
                <span style={{ fontSize: 20 }}>{c.emoji}</span>
                <div style={{ width: 10, height: 10, borderRadius: "50%", background: c.colore, flexShrink: 0 }} />
                <span style={{ flex: 1, fontSize: 14, color: "#ccc", fontWeight: 600 }}>{c.nome}</span>
                <button onClick={() => { setEditingCatId(c.id); setEditForm({}); }} style={{ padding: "5px 8px", border: "1px solid #252538", borderRadius: 8, background: "transparent", color: "#888", fontSize: 11, cursor: "pointer" }}>{t(lang, "common.edit")}</button>
                {categorie.length > 1 && (
                  <button onClick={() => handleDeleteCat(c.id)} style={{ padding: "5px 8px", border: "1px solid #FF6B6B33", borderRadius: 8, background: "transparent", color: "#FF6B6B", fontSize: 11, cursor: "pointer" }}>{t(lang, "common.delete")}</button>
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
                placeholder={t(lang, "viaggi.categoryNamePlaceholder")} style={{ ...inputStyle, flex: 1, padding: "8px 10px" }} autoFocus />
              <input type="color" value={newCat.colore} onChange={e => setNewCat(n => ({ ...n, colore: e.target.value }))}
                style={{ width: 36, height: 36, border: "none", background: "none", cursor: "pointer", padding: 2 }} />
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => { setShowNewCat(false); setNewCat({ emoji: "📦", nome: "", colore: "#A8A8A8" }); }} style={{ flex: 1, padding: "8px", border: "1px solid #252538", borderRadius: 10, background: "transparent", color: "#888", fontSize: 12, cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>{t(lang, "common.cancel")}</button>
              <button onClick={handleAddCat} disabled={!newCat.nome.trim()} style={{ flex: 1, padding: "8px", border: "none", borderRadius: 10, background: newCat.nome.trim() ? "#6C5CE7" : "#252538", color: newCat.nome.trim() ? "#fff" : "#555", fontSize: 12, fontWeight: 700, cursor: newCat.nome.trim() ? "pointer" : "default", fontFamily: "'DM Sans',sans-serif" }}>{t(lang, "common.add")}</button>
            </div>
          </div>
        ) : (
          <button onClick={() => setShowNewCat(true)} style={{ marginTop: 12, width: "100%", padding: "10px", border: "1px dashed #252538", borderRadius: 10, background: "transparent", color: "#666", fontSize: 13, cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>
            {t(lang, "settings.newCategory")}
          </button>
        )}
      </div>

      {/* Cestino */}
      <div style={{ background: "#1a1a28", borderRadius: 16, padding: 16, border: "1px solid #252538", marginBottom: 20 }}>
        <div onClick={toggleCestino} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#eee" }}>{t(lang, "settings.trash")}</div>
          <span style={{ fontSize: 13, color: "#666" }}>{cestinoAperto ? "▲" : "▼"}</span>
        </div>
        {cestinoAperto && (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 11, color: "#666", marginBottom: 12, lineHeight: 1.5 }}>
              {t(lang, "settings.trashHint")}
            </div>
            {cestinoLoading ? (
              <div style={{ textAlign: "center", color: "#666", fontSize: 12, padding: 12 }}>{t(lang, "common.loading")}</div>
            ) : cestino.length === 0 ? (
              <div style={{ textAlign: "center", color: "#555", fontSize: 12, padding: 12 }}>{t(lang, "settings.trashEmpty")}</div>
            ) : (
              <>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
                  {cestino.map(item => {
                    const cat = categorie.find(c => c.id === item.categoria);
                    const busy = cestinoBusyId === item.id;
                    return (
                      <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 10, background: "#111119", borderRadius: 12, padding: "10px 12px", opacity: busy ? 0.5 : 1 }}>
                        <span style={{ fontSize: 18, flexShrink: 0 }}>{cat?.emoji || (item.tipo === "entrata" ? "💰" : "📦")}</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: "#ccc", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {item.descrizione || cat?.nome || item.categoria}
                          </div>
                          <div style={{ fontSize: 10, color: "#666" }}>
                            {formattaValuta(item.importo)} · {giorniRimanenti(item.deletedAt)}{t(lang, "stats.daysLeft")}
                          </div>
                        </div>
                        <button disabled={busy} onClick={() => handleRestore(item.id)} style={{ background: "#6C5CE722", border: "1px solid #6C5CE7", borderRadius: 8, color: "#a78bfa", fontSize: 11, fontWeight: 700, padding: "6px 10px", cursor: busy ? "default" : "pointer" }}>{t(lang, "common.restore")}</button>
                        <button disabled={busy} onClick={() => handlePermanentDelete(item.id)} style={{ background: "none", border: "none", color: "#FF6B6B88", fontSize: 16, cursor: busy ? "default" : "pointer", padding: "0 2px" }}>✕</button>
                      </div>
                    );
                  })}
                </div>
                <button onClick={handleEmptyCestino} style={{ width: "100%", padding: "10px", border: "1px solid #2a1a1a", borderRadius: 10, background: "transparent", color: "#FF6B6B", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>
                  {t(lang, "settings.emptyTrash")}
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {/* Base currency */}
      <div style={{ background: "#1a1a28", borderRadius: 16, padding: 16, border: "1px solid #252538", marginBottom: 16 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: "#eee", marginBottom: 6 }}>{t(lang, "settings.currency")}</div>
        <div style={{ fontSize: 12, color: "#888", marginBottom: 10, lineHeight: 1.5 }}>
          {t(lang, "settings.currencyHint")}
        </div>
        <select value={valutaBase} disabled={valutaBusy} onChange={e => handleValutaBaseChange(e.target.value)} style={{
          width: "100%", padding: "10px 12px", background: "#12121a", border: "1px solid #252538", borderRadius: 10,
          color: "#eee", fontSize: 14, fontWeight: 600, cursor: valutaBusy ? "default" : "pointer",
        }}>
          {valuteDisponibili.map(v => <option key={v} value={v}>{v}</option>)}
        </select>
      </div>

      {/* Delete section */}
      <div style={{ background: "#1a1a28", borderRadius: 16, padding: 16, border: "1px solid #2a1a1a" }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: "#FF6B6B", marginBottom: 6 }}>{t(lang, "settings.dangerZone")}</div>
        <div style={{ fontSize: 12, color: "#888", marginBottom: 16, lineHeight: 1.5 }}>
          {t(lang, "settings.dangerZoneHint")}
        </div>

        {fase === "idle" && (
          <button onClick={() => setFase("confirm")} style={{
            width: "100%", padding: "13px", border: "1px solid #FF6B6B33", borderRadius: 12,
            background: "transparent", color: "#FF6B6B", fontFamily: "'DM Sans',sans-serif",
            fontSize: 14, fontWeight: 700, cursor: "pointer",
          }}>
            {t(lang, "settings.deleteAccount")}
          </button>
        )}

        {fase === "confirm" && (
          <div>
            <div style={{ fontSize: 13, color: "#FFD93D", marginBottom: 14, textAlign: "center", lineHeight: 1.5 }}>
              {t(lang, "settings.confirmDeleteWarningPrefix")} <strong style={{ color: "#eee" }}>{householdName}</strong>. {t(lang, "settings.confirmDeleteWarningSuffix")}
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={() => setFase("idle")} style={{
                flex: 1, padding: "12px", border: "1px solid #252538", borderRadius: 12,
                background: "transparent", color: "#888", fontFamily: "'DM Sans',sans-serif",
                fontSize: 14, fontWeight: 600, cursor: "pointer",
              }}>{t(lang, "common.cancel")}</button>
              <button onClick={() => setFase("pin")} style={{
                flex: 1, padding: "12px", border: "none", borderRadius: 12,
                background: "#FF6B6B22", color: "#FF6B6B", fontFamily: "'DM Sans',sans-serif",
                fontSize: 14, fontWeight: 700, cursor: "pointer",
              }}>{t(lang, "common.continue")}</button>
            </div>
          </div>
        )}

        {(fase === "pin" || fase === "deleting") && (
          <div>
            <div style={{ fontSize: 13, color: "#aaa", marginBottom: 10, textAlign: "center" }}>
              {t(lang, "settings.enterPinToConfirmDelete")}
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
              }}>{t(lang, "common.cancel")}</button>
              <button onClick={eseguiElimina} disabled={pin.length < 4 || fase === "deleting"} style={{
                flex: 1, padding: "12px", border: "none", borderRadius: 12,
                background: pin.length >= 4 ? "#FF6B6B" : "#2a1a1a",
                color: pin.length >= 4 ? "#fff" : "#555",
                fontFamily: "'DM Sans',sans-serif", fontSize: 14, fontWeight: 700,
                cursor: pin.length >= 4 ? "pointer" : "default",
                opacity: fase === "deleting" ? 0.6 : 1,
              }}>
                {fase === "deleting" ? t(lang, "settings.deletingAccountShort") : t(lang, "common.delete")}
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
  const [categorieUscita, setCategorieUscita] = useState(() => getCategorieUscita() || defaultCategorie(getLang()).filter(c => c.id !== "entrata"));
  const [valutaBase, setValutaBase] = useState("EUR");
  const [lang, setLangState] = useState(getLang());
  function handleLangChange(l) { setLang(l); setLangState(l); }

  useEffect(() => { fetchHousehold().then(h => setValutaBase(h.valutaBase || "EUR")).catch(() => {}); }, []);

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
      const newProssimaData = calcolaProssimaData(t.ricorrenza.prossimaData, t.ricorrenza.frequenza);
      // Child is a plain transaction — no ricorrenza, so it never re-triggers
      const nuovaTx = { ...t, id: generaId(), data: t.ricorrenza.prossimaData };
      delete nuovaTx._id;
      delete nuovaTx.ricorrenza;
      if (t.ricorrenza.variabile) nuovaTx.daVerificare = true;
      try {
        const saved = await addTransaction(nuovaTx);
        nuove.push(saved);
        // Advance the template's prossimaData so it doesn't fire again this period
        const updatedRicorrenza = { frequenza: t.ricorrenza.frequenza, prossimaData: newProssimaData, variabile: t.ricorrenza.variabile };
        await updateTransaction(t.id, { ricorrenza: updatedRicorrenza });
        setTransazioni(prev => prev.map(tx => tx.id === t.id ? { ...tx, ricorrenza: updatedRicorrenza } : tx));
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
        // generaRicorrenti already ran on localData below; skip here to avoid race duplicates
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

  const [nascondiImporti, setNascondiImporti] = useState(() => {
    try { return localStorage.getItem("nascondiImporti") === "1"; } catch { return false; }
  });
  importiNascosti = nascondiImporti; // sync module flag on every render
  const toggleNascondiImporti = () => {
    setNascondiImporti(v => {
      try { localStorage.setItem("nascondiImporti", v ? "0" : "1"); } catch {}
      return !v;
    });
  };

  const [rootManualPrices, setRootManualPrices] = useState({});
  const loadRootManualPrices = useCallback(async () => {
    try { setRootManualPrices(await fetchManualPrices() || {}); } catch (e) { console.error("loadManualPrices:", e); }
  }, []);

  const [conti, setConti] = useState([]);
  const loadConti = useCallback(async () => {
    try {
      const data = await fetchAccounts();
      setConti(data || []);
    } catch (e) { console.error("loadConti:", e); }
  }, []);

  const handleAddConto = async (conto) => {
    const saved = await addAccount(conto);
    setConti(prev => [...prev, saved]);
  };

  const handleUpdateConto = async (id, updates) => {
    await updateAccount(id, updates);
    setConti(prev => prev.map(c => c.id === id ? { ...c, ...updates } : c));
  };

  const handleDeleteConto = async (id) => {
    await deleteAccount(id);
    setConti(prev => prev.filter(c => c.id !== id));
    // Detach locally too, mirroring the server behaviour
    setTransazioni(prev => prev.map(t => t.contoId === id ? { ...t, contoId: null } : t));
    setGoals(prev => prev.map(g => g.contoId === id ? { ...g, contoId: null } : g));
  };

  const loadCategorie = useCallback(async () => {
    const defaults = defaultCategorie(lang).filter(c => c.id !== "entrata");
    try {
      const cats = await fetchCategorie();
      setCategorieUscita(cats || defaults);
    } catch (e) { console.error("loadCategorie:", e); setCategorieUscita(defaults); }
  }, [lang]);

  useEffect(() => { if (authed) { loadAll(); loadPositions(); loadCategorie(); loadGoals(); loadConti(); loadRootManualPrices(); } }, [authed, loadAll, loadPositions, loadCategorie, loadGoals, loadConti, loadRootManualPrices]);
  // Keep the Patrimonio card fresh: re-read manual prices when returning to home
  useEffect(() => { if (authed && tab === "home") loadRootManualPrices(); }, [tab, authed, loadRootManualPrices]);

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
    setCategorieUscita(defaultCategorie(lang).filter(c => c.id !== "entrata"));
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
          const curr = g.currentAmount || 0;
          if (g.targetAmount > 0 && curr >= g.targetAmount) continue; // goal reached: stop auto-saving
          let contribution = 0;
          if (g.contributionType === "percent") {
            contribution = t.importo * (g.contributionValue / 100);
          } else if (g.contributionType === "fixed") {
            contribution = g.contributionValue;
          }
          // Round to cents and never overshoot the target
          contribution = Math.round(contribution * 100) / 100;
          if (g.targetAmount > 0) contribution = Math.min(contribution, g.targetAmount - curr);
          if (contribution > 0) {
            const newAmount = Math.round((curr + contribution) * 100) / 100;
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

  const viaggioToken = new URLSearchParams(window.location.search).get("viaggio");
  if (viaggioToken) return <TripGuestView token={viaggioToken} />;

  if (!authed) return <LoginScreen onLogin={handleLogin} />;

  const showMonthBar = tab === "home" || tab === "stats";

  return (
    <div style={{ maxWidth: 430, margin: "0 auto", height: "100dvh", background: "#111119", color: "#eee", fontFamily: "'DM Sans', sans-serif", display: "flex", flexDirection: "column", overflow: "hidden", position: "relative" }}>
      <ToastHost />
      {/* Fixed header */}
      <div style={{ padding: "calc(18px + env(safe-area-inset-top, 0px)) 16px 8px", display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: showMonthBar ? "none" : "1px solid #1e1e2e", background: "#111119", flexShrink: 0 }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: -0.5 }}><span style={{ background: "linear-gradient(135deg, #6C5CE7, #a855f7)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>Finanza</span></div>
          <div style={{ fontSize: 10, color: "#555", letterSpacing: 1 }}>{householdName || t(lang, "header.tracker")}</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <button onClick={toggleNascondiImporti} title={nascondiImporti ? t(lang, "header.showAmounts") : t(lang, "header.hideAmounts")} style={{
            background: nascondiImporti ? "#6C5CE722" : "none", border: nascondiImporti ? "1px solid #6C5CE7" : "1px solid #252538",
            borderRadius: 8, cursor: "pointer", color: nascondiImporti ? "#a78bfa" : "#888",
            fontSize: 14, padding: "4px 8px", display: "flex", alignItems: "center",
          }}>{nascondiImporti ? "🙈" : "👁"}</button>
          <button onClick={() => setTab("impostazioni")} title={t(lang, "header.settings")} style={{
            background: "none", border: "1px solid #252538", borderRadius: 8, cursor: "pointer",
            color: "#888", fontSize: 14, padding: "4px 8px", display: "flex", alignItems: "center",
          }}>⚙</button>
          <button onClick={() => window.location.reload()} title={t(lang, "header.reload")} style={{
            background: "none", border: "1px solid #252538", borderRadius: 8, cursor: "pointer",
            color: "#888", fontSize: 14, padding: "4px 8px", display: "flex", alignItems: "center",
          }}>↻</button>
          <button onClick={handleLogout} title={t(lang, "header.logout")} style={{
            background: "none", border: "1px solid #252538", borderRadius: 8, cursor: "pointer",
            color: "#888", fontSize: 12, padding: "4px 8px", display: "flex", alignItems: "center",
            fontFamily: "'DM Sans',sans-serif",
          }}>{t(lang, "header.logout")}</button>
          <div style={{ width: 7, height: 7, borderRadius: "50%", background: isAPIConnected() ? "#4ECDC4" : "#F0A500" }} title={isAPIConnected() ? "MongoDB" : "offline"} />
        </div>
      </div>
      {/* Fixed month selector bar — only for Home and Stats */}
      {showMonthBar && (
        <MonthBar meseOffset={meseOffset} setMeseOffset={setMeseOffset} />
      )}
      {/* Scrollable content */}
      <div style={{ flex: 1, overflowY: "auto", paddingBottom: "calc(48px + env(safe-area-inset-bottom, 0px))" }}>
        {tab === "home" && <HomeView transazioni={transazioni} onDelete={eliminaTransazione} onEdit={modificaTransazione} onSettle={aggiungiSaldo} persone={persone} meseOffset={meseOffset} categorie={categorieUscita} goals={goals} onAddGoal={handleAddGoal} onUpdateGoal={handleUpdateGoal} onDeleteGoal={handleDeleteGoal} conti={conti} onAddConto={handleAddConto} onUpdateConto={handleUpdateConto} onDeleteConto={handleDeleteConto} positions={positions} manualPrices={rootManualPrices} lang={lang} />}
        {tab === "aggiungi" && <AggiungiView key={shortcutKey} onAggiungi={aggiungiTransazione} persone={persone} transazioni={transazioni} categorie={categorieUscita} initialTipo={initialTipo} initialImporto={initialImporto} initialDescrizione={initialDescrizione} initialCategoria={initialCategoria} initialPagatoDa={initialPagatoDa} conti={conti} valutaBase={valutaBase} lang={lang} />}
        {tab === "stats" && <StatsView transazioni={transazioni} persone={persone} meseOffset={meseOffset} categorie={categorieUscita} goals={goals} lang={lang} />}
        {tab === "export" && <ExportView transazioni={transazioni} persone={persone} positions={positions} conti={conti} onImport={aggiungiTransazioneSilente} onImportComplete={loadAll} onImportPosition={aggiungiPositioneSilente} onImportPositionComplete={loadPositions} lang={lang} />}
        {tab === "portfolio" && <PortfolioView lang={lang} />}
        {tab === "viaggi" && <ViaggiView persone={persone} lang={lang} />}
        {tab === "impostazioni" && (
          <ImpostazioniView
            householdName={householdName}
            householdId={getSession()?.householdId}
            persone={persone}
            onDeleted={() => { logout(); setAuthed(false); setTransazioni([]); setTab("home"); }}
            categorie={categorieUscita}
            onCategorieChange={(cats) => { setCategorieUscita(cats); saveCategorie(cats); }}
            onRestoreTransazione={(tx) => setTransazioni(prev => [...prev, tx])}
            valutaBase={valutaBase}
            onValutaBaseChange={setValutaBase}
            lang={lang}
            onLangChange={handleLangChange}
          />
        )}
      </div>
      <TabBar tab={tab} setTab={setTab} householdId={getSession()?.householdId} lang={lang} />
    </div>
  );
}
