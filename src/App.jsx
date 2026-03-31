import { useState, useEffect, useCallback } from "react";
import Tesseract from "tesseract.js";
import { fetchTransactions, addTransaction, deleteTransaction, updateTransaction, isAPIConnected, login, logout, isLoggedIn, getSession, getPersone, getHouseholdName } from "./api.js";

const CATEGORIE = [
  { id: "cibo", nome: "Cibo", emoji: "🍕", colore: "#FF6B6B" },
  { id: "trasporti", nome: "Trasporti", emoji: "🚗", colore: "#4ECDC4" },
  { id: "casa", nome: "Casa", emoji: "🏠", colore: "#45B7D1" },
  { id: "salute", nome: "Salute", emoji: "💊", colore: "#96CEB4" },
  { id: "svago", nome: "Svago", emoji: "🎮", colore: "#FFEAA7" },
  { id: "shopping", nome: "Shopping", emoji: "🛍️", colore: "#DDA0DD" },
  { id: "bollette", nome: "Bollette", emoji: "💡", colore: "#F0A500" },
  { id: "altro", nome: "Altro", emoji: "📦", colore: "#A8A8A8" },
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

// ─── Claude API ───
const API_KEY = import.meta.env.VITE_ANTHROPIC_API_KEY || "";

async function analizzaScontrinoAPI(base64, mediaType) {
  if (!API_KEY) throw new Error("No API key");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
    body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1000,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
        { type: "text", text: 'Analizza questo scontrino. Rispondi SOLO con JSON valido senza backtick: {"importo":<numero>,"descrizione":"<max 30 char>","categoria":"<cibo|trasporti|casa|salute|svago|shopping|bollette|altro>","data":"<YYYY-MM-DD o null>"}' }
      ]}]
    })
  });
  if (!res.ok) throw new Error("API " + res.status);
  const d = await res.json(); if (d.error) throw new Error(d.error.message);
  const txt = (d.content || []).map(c => c.text || "").join("");
  const clean = txt.replace(/```json\s?|```/g, "").trim();
  const m = clean.match(/\{[\s\S]*\}/);
  return JSON.parse(m ? m[0] : clean);
}

// ─── OCR helpers ───
function estraiTotale(testo) {
  const righe = testo.split("\n").map(r => r.trim()).filter(Boolean);
  for (const r of righe) { if (/total/i.test(r)) { const n = r.match(/(\d{1,6}[.,]\d{2})/g); if (n) return parseFloat(n[n.length-1].replace(",",".")); } }
  const all = []; for (const r of righe) { const m = r.match(/(\d{1,6}[.,]\d{2})/g); if (m) m.forEach(x => all.push(parseFloat(x.replace(",",".")))); }
  return all.length > 0 ? Math.max(...all) : null;
}
function estraiData(testo) { const m = testo.match(/(\d{2})[\/\-.](\d{2})[\/\-.](\d{4})/); if (m) return `${m[3]}-${m[2]}-${m[1]}`; const m2 = testo.match(/(\d{4})-(\d{2})-(\d{2})/); return m2?m2[0]:null; }
function indovinaCategoria(testo) {
  const t = testo.toLowerCase();
  if (/supermercato|alimentari|coop|esselunga|conad|lidl|eurospin|pam|despar|carrefour|iper/i.test(t)) return "cibo";
  if (/ristorante|pizzeria|bar |caffè|caffe|trattoria|sushi|mcdonald|burger/i.test(t)) return "cibo";
  if (/farmacia|parafarmacia|sanitaria/i.test(t)) return "salute";
  if (/benzina|carburante|eni|q8|ip |shell|autostrad|parcheggio|taxi|uber|treno|italo|trenitalia/i.test(t)) return "trasporti";
  if (/enel|edison|luce|gas|acqua|telecom|tim|vodafone|wind|fastweb|bolletta/i.test(t)) return "bollette";
  if (/decathlon|zara|h&m|ikea|mediaworld|unieuro|amazon|negozio/i.test(t)) return "shopping";
  if (/cinema|teatro|netflix|spotify|concert|bigliett/i.test(t)) return "svago";
  if (/affitto|condomini|mobil/i.test(t)) return "casa";
  return "altro";
}
function estraiNegozio(testo) {
  for (const r of testo.split("\n").map(r=>r.trim()).filter(Boolean).slice(0,5)) {
    const c = r.replace(/[^a-zA-ZÀ-ú\s&']/g,"").trim();
    if (c.length>=3&&c.length<=40&&!/^(via |tel |p\.?\s?iva|documento|scontrino|fiscale)/i.test(c)) return c;
  } return "";
}

async function ocrFallback(file, onP) {
  const worker = await Tesseract.createWorker("ita", 1, {
    logger: m => { if (m.status === "recognizing text") onP(m.progress || 0); }
  });
  const { data } = await worker.recognize(file);
  await worker.terminate();
  return data.text || "";
}

// ─── Debt calculator ───
function calcolaDebiti(transazioni, persone) {
  const persona1Id = persone[0]?.id;
  let saldo = 0;
  for (const t of transazioni) {
    if (t.tipo !== "uscita" || !t.pagatoDa || t.splitPagante == null) continue;
    const quotaAltro = t.importo * (100 - t.splitPagante) / 100;
    if (t.pagatoDa === persona1Id) saldo += quotaAltro;
    else saldo -= quotaAltro;
  }
  return saldo;
}

// ─── Split selector ───
function SplitSelector({ pagatoDa, setPagatoDa, splitPagante, setSplitPagante, persone }) {
  const pagante = persone.find(p => p.id === pagatoDa) || persone[0];
  const altro = persone.find(p => p.id !== pagatoDa) || persone[1];
  const splitAltro = 100 - splitPagante;
  return (
    <div style={{ marginBottom: 18 }}>
      <label style={labelStyle}>Chi ha pagato?</label>
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        {persone.map(p => (
          <button key={p.id} onClick={() => setPagatoDa(p.id)} style={{
            flex: 1, padding: "12px 8px", border: pagatoDa === p.id ? `2px solid ${p.colore}` : "2px solid #252538",
            borderRadius: 14, cursor: "pointer", background: pagatoDa === p.id ? p.colore + "22" : "#1a1a28",
            display: "flex", alignItems: "center", justifyContent: "center", gap: 8, transition: "all 0.2s",
          }}>
            <span style={{ fontSize: 22 }}>{p.emoji}</span>
            <span style={{ fontSize: 14, fontWeight: 700, color: pagatoDa === p.id ? p.colore : "#888", fontFamily: "'DM Sans',sans-serif" }}>{p.nome}</span>
          </button>
        ))}
      </div>
      <label style={labelStyle}>Divisione spesa</label>
      <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
        {SPLIT_PRESETS.map(sp => {
          const active = splitPagante === sp.value;
          return (
            <button key={sp.value} onClick={() => setSplitPagante(sp.value)} style={{
              flex: 1, padding: "8px 0", border: active ? "2px solid #6C5CE7" : "2px solid #252538",
              borderRadius: 10, cursor: "pointer", background: active ? "#6C5CE722" : "#1a1a28",
              color: active ? "#6C5CE7" : "#888", fontSize: 13, fontWeight: 700, fontFamily: "'DM Sans',sans-serif",
            }}>{sp.label}</button>
          );
        })}
      </div>
      <div style={{ background: "#1a1a28", borderRadius: 12, padding: "10px 14px", border: "1px solid #252538" }}>
        <input type="range" min="0" max="100" value={splitPagante} onChange={e => setSplitPagante(Number(e.target.value))}
          style={{ width: "100%", accentColor: "#6C5CE7", cursor: "pointer" }} />
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
          <span style={{ fontSize: 12, color: pagante.colore, fontWeight: 700, fontFamily: "'Space Mono',monospace" }}>
            {pagante.nome} {splitPagante}%
          </span>
          <span style={{ fontSize: 12, color: altro.colore, fontWeight: 700, fontFamily: "'Space Mono',monospace" }}>
            {altro.nome} {splitAltro}%
          </span>
        </div>
      </div>
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

// ─── Tab bar ───
function TabBar({ tab, setTab }) {
  const tabs = [
    { id: "home", label: "Home", icon: "⌂" },
    { id: "aggiungi", label: "Aggiungi", icon: "+" },
    { id: "scansiona", label: "Scontrino", icon: "📷" },
    { id: "stats", label: "Statistiche", icon: "◔" },
    { id: "export", label: "Esporta", icon: "↓" },
  ];
  return (
    <div style={{ display: "flex", justifyContent: "space-around", background: "#161620", borderTop: "1px solid #2a2a3a", padding: "8px 0 max(12px, env(safe-area-inset-bottom))", position: "sticky", bottom: 0 }}>
      {tabs.map(t => (
        <button key={t.id} onClick={() => setTab(t.id)} style={{
          background: "none", border: "none", cursor: "pointer",
          display: "flex", flexDirection: "column", alignItems: "center", gap: 2,
          color: tab === t.id ? "#6C5CE7" : "#666", transition: "color 0.2s",
        }}>
          <span style={{ fontSize: t.id==="aggiungi"?28:t.id==="scansiona"?20:22, lineHeight: 1,
            fontWeight: t.id==="aggiungi"?300:400,
            ...(t.id==="aggiungi"&&tab!=="aggiungi"?{background:"linear-gradient(135deg,#6C5CE7,#a855f7)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}:{}),
          }}>{t.icon}</span>
          <span style={{ fontSize: 10, fontFamily: "'DM Sans',sans-serif", letterSpacing: 0.3 }}>{t.label}</span>
        </button>
      ))}
    </div>
  );
}

// ─── Home ───
function HomeView({ transazioni, onDelete, onEdit, onSettle, persone }) {
  const oggi = new Date();
  const [meseOffset, setMeseOffset] = useState(0);
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

  const debitoGlobale = calcolaDebiti(transazioni, persone);
  const debitoMese = calcolaDebiti(txMese, persone);
  const p1 = persone[0] || DEFAULT_PERSONE[0];
  const p2 = persone[1] || DEFAULT_PERSONE[1];

  const navBtn = { background: "#1a1a28", border: "1px solid #252538", borderRadius: 10, color: "#eee", fontSize: 16, padding: "5px 12px", cursor: "pointer" };

  return (
    <div style={{ padding: "20px 16px" }}>
      {/* Month selector */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <button onClick={() => setMeseOffset(o => o + 1)} style={navBtn}>◂</button>
        <div style={{ fontSize: 17, fontWeight: 700, color: "#eee", fontFamily: "'DM Sans',sans-serif" }}>{nomeMese}</div>
        <button onClick={() => setMeseOffset(o => Math.max(0, o - 1))} style={{ ...navBtn, opacity: meseOffset === 0 ? 0.3 : 1 }} disabled={meseOffset === 0}>▸</button>
      </div>

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
        <div style={{ fontSize: 11, color: "#999", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 10 }}>Bilancio {p1.nome} ↔ {p2.nome}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
          <div style={{ fontSize: 11, color: "#777", width: 60, flexShrink: 0 }}>{MESI[meseVis.getMonth()]}</div>
          {debitoMese === 0 ? <div style={{ fontSize: 13, color: "#888" }}>Pari</div> : (
            <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1 }}>
              <span style={{ fontSize: 18 }}>{debitoMese > 0 ? p2.emoji : p1.emoji}</span>
              <span style={{ fontSize: 12, color: "#ccc" }}>{debitoMese > 0 ? `${p2.nome} deve a ${p1.nome}` : `${p1.nome} deve a ${p2.nome}`}</span>
              <span style={{ marginLeft: "auto", fontSize: 15, fontWeight: 800, fontFamily: "'Space Mono',monospace", color: debitoMese > 0 ? p1.colore : p2.colore }}>{formattaValuta(Math.abs(debitoMese))}</span>
            </div>
          )}
        </div>
        <div style={{ borderTop: "1px solid #252538", paddingTop: 10, display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ fontSize: 11, color: "#777", width: 60, flexShrink: 0 }}>Totale</div>
          {debitoGlobale === 0 ? <div style={{ fontSize: 13, color: "#888" }}>Pari</div> : (
            <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1 }}>
              <span style={{ fontSize: 18 }}>{debitoGlobale > 0 ? p2.emoji : p1.emoji}</span>
              <span style={{ fontSize: 12, color: "#ccc" }}>{debitoGlobale > 0 ? `${p2.nome} deve a ${p1.nome}` : `${p1.nome} deve a ${p2.nome}`}</span>
              <span style={{ marginLeft: "auto", fontSize: 17, fontWeight: 800, fontFamily: "'Space Mono',monospace", color: debitoGlobale > 0 ? p1.colore : p2.colore }}>{formattaValuta(Math.abs(debitoGlobale))}</span>
            </div>
          )}
        </div>
        {/* Settle button */}
        {debitoGlobale !== 0 && (
          <button onClick={() => {
            const debitore = debitoGlobale > 0 ? p2 : p1;
            const creditore = debitoGlobale > 0 ? p1 : p2;
            const amount = Math.abs(debitoGlobale);
            if (!confirm(`Saldare il debito?\n${debitore.nome} paga ${formattaValuta(amount)} a ${creditore.nome}`)) return;
            // Create a settlement transaction: the debtor "pays" the creditor
            // This is an expense paid by the debtor, 100% for the creditor (splitPagante=0)
            onSettle({
              id: generaId(),
              tipo: "uscita",
              importo: amount,
              categoria: "altro",
              descrizione: `Saldo debito → ${creditore.nome}`,
              data: new Date().toISOString().slice(0, 10),
              pagatoDa: debitore.id,
              splitPagante: 0,
              daScontrino: false,
            });
          }} style={{
            width: "100%", marginTop: 12, padding: "11px", border: "none", borderRadius: 12, cursor: "pointer",
            background: "linear-gradient(135deg, #4ECDC4, #3ab8b0)", color: "#fff",
            fontSize: 13, fontWeight: 700, fontFamily: "'DM Sans',sans-serif",
            boxShadow: "0 4px 16px #4ECDC444",
          }}>
            Salda debito ({formattaValuta(Math.abs(debitoGlobale))})
          </button>
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
  const [splitPagante, setSplitPagante] = useState(t.splitPagante ?? 50);
  const [intestataA, setIntestataA] = useState(t.intestataA || persone[0]?.id || "");
  const [salvato, setSalvato] = useState(false);

  // Reset edit state when transaction changes
  useEffect(() => {
    setTipo(t.tipo); setImporto(String(t.importo)); setCategoria(t.categoria || "altro");
    setDescrizione(t.descrizione || ""); setData(t.data);
    setPagatoDa(t.pagatoDa || persone[0]?.id || ""); setSplitPagante(t.splitPagante ?? 50);
    setIntestataA(t.intestataA || persone[0]?.id || "");
  }, [t, persone]);

  function handleSave() {
    const val = parseFloat(String(importo).replace(",", "."));
    if (!val || val <= 0) return;
    onSave({
      tipo, importo: val, categoria, descrizione: descrizione.trim(), data,
      pagatoDa: tipo === "uscita" ? pagatoDa : null,
      splitPagante: tipo === "uscita" ? splitPagante : null,
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
          {t.daScontrino ? "🧾" : cat.emoji}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "#eee", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.descrizione || cat.nome}</div>
          <div style={{ fontSize: 11, color: "#666", display: "flex", alignItems: "center", gap: 4 }}>
            {formattaData(t.data)}
            {persona && t.tipo === "uscita" && <span style={{ background: persona.colore + "33", color: persona.colore, borderRadius: 6, padding: "1px 5px", fontSize: 10, fontWeight: 600 }}>{persona.emoji} {t.splitPagante != null && t.splitPagante !== 100 ? `${t.splitPagante}%` : ""}</span>}
            {personaIntestata && t.tipo === "entrata" && <span style={{ background: personaIntestata.colore + "33", color: personaIntestata.colore, borderRadius: 6, padding: "1px 5px", fontSize: 10, fontWeight: 600 }}>{personaIntestata.emoji}</span>}
            {t.daScontrino && <span>📷</span>}
          </div>
        </div>
        <div style={{ fontSize: 15, fontWeight: 700, fontFamily: "'Space Mono',monospace", color: t.tipo === "entrata" ? "#4ECDC4" : "#FF6B6B", flexShrink: 0 }}>{t.tipo === "entrata" ? "+" : "-"}{formattaValuta(t.importo)}</div>
      </div>
    );
  }

  // Expanded edit form
  return (
    <div style={{ background: "#1a1a28", borderRadius: 16, padding: "16px", border: "2px solid #6C5CE7", position: "relative", zIndex: 10 }}>
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
            {CATEGORIE.map(c => (
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
        <SplitSelector pagatoDa={pagatoDa} setPagatoDa={setPagatoDa} splitPagante={splitPagante} setSplitPagante={setSplitPagante} persone={persone} />
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
  const [splitPagante, setSplitPagante] = useState(50);
  const [intestataA, setIntestataA] = useState(persone[0]?.id || "");

  function handleSubmit() {
    const val = parseFloat(importo.replace(",", "."));
    if (!val || val <= 0) return;
    onAggiungi({
      id: generaId(), tipo, importo: val, categoria, descrizione: descrizione.trim(), data,
      pagatoDa: tipo === "uscita" ? pagatoDa : null,
      splitPagante: tipo === "uscita" ? splitPagante : null,
      intestataA: tipo === "entrata" ? intestataA : null,
    });
    setImporto(""); setDescrizione(""); setSalvato(true);
    setTimeout(() => setSalvato(false), 1500);
  }

  const val = parseFloat(importo.replace(",",".")) || 0;
  const quotaPagante = val * splitPagante / 100;
  const quotaAltro = val - quotaPagante;
  const pagante = persone.find(p => p.id === pagatoDa) || persone[0];
  const altro = persone.find(p => p.id !== pagatoDa) || persone[1];

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
              {CATEGORIE.map(c => (
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
          <SplitSelector pagatoDa={pagatoDa} setPagatoDa={setPagatoDa} splitPagante={splitPagante} setSplitPagante={setSplitPagante} persone={persone} />
          {val > 0 && splitPagante < 100 && (
            <div style={{ background: "#1e1e30", borderRadius: 12, padding: "10px 14px", marginBottom: 18, border: "1px solid #333355" }}>
              <div style={{ fontSize: 11, color: "#999", marginBottom: 6 }}>Riepilogo divisione</div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, fontFamily: "'Space Mono',monospace" }}>
                <span style={{ color: pagante.colore }}>{pagante.nome}: {formattaValuta(quotaPagante)}</span>
                <span style={{ color: altro.colore }}>{altro.nome}: {formattaValuta(quotaAltro)}</span>
              </div>
              <div style={{ fontSize: 11, color: "#888", marginTop: 4 }}>→ {altro.nome} deve {formattaValuta(quotaAltro)} a {pagante.nome}</div>
            </div>
          )}
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
function ScansionaView({ onAggiungi, persone }) {
  const [anteprima, setAnteprima] = useState(null);
  const [importo, setImporto] = useState("");
  const [categoria, setCategoria] = useState("cibo");
  const [descrizione, setDescrizione] = useState("");
  const [data, setData] = useState(new Date().toISOString().slice(0, 10));
  const [salvato, setSalvato] = useState(false);
  const [stato, setStato] = useState("idle");
  const [progresso, setProgresso] = useState(0);
  const [ocrInfo, setOcrInfo] = useState(null);
  const [pagatoDa, setPagatoDa] = useState(persone[0]?.id || "");
  const [splitPagante, setSplitPagante] = useState(50);

  async function handleFile(e) {
    const file = e.target.files?.[0]; if (!file) return;
    setStato("analisi"); setProgresso(0); setOcrInfo(null); setSalvato(false);
    try { setAnteprima(URL.createObjectURL(file)); } catch (_) {}
    let base64 = null;
    try { base64 = await new Promise((r,j)=>{const f=new FileReader();f.onload=()=>{const s=f.result;typeof s==="string"&&s.includes(",")?r(s.split(",")[1]):j();};f.onerror=j;f.readAsDataURL(file);}); } catch(_){}
    setProgresso(10);
    if (API_KEY && base64) {
      try { setProgresso(20); const mt=file.type?.startsWith("image/")?file.type:"image/jpeg"; const res=await analizzaScontrinoAPI(base64,mt); setProgresso(100);
        if(res.errore)throw new Error(res.errore); setOcrInfo({totale:res.importo,metodo:"AI"});
        if(res.importo)setImporto(String(res.importo)); if(res.data)setData(res.data); if(res.categoria)setCategoria(res.categoria); if(res.descrizione)setDescrizione(res.descrizione);
        setStato("done"); return; } catch(err){console.log("API fallback:",err.message);}
    }
    try { setProgresso(25); const testo=await ocrFallback(file,p=>setProgresso(25+Math.round(p*70))); setProgresso(100);
      if(testo.trim().length<5){setOcrInfo({totale:null,metodo:"manuale"});setStato("done");return;}
      const tot=estraiTotale(testo),dr=estraiData(testo),neg=estraiNegozio(testo);
      setOcrInfo({totale:tot,metodo:"OCR"}); if(tot)setImporto(String(tot)); if(dr)setData(dr); setCategoria(indovinaCategoria(testo)); if(neg)setDescrizione(neg);
      setStato("done");} catch(e){console.error(e);setOcrInfo({totale:null,metodo:"manuale"});setStato("done");}
  }

  function handleConferma() {
    const val=parseFloat(String(importo).replace(",",".")); if(!val||val<=0)return;
    onAggiungi({id:generaId(),tipo:"uscita",importo:val,categoria,descrizione:descrizione.trim(),data,daScontrino:true,pagatoDa,splitPagante});
    setSalvato(true); setTimeout(()=>reset(),1800);
  }
  function reset(){setAnteprima(null);setImporto("");setDescrizione("");setCategoria("cibo");setData(new Date().toISOString().slice(0,10));setStato("idle");setOcrInfo(null);setSalvato(false);}

  return (
    <div style={{ padding: "20px 16px" }}>
      <div style={{ fontSize: 22, fontWeight: 800, color: "#eee", marginBottom: 6 }}>Scansiona scontrino</div>
      <div style={{ fontSize: 13, color: "#888", marginBottom: 20 }}>{API_KEY ? "Carica la foto: l'AI estrae importo e dati" : "Carica la foto: l'OCR estrae il totale"}</div>

      {stato === "idle" && (
        <div style={{ position: "relative", marginBottom: 20 }}>
          <input type="file" accept="image/*" capture="environment" onChange={handleFile} style={{ position: "absolute", inset: 0, opacity: 0, width: "100%", height: "100%", cursor: "pointer", zIndex: 2 }} />
          <div style={{ border: "2px dashed #333355", borderRadius: 20, padding: "44px 20px", textAlign: "center", background: "#1a1a28", pointerEvents: "none" }}>
            <div style={{ fontSize: 48, marginBottom: 10 }}>📸</div>
            <div style={{ fontSize: 15, fontWeight: 700, color: "#ccc", marginBottom: 4 }}>Tocca per scattare o caricare</div>
            <div style={{ fontSize: 12, color: "#666" }}>JPG, PNG — Inquadra bene il totale</div>
          </div>
        </div>
      )}

      {stato === "analisi" && (
        <div style={{ textAlign: "center", padding: "20px 0" }}>
          {anteprima && <div style={{ width: "100%", maxHeight: 180, borderRadius: 16, overflow: "hidden", marginBottom: 20, border: "1px solid #252538" }}><img src={anteprima} alt="" style={{ width: "100%", maxHeight: 180, objectFit: "cover", display: "block" }} /></div>}
          <div style={{ background: "#1a1a28", borderRadius: 16, padding: "20px 24px", border: "1px solid #252538", display: "inline-block" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
              <div style={{ width: 22, height: 22, border: "3px solid #6C5CE733", borderTop: "3px solid #6C5CE7", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
              <span style={{ color: "#ccc", fontSize: 14, fontWeight: 600 }}>Lettura scontrino...</span>
            </div>
            <div style={{ width: 200, height: 6, background: "#252538", borderRadius: 3, overflow: "hidden" }}>
              <div style={{ height: "100%", borderRadius: 3, background: "linear-gradient(90deg,#6C5CE7,#a855f7)", width: `${progresso}%`, transition: "width 0.3s" }} />
            </div>
          </div>
          <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
        </div>
      )}

      {stato === "done" && (
        <div>
          {anteprima && (
            <div style={{ marginBottom: 16, position: "relative" }}>
              <div style={{ width: "100%", maxHeight: 150, borderRadius: 16, overflow: "hidden", border: "1px solid #4ECDC444" }}>
                <img src={anteprima} alt="" style={{ width: "100%", maxHeight: 150, objectFit: "cover", display: "block" }} />
              </div>
              <button onClick={reset} style={{ position: "absolute", top: 8, right: 8, background: "#000a", border: "none", borderRadius: 20, color: "#fff", width: 28, height: 28, cursor: "pointer", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
            </div>
          )}
          <div style={{ display: "inline-flex", alignItems: "center", gap: 6, background: ocrInfo?.totale?"#4ECDC422":"#F0A50022", borderRadius: 16, padding: "6px 14px", marginBottom: 16, border: ocrInfo?.totale?"1px solid #4ECDC444":"1px solid #F0A50044" }}>
            <span style={{ fontSize: 13 }}>{ocrInfo?.totale ? "✨" : "✏️"}</span>
            <span style={{ fontSize: 12, fontWeight: 600, color: ocrInfo?.totale?"#4ECDC4":"#F0A500" }}>
              {ocrInfo?.totale?`Totale rilevato: ${formattaValuta(ocrInfo.totale)}${ocrInfo?.metodo==="AI"?" (AI)":" (OCR)"}`:"Inserisci il totale manualmente"}
            </span>
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={labelStyle}>Totale (€)</label>
            <input type="number" inputMode="decimal" value={importo} onChange={e=>setImporto(e.target.value)} placeholder="0,00"
              style={{ ...inputStyle, fontSize: 26, fontWeight: 800, fontFamily: "'Space Mono',monospace", textAlign: "center", color: "#FF6B6B" }} />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={labelStyle}>Categoria</label>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6 }}>
              {CATEGORIE.map(c => (
                <button key={c.id} onClick={()=>setCategoria(c.id)} style={{
                  background: categoria===c.id?c.colore+"33":"#1a1a28", border: categoria===c.id?`2px solid ${c.colore}88`:"2px solid #252538",
                  borderRadius: 12, padding: "8px 4px", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 3,
                }}><span style={{fontSize:18}}>{c.emoji}</span><span style={{fontSize:9,color:categoria===c.id?c.colore:"#888",fontWeight:600}}>{c.nome}</span></button>
              ))}
            </div>
          </div>
          <SplitSelector pagatoDa={pagatoDa} setPagatoDa={setPagatoDa} splitPagante={splitPagante} setSplitPagante={setSplitPagante} persone={persone} />
          <div style={{ marginBottom: 16 }}>
            <label style={labelStyle}>Descrizione</label>
            <input type="text" value={descrizione} onChange={e=>setDescrizione(e.target.value)} placeholder="Es: Spesa Esselunga..." style={inputStyle} />
          </div>
          <div style={{ marginBottom: 20 }}>
            <label style={labelStyle}>Data</label>
            <input type="date" value={data} onChange={e=>setData(e.target.value)} style={{ ...inputStyle, colorScheme: "dark" }} />
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button onClick={reset} style={{ flex: 1, padding: "14px", border: "1px solid #333", borderRadius: 14, cursor: "pointer", background: "#1a1a28", color: "#999", fontSize: 14, fontWeight: 600 }}>Annulla</button>
            <button onClick={handleConferma} style={{
              flex: 2, padding: "14px", border: "none", borderRadius: 14, cursor: "pointer",
              fontSize: 16, fontWeight: 700, color: "#fff", opacity: importo?1:0.5,
              background: salvato?"linear-gradient(135deg,#4ECDC4,#3ab8b0)":"linear-gradient(135deg,#6C5CE7,#a855f7)", boxShadow: "0 4px 20px #6C5CE744",
            }}>{salvato ? "✓ Aggiunto!" : "Conferma e salva"}</button>
          </div>
        </div>
      )}
    </div>
  );
}

const labelStyle = { display: "block", fontSize: 11, color: "#888", marginBottom: 6, letterSpacing: 0.5, textTransform: "uppercase" };
const inputStyle = { width: "100%", padding: "14px 16px", background: "#1a1a28", border: "1px solid #252538", borderRadius: 14, color: "#eee", fontSize: 15, fontFamily: "'DM Sans',sans-serif", outline: "none", boxSizing: "border-box" };

// ─── Stats ───
function StatsView({ transazioni, persone }) {
  const oggi = new Date();
  const [meseOffset, setMeseOffset] = useState(0);
  const meseVis = new Date(oggi.getFullYear(), oggi.getMonth() - meseOffset, 1);
  const nomeMese = MESI[meseVis.getMonth()] + " " + meseVis.getFullYear();
  const txMese = transazioni.filter(t => { const d=new Date(t.data); return d.getMonth()===meseVis.getMonth()&&d.getFullYear()===meseVis.getFullYear(); });
  const usciteMese = txMese.filter(t => t.tipo === "uscita");
  const totalUscite = usciteMese.reduce((s,t) => s+t.importo, 0);
  const totalEntrate = txMese.filter(t=>t.tipo==="entrata").reduce((s,t)=>s+t.importo,0);
  const perCategoria = CATEGORIE.map(cat=>({...cat,valore:usciteMese.filter(t=>t.categoria===cat.id).reduce((s,t)=>s+t.importo,0)})).filter(c=>c.valore>0).sort((a,b)=>b.valore-a.valore);
  const ultimi6 = Array.from({length:6},(_,i)=>{const m=new Date(oggi.getFullYear(),oggi.getMonth()-(5-i),1);return{label:MESI[m.getMonth()],valore:transazioni.filter(t=>t.tipo==="uscita"&&new Date(t.data).getMonth()===m.getMonth()&&new Date(t.data).getFullYear()===m.getFullYear()).reduce((s,t)=>s+t.importo,0),colore:"#6C5CE7"};});
  const p1 = persone[0] || DEFAULT_PERSONE[0];
  const p2 = persone[1] || DEFAULT_PERSONE[1];
  const p1Speso = usciteMese.filter(t=>t.pagatoDa===p1.id).reduce((s,t)=>s+t.importo,0);
  const p2Speso = usciteMese.filter(t=>t.pagatoDa===p2.id).reduce((s,t)=>s+t.importo,0);
  const debitoMese = calcolaDebiti(txMese, persone);

  // Frequency analysis
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

  const navBtn = { background: "#1a1a28", border: "1px solid #252538", borderRadius: 10, color: "#eee", fontSize: 18, padding: "6px 14px", cursor: "pointer" };

  return (
    <div style={{ padding: "20px 16px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <button onClick={()=>setMeseOffset(o=>o+1)} style={navBtn}>◂</button>
        <div style={{ fontSize: 18, fontWeight: 700, color: "#eee" }}>{nomeMese}</div>
        <button onClick={()=>setMeseOffset(o=>Math.max(0,o-1))} style={{...navBtn,opacity:meseOffset===0?0.3:1}} disabled={meseOffset===0}>▸</button>
      </div>
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
          {debitoMese !== 0 && (
            <div style={{ borderTop: "1px solid #252538", paddingTop: 8, fontSize: 12, color: "#ccc" }}>
              {debitoMese > 0
                ? <span>{p2.emoji} {p2.nome} deve <strong style={{ color: p1.colore }}>{formattaValuta(debitoMese)}</strong> a {p1.nome}</span>
                : <span>{p1.emoji} {p1.nome} deve <strong style={{ color: p2.colore }}>{formattaValuta(Math.abs(debitoMese))}</strong> a {p2.nome}</span>}
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

      {perCategoria.length === 0 && <div style={{ color: "#555", textAlign: "center", padding: 40, fontSize: 14 }}>Nessun dato per questo mese.</div>}
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
  { id: "splitPagante", label: "Split % pagante" },
  { id: "quotaAltro", label: "Quota altra persona (€)" },
  { id: "daScontrino", label: "Da scontrino" },
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
        if (colonne.includes("splitPagante")) row["Split % pagante"] = t.splitPagante != null ? t.splitPagante : "";
        if (colonne.includes("quotaAltro")) row["Quota altra persona (€)"] = t.splitPagante != null ? +(t.importo * (100 - t.splitPagante) / 100).toFixed(2) : "";
        if (colonne.includes("daScontrino")) row["Da scontrino"] = t.daScontrino ? "Sì" : "No";
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

  return (
    <div style={{ maxWidth: 430, margin: "0 auto", minHeight: "100vh", background: "#111119", color: "#eee", fontFamily: "'DM Sans', sans-serif", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "calc(18px + env(safe-area-inset-top, 0px)) 16px 8px", display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: "1px solid #1e1e2e", background: "#111119" }}>
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
      <div style={{ flex: 1, overflowY: "auto", paddingBottom: 10 }}>
        {tab === "home" && <HomeView transazioni={transazioni} onDelete={eliminaTransazione} onEdit={modificaTransazione} onSettle={aggiungiTransazione} persone={persone} />}
        {tab === "aggiungi" && <AggiungiView onAggiungi={aggiungiTransazione} persone={persone} />}
        {tab === "scansiona" && <ScansionaView onAggiungi={aggiungiTransazione} persone={persone} />}
        {tab === "stats" && <StatsView transazioni={transazioni} persone={persone} />}
        {tab === "export" && <ExportView transazioni={transazioni} persone={persone} />}
      </div>
      <TabBar tab={tab} setTab={setTab} />
    </div>
  );
}
