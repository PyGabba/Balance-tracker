import { useState, useEffect } from "react";
import Tesseract from "tesseract.js";

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

const MESI = ["Gen","Feb","Mar","Apr","Mag","Giu","Lug","Ago","Set","Ott","Nov","Dic"];

function generaId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function formattaValuta(n) {
  return new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" }).format(n);
}

function formattaData(d) {
  return new Date(d).toLocaleDateString("it-IT", { day: "numeric", month: "short" });
}

// ─── Storage (localStorage) ───
function loadData() {
  try {
    const raw = localStorage.getItem("finanza-transactions");
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveData(txs) {
  try {
    localStorage.setItem("finanza-transactions", JSON.stringify(txs));
  } catch (e) {
    console.error("Salvataggio fallito", e);
  }
}

// ─── Claude API receipt analysis ───
const API_KEY = import.meta.env.VITE_ANTHROPIC_API_KEY || "";

async function analizzaScontrinoAPI(base64, mediaType) {
  if (!API_KEY) throw new Error("API key non configurata");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
          { type: "text", text: 'Analizza questo scontrino. Rispondi SOLO con JSON valido senza backtick: {"importo":<numero>,"descrizione":"<max 30 char>","categoria":"<cibo|trasporti|casa|salute|svago|shopping|bollette|altro>","data":"<YYYY-MM-DD o null>"}' }
        ]
      }]
    })
  });
  if (!res.ok) throw new Error("API " + res.status);
  const d = await res.json();
  if (d.error) throw new Error(d.error.message);
  const txt = (d.content || []).map(c => c.text || "").join("");
  const clean = txt.replace(/```json\s?|```/g, "").trim();
  const m = clean.match(/\{[\s\S]*\}/);
  return JSON.parse(m ? m[0] : clean);
}

// ─── OCR helpers ───
function estraiTotale(testo) {
  const righe = testo.split("\n").map(r => r.trim()).filter(Boolean);
  for (const r of righe) {
    if (/total/i.test(r)) {
      const nums = r.match(/(\d{1,6}[.,]\d{2})/g);
      if (nums) return parseFloat(nums[nums.length - 1].replace(",", "."));
    }
  }
  const allNums = [];
  for (const r of righe) {
    const matches = r.match(/(\d{1,6}[.,]\d{2})/g);
    if (matches) matches.forEach(m => allNums.push(parseFloat(m.replace(",", "."))));
  }
  return allNums.length > 0 ? Math.max(...allNums) : null;
}

function estraiData(testo) {
  const m = testo.match(/(\d{2})[\/\-.](\d{2})[\/\-.](\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  const m2 = testo.match(/(\d{4})-(\d{2})-(\d{2})/);
  return m2 ? m2[0] : null;
}

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
  const righe = testo.split("\n").map(r => r.trim()).filter(Boolean);
  for (const r of righe.slice(0, 5)) {
    const clean = r.replace(/[^a-zA-ZÀ-ú\s&']/g, "").trim();
    if (clean.length >= 3 && clean.length <= 40 && !/^(via |tel |p\.?\s?iva|documento|scontrino|fiscale)/i.test(clean)) {
      return clean;
    }
  }
  return "";
}

async function ocrFallback(file, onProgress) {
  const worker = await Tesseract.createWorker("ita", 1, {
    logger: m => { if (m.status === "recognizing text") onProgress(m.progress || 0); }
  });
  const { data } = await worker.recognize(file);
  await worker.terminate();
  return data.text || "";
}

// ─── Charts ───
function MiniChart({ dati, maxVal }) {
  if (!dati.length) return null;
  const mx = maxVal || Math.max(...dati.map(d => d.valore), 1);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 100 }}>
      {dati.map((d, i) => (
        <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: 1 }}>
          <div style={{
            width: "100%", maxWidth: 28,
            height: Math.max(2, (d.valore / mx) * 80),
            background: `linear-gradient(180deg, ${d.colore || "#6C5CE7"} 0%, ${d.colore || "#6C5CE7"}88 100%)`,
            borderRadius: "4px 4px 0 0",
            transition: "height 0.5s cubic-bezier(.4,0,.2,1)",
          }} />
          <span style={{ fontSize: 9, color: "#888", marginTop: 4, letterSpacing: -0.3 }}>{d.label}</span>
        </div>
      ))}
    </div>
  );
}

function DonutChart({ segmenti }) {
  const total = segmenti.reduce((s, x) => s + x.valore, 0) || 1;
  let accum = 0;
  const archi = segmenti.map(seg => {
    const pct = seg.valore / total;
    const start = accum;
    accum += pct;
    return { ...seg, start, end: accum, pct };
  });

  function arcPath(start, end, r = 42) {
    const s = start * Math.PI * 2 - Math.PI / 2;
    const e = end * Math.PI * 2 - Math.PI / 2;
    const large = end - start > 0.5 ? 1 : 0;
    const x1 = 50 + r * Math.cos(s), y1 = 50 + r * Math.sin(s);
    const x2 = 50 + r * Math.cos(e), y2 = 50 + r * Math.sin(e);
    return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
  }

  return (
    <svg viewBox="0 0 100 100" width="140" height="140">
      {archi.map((a, i) => (
        <path key={i}
          d={arcPath(a.start, a.end === 1 ? 0.9999 : a.end)}
          fill="none" stroke={a.colore} strokeWidth="12" strokeLinecap="round"
          style={{ filter: "drop-shadow(0 0 3px " + a.colore + "44)" }}
        />
      ))}
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
  ];
  return (
    <div style={{
      display: "flex", justifyContent: "space-around",
      background: "#161620", borderTop: "1px solid #2a2a3a",
      padding: "8px 0 max(12px, env(safe-area-inset-bottom))", position: "sticky", bottom: 0,
    }}>
      {tabs.map(t => (
        <button key={t.id} onClick={() => setTab(t.id)} style={{
          background: "none", border: "none", cursor: "pointer",
          display: "flex", flexDirection: "column", alignItems: "center", gap: 2,
          color: tab === t.id ? "#6C5CE7" : "#666", transition: "color 0.2s",
        }}>
          <span style={{
            fontSize: t.id === "aggiungi" ? 28 : t.id === "scansiona" ? 20 : 22,
            lineHeight: 1, fontWeight: t.id === "aggiungi" ? 300 : 400,
            ...(t.id === "aggiungi" && tab !== "aggiungi" ? {
              background: "linear-gradient(135deg, #6C5CE7, #a855f7)",
              WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
            } : {}),
          }}>{t.icon}</span>
          <span style={{ fontSize: 10, fontFamily: "'DM Sans',sans-serif", letterSpacing: 0.3 }}>{t.label}</span>
        </button>
      ))}
    </div>
  );
}

// ─── Home ───
function HomeView({ transazioni, onDelete }) {
  const oggi = new Date();
  const meseCorrente = transazioni.filter(t => {
    const d = new Date(t.data);
    return d.getMonth() === oggi.getMonth() && d.getFullYear() === oggi.getFullYear();
  });
  const entrate = meseCorrente.filter(t => t.tipo === "entrata").reduce((s, t) => s + t.importo, 0);
  const uscite = meseCorrente.filter(t => t.tipo === "uscita").reduce((s, t) => s + t.importo, 0);
  const saldo = entrate - uscite;
  const recenti = [...transazioni].sort((a, b) => new Date(b.data) - new Date(a.data)).slice(0, 20);

  return (
    <div style={{ padding: "20px 16px" }}>
      <div style={{
        background: "linear-gradient(135deg, #1e1e30 0%, #2a1f4e 100%)",
        borderRadius: 20, padding: "24px 20px", marginBottom: 20,
        border: "1px solid #333355", boxShadow: "0 8px 32px #0005",
      }}>
        <div style={{ fontSize: 12, color: "#999", letterSpacing: 1, textTransform: "uppercase" }}>Saldo di {MESI[oggi.getMonth()]}</div>
        <div style={{
          fontSize: 36, fontWeight: 800, marginTop: 6,
          fontFamily: "'Space Mono', monospace",
          color: saldo >= 0 ? "#4ECDC4" : "#FF6B6B", letterSpacing: -1,
        }}>{saldo >= 0 ? "+" : ""}{formattaValuta(saldo)}</div>
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

      <div style={{ fontSize: 13, color: "#999", marginBottom: 10, letterSpacing: 0.5, textTransform: "uppercase" }}>Ultime transazioni</div>
      {recenti.length === 0 ? (
        <div style={{ color: "#555", textAlign: "center", padding: 40, fontSize: 14 }}>Nessuna transazione ancora.<br/>Premi + per iniziare!</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {recenti.map(t => {
            const cat = CATEGORIE.find(c => c.id === t.categoria) || CATEGORIE[7];
            return (
              <div key={t.id} style={{
                display: "flex", alignItems: "center", gap: 12,
                background: "#1a1a28", borderRadius: 14, padding: "12px 14px",
                border: "1px solid #252538",
              }}>
                <div style={{
                  width: 40, height: 40, borderRadius: 12,
                  background: cat.colore + "22",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 20, flexShrink: 0,
                }}>{t.daScontrino ? "🧾" : cat.emoji}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "#eee", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.descrizione || cat.nome}</div>
                  <div style={{ fontSize: 11, color: "#666" }}>{formattaData(t.data)}{t.daScontrino ? " · 📷" : ""}</div>
                </div>
                <div style={{
                  fontSize: 15, fontWeight: 700, fontFamily: "'Space Mono',monospace",
                  color: t.tipo === "entrata" ? "#4ECDC4" : "#FF6B6B", flexShrink: 0,
                }}>{t.tipo === "entrata" ? "+" : "-"}{formattaValuta(t.importo)}</div>
                <button onClick={() => onDelete(t.id)} style={{
                  background: "none", border: "none", color: "#555", cursor: "pointer",
                  fontSize: 16, padding: "2px 6px", borderRadius: 6, flexShrink: 0,
                }} title="Elimina">×</button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Add ───
function AggiungiView({ onAggiungi }) {
  const [tipo, setTipo] = useState("uscita");
  const [importo, setImporto] = useState("");
  const [categoria, setCategoria] = useState("cibo");
  const [descrizione, setDescrizione] = useState("");
  const [data, setData] = useState(new Date().toISOString().slice(0, 10));
  const [salvato, setSalvato] = useState(false);

  function handleSubmit() {
    const val = parseFloat(importo.replace(",", "."));
    if (!val || val <= 0) return;
    onAggiungi({ id: generaId(), tipo, importo: val, categoria, descrizione: descrizione.trim(), data });
    setImporto(""); setDescrizione(""); setSalvato(true);
    setTimeout(() => setSalvato(false), 1500);
  }

  return (
    <div style={{ padding: "20px 16px" }}>
      <div style={{ fontSize: 22, fontWeight: 800, color: "#eee", marginBottom: 20 }}>Nuova transazione</div>
      <div style={{ display: "flex", background: "#1a1a28", borderRadius: 14, padding: 4, marginBottom: 20, border: "1px solid #252538" }}>
        {["uscita", "entrata"].map(t => (
          <button key={t} onClick={() => setTipo(t)} style={{
            flex: 1, padding: "10px 0", border: "none", borderRadius: 11, cursor: "pointer",
            fontFamily: "'DM Sans',sans-serif", fontSize: 14, fontWeight: 600,
            background: tipo === t ? (t === "uscita" ? "linear-gradient(135deg, #FF6B6B33, #FF6B6B22)" : "linear-gradient(135deg, #4ECDC433, #4ECDC422)") : "transparent",
            color: tipo === t ? (t === "uscita" ? "#FF6B6B" : "#4ECDC4") : "#666",
          }}>{t === "uscita" ? "▼ Uscita" : "▲ Entrata"}</button>
        ))}
      </div>
      <div style={{ marginBottom: 18 }}>
        <label style={labelStyle}>Importo (€)</label>
        <input type="number" inputMode="decimal" value={importo} onChange={e => setImporto(e.target.value)} placeholder="0,00"
          style={{ ...inputStyle, fontSize: 28, fontWeight: 800, fontFamily: "'Space Mono',monospace", textAlign: "center", color: tipo === "uscita" ? "#FF6B6B" : "#4ECDC4" }} />
      </div>
      {tipo === "uscita" && (
        <div style={{ marginBottom: 18 }}>
          <label style={labelStyle}>Categoria</label>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
            {CATEGORIE.map(c => (
              <button key={c.id} onClick={() => setCategoria(c.id)} style={{
                background: categoria === c.id ? c.colore + "33" : "#1a1a28",
                border: categoria === c.id ? `2px solid ${c.colore}88` : "2px solid #252538",
                borderRadius: 14, padding: "10px 4px", cursor: "pointer",
                display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
              }}>
                <span style={{ fontSize: 22 }}>{c.emoji}</span>
                <span style={{ fontSize: 10, color: categoria === c.id ? c.colore : "#888", fontWeight: 600 }}>{c.nome}</span>
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
        background: tipo === "uscita" ? "linear-gradient(135deg, #FF6B6B, #ee5a5a)" : "linear-gradient(135deg, #4ECDC4, #3ab8b0)",
        color: "#fff", boxShadow: tipo === "uscita" ? "0 4px 20px #FF6B6B44" : "0 4px 20px #4ECDC444",
      }}>{salvato ? "✓ Salvato!" : "Salva transazione"}</button>
    </div>
  );
}

// ─── Receipt Scanner ───
function ScansionaView({ onAggiungi }) {
  const [anteprima, setAnteprima] = useState(null);
  const [importo, setImporto] = useState("");
  const [categoria, setCategoria] = useState("cibo");
  const [descrizione, setDescrizione] = useState("");
  const [data, setData] = useState(new Date().toISOString().slice(0, 10));
  const [salvato, setSalvato] = useState(false);
  const [stato, setStato] = useState("idle");
  const [progresso, setProgresso] = useState(0);
  const [errore, setErrore] = useState("");
  const [ocrInfo, setOcrInfo] = useState(null);

  async function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    setStato("analisi");
    setProgresso(0);
    setErrore("");
    setOcrInfo(null);
    setSalvato(false);

    try { setAnteprima(URL.createObjectURL(file)); } catch (_) {}

    // Read base64
    let base64 = null;
    try {
      base64 = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => { const s = r.result; typeof s === "string" && s.includes(",") ? res(s.split(",")[1]) : rej(); };
        r.onerror = rej;
        r.readAsDataURL(file);
      });
    } catch (_) {}

    setProgresso(10);

    // Strategy 1: Claude API
    if (API_KEY && base64) {
      try {
        setProgresso(20);
        const mediaType = file.type?.startsWith("image/") ? file.type : "image/jpeg";
        const result = await analizzaScontrinoAPI(base64, mediaType);
        setProgresso(100);
        if (result.errore) throw new Error(result.errore);
        setOcrInfo({ totale: result.importo, negozio: result.descrizione, metodo: "AI" });
        if (result.importo) setImporto(String(result.importo));
        if (result.data) setData(result.data);
        if (result.categoria) setCategoria(result.categoria);
        if (result.descrizione) setDescrizione(result.descrizione);
        setStato("done");
        return;
      } catch (err) { console.log("API fallback:", err.message); }
    }

    // Strategy 2: Tesseract OCR
    try {
      setProgresso(25);
      const testo = await ocrFallback(file, p => setProgresso(25 + Math.round(p * 70)));
      setProgresso(100);
      if (testo.trim().length < 5) {
        setOcrInfo({ totale: null, metodo: "manuale" });
        setStato("done");
        return;
      }
      const totale = estraiTotale(testo);
      const dataRic = estraiData(testo);
      setOcrInfo({ totale, negozio: estraiNegozio(testo), metodo: "OCR" });
      if (totale) setImporto(String(totale));
      if (dataRic) setData(dataRic);
      setCategoria(indovinaCategoria(testo));
      if (estraiNegozio(testo)) setDescrizione(estraiNegozio(testo));
      setStato("done");
    } catch (ocrErr) {
      console.error("OCR error:", ocrErr);
      setOcrInfo({ totale: null, metodo: "manuale" });
      setStato("done");
    }
  }

  function handleConferma() {
    const val = parseFloat(String(importo).replace(",", "."));
    if (!val || val <= 0) return;
    onAggiungi({ id: generaId(), tipo: "uscita", importo: val, categoria, descrizione: descrizione.trim(), data, daScontrino: true });
    setSalvato(true);
    setTimeout(() => { reset(); }, 1800);
  }

  function reset() {
    setAnteprima(null); setImporto(""); setDescrizione(""); setCategoria("cibo");
    setData(new Date().toISOString().slice(0, 10)); setStato("idle"); setOcrInfo(null); setErrore(""); setSalvato(false);
  }

  return (
    <div style={{ padding: "20px 16px" }}>
      <div style={{ fontSize: 22, fontWeight: 800, color: "#eee", marginBottom: 6 }}>Scansiona scontrino</div>
      <div style={{ fontSize: 13, color: "#888", marginBottom: 20 }}>
        {API_KEY ? "Carica la foto: l'AI estrae importo e dati" : "Carica la foto: l'OCR estrae il totale"}
      </div>

      {stato === "idle" && (
        <div style={{ position: "relative", marginBottom: 20 }}>
          <input type="file" accept="image/*" capture="environment" onChange={handleFile}
            style={{ position: "absolute", inset: 0, opacity: 0, width: "100%", height: "100%", cursor: "pointer", zIndex: 2 }} />
          <div style={{ border: "2px dashed #333355", borderRadius: 20, padding: "44px 20px", textAlign: "center", background: "#1a1a28", pointerEvents: "none" }}>
            <div style={{ fontSize: 48, marginBottom: 10 }}>📸</div>
            <div style={{ fontSize: 15, fontWeight: 700, color: "#ccc", marginBottom: 4 }}>Tocca per scattare o caricare</div>
            <div style={{ fontSize: 12, color: "#666" }}>JPG, PNG — Inquadra bene il totale</div>
          </div>
        </div>
      )}

      {stato === "analisi" && (
        <div style={{ textAlign: "center", padding: "20px 0" }}>
          {anteprima && (
            <div style={{ width: "100%", maxHeight: 180, borderRadius: 16, overflow: "hidden", marginBottom: 20, border: "1px solid #252538" }}>
              <img src={anteprima} alt="Scontrino" style={{ width: "100%", maxHeight: 180, objectFit: "cover", display: "block" }} />
            </div>
          )}
          <div style={{ background: "#1a1a28", borderRadius: 16, padding: "20px 24px", border: "1px solid #252538", display: "inline-block" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
              <div style={{ width: 22, height: 22, border: "3px solid #6C5CE733", borderTop: "3px solid #6C5CE7", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
              <span style={{ color: "#ccc", fontSize: 14, fontWeight: 600 }}>Lettura scontrino...</span>
            </div>
            <div style={{ width: 200, height: 6, background: "#252538", borderRadius: 3, overflow: "hidden" }}>
              <div style={{ height: "100%", borderRadius: 3, background: "linear-gradient(90deg, #6C5CE7, #a855f7)", width: `${progresso}%`, transition: "width 0.3s ease" }} />
            </div>
          </div>
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      )}

      {stato === "done" && (
        <div>
          {anteprima && (
            <div style={{ marginBottom: 16, position: "relative" }}>
              <div style={{ width: "100%", maxHeight: 160, borderRadius: 16, overflow: "hidden", border: "1px solid #4ECDC444" }}>
                <img src={anteprima} alt="Scontrino" style={{ width: "100%", maxHeight: 160, objectFit: "cover", display: "block" }} />
              </div>
              <button onClick={reset} style={{
                position: "absolute", top: 8, right: 8, background: "#000a", border: "none", borderRadius: 20,
                color: "#fff", width: 28, height: 28, cursor: "pointer", fontSize: 14,
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>✕</button>
            </div>
          )}
          <div style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            background: ocrInfo?.totale ? "#4ECDC422" : "#F0A50022",
            borderRadius: 16, padding: "6px 14px", marginBottom: 16,
            border: ocrInfo?.totale ? "1px solid #4ECDC444" : "1px solid #F0A50044",
          }}>
            <span style={{ fontSize: 13 }}>{ocrInfo?.totale ? "✨" : "✏️"}</span>
            <span style={{ fontSize: 12, fontWeight: 600, color: ocrInfo?.totale ? "#4ECDC4" : "#F0A500" }}>
              {ocrInfo?.totale ? `Totale rilevato: ${formattaValuta(ocrInfo.totale)}${ocrInfo?.metodo === "AI" ? " (AI)" : " (OCR)"}` : "Inserisci il totale manualmente"}
            </span>
          </div>

          <div style={{ marginBottom: 16 }}>
            <label style={labelStyle}>Totale scontrino (€)</label>
            <input type="number" inputMode="decimal" value={importo} onChange={e => setImporto(e.target.value)} placeholder="0,00"
              style={{ ...inputStyle, fontSize: 28, fontWeight: 800, fontFamily: "'Space Mono',monospace", textAlign: "center", color: "#FF6B6B" }} />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={labelStyle}>Categoria</label>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6 }}>
              {CATEGORIE.map(c => (
                <button key={c.id} onClick={() => setCategoria(c.id)} style={{
                  background: categoria === c.id ? c.colore + "33" : "#1a1a28",
                  border: categoria === c.id ? `2px solid ${c.colore}88` : "2px solid #252538",
                  borderRadius: 12, padding: "8px 4px", cursor: "pointer",
                  display: "flex", flexDirection: "column", alignItems: "center", gap: 3,
                }}>
                  <span style={{ fontSize: 18 }}>{c.emoji}</span>
                  <span style={{ fontSize: 9, color: categoria === c.id ? c.colore : "#888", fontWeight: 600 }}>{c.nome}</span>
                </button>
              ))}
            </div>
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={labelStyle}>Descrizione</label>
            <input type="text" value={descrizione} onChange={e => setDescrizione(e.target.value)} placeholder="Es: Spesa Esselunga..." style={inputStyle} />
          </div>
          <div style={{ marginBottom: 20 }}>
            <label style={labelStyle}>Data</label>
            <input type="date" value={data} onChange={e => setData(e.target.value)} style={{ ...inputStyle, colorScheme: "dark" }} />
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button onClick={reset} style={{
              flex: 1, padding: "14px", border: "1px solid #333", borderRadius: 14, cursor: "pointer",
              background: "#1a1a28", color: "#999", fontSize: 14, fontWeight: 600,
            }}>Annulla</button>
            <button onClick={handleConferma} style={{
              flex: 2, padding: "14px", border: "none", borderRadius: 14, cursor: "pointer",
              fontSize: 16, fontWeight: 700, color: "#fff", opacity: importo ? 1 : 0.5,
              background: salvato ? "linear-gradient(135deg, #4ECDC4, #3ab8b0)" : "linear-gradient(135deg, #6C5CE7, #a855f7)",
              boxShadow: "0 4px 20px #6C5CE744",
            }}>{salvato ? "✓ Aggiunto!" : "Conferma e salva"}</button>
          </div>
        </div>
      )}
    </div>
  );
}

const labelStyle = { display: "block", fontSize: 11, color: "#888", marginBottom: 6, letterSpacing: 0.5, textTransform: "uppercase" };
const inputStyle = {
  width: "100%", padding: "14px 16px", background: "#1a1a28",
  border: "1px solid #252538", borderRadius: 14, color: "#eee",
  fontSize: 15, fontFamily: "'DM Sans',sans-serif", outline: "none", boxSizing: "border-box",
};

// ─── Stats ───
function StatsView({ transazioni }) {
  const oggi = new Date();
  const [meseOffset, setMeseOffset] = useState(0);
  const meseVis = new Date(oggi.getFullYear(), oggi.getMonth() - meseOffset, 1);
  const nomeMese = MESI[meseVis.getMonth()] + " " + meseVis.getFullYear();
  const txMese = transazioni.filter(t => { const d = new Date(t.data); return d.getMonth() === meseVis.getMonth() && d.getFullYear() === meseVis.getFullYear(); });
  const usciteMese = txMese.filter(t => t.tipo === "uscita");
  const totalUscite = usciteMese.reduce((s, t) => s + t.importo, 0);
  const totalEntrate = txMese.filter(t => t.tipo === "entrata").reduce((s, t) => s + t.importo, 0);
  const perCategoria = CATEGORIE.map(cat => ({ ...cat, valore: usciteMese.filter(t => t.categoria === cat.id).reduce((s, t) => s + t.importo, 0) })).filter(c => c.valore > 0).sort((a, b) => b.valore - a.valore);
  const ultimi6 = Array.from({ length: 6 }, (_, i) => {
    const m = new Date(oggi.getFullYear(), oggi.getMonth() - (5 - i), 1);
    return { label: MESI[m.getMonth()], valore: transazioni.filter(t => t.tipo === "uscita" && new Date(t.data).getMonth() === m.getMonth() && new Date(t.data).getFullYear() === m.getFullYear()).reduce((s, t) => s + t.importo, 0), colore: "#6C5CE7" };
  });
  const navBtn = { background: "#1a1a28", border: "1px solid #252538", borderRadius: 10, color: "#eee", fontSize: 18, padding: "6px 14px", cursor: "pointer" };

  return (
    <div style={{ padding: "20px 16px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <button onClick={() => setMeseOffset(o => o + 1)} style={navBtn}>◂</button>
        <div style={{ fontSize: 18, fontWeight: 700, color: "#eee" }}>{nomeMese}</div>
        <button onClick={() => setMeseOffset(o => Math.max(0, o - 1))} style={{ ...navBtn, opacity: meseOffset === 0 ? 0.3 : 1 }} disabled={meseOffset === 0}>▸</button>
      </div>
      <div style={{ display: "flex", gap: 10, marginBottom: 24 }}>
        <div style={{ flex: 1, background: "#1a1a28", borderRadius: 16, padding: "16px 14px", border: "1px solid #252538" }}>
          <div style={{ fontSize: 10, color: "#6a6", letterSpacing: 0.5, textTransform: "uppercase" }}>Entrate</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: "#4ECDC4", fontFamily: "'Space Mono',monospace", marginTop: 4 }}>{formattaValuta(totalEntrate)}</div>
        </div>
        <div style={{ flex: 1, background: "#1a1a28", borderRadius: 16, padding: "16px 14px", border: "1px solid #252538" }}>
          <div style={{ fontSize: 10, color: "#a66", letterSpacing: 0.5, textTransform: "uppercase" }}>Uscite</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: "#FF6B6B", fontFamily: "'Space Mono',monospace", marginTop: 4 }}>{formattaValuta(totalUscite)}</div>
        </div>
      </div>
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
      <div style={{ background: "#1a1a28", borderRadius: 20, padding: 20, border: "1px solid #252538" }}>
        <div style={{ fontSize: 12, color: "#999", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 16 }}>Trend uscite (6 mesi)</div>
        <MiniChart dati={ultimi6} />
      </div>
      {perCategoria.length === 0 && <div style={{ color: "#555", textAlign: "center", padding: 40, fontSize: 14 }}>Nessun dato per questo mese.</div>}
    </div>
  );
}

// ─── Main App ───
export default function FinanzaApp() {
  const [tab, setTab] = useState("home");
  const [transazioni, setTransazioni] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => { setTransazioni(loadData()); setLoading(false); }, []);
  useEffect(() => { if (!loading) saveData(transazioni); }, [transazioni, loading]);

  function aggiungiTransazione(t) { setTransazioni(prev => [...prev, t]); setTab("home"); }
  function eliminaTransazione(id) { setTransazioni(prev => prev.filter(t => t.id !== id)); }

  if (loading) return (
    <div style={{ minHeight: "100vh", background: "#111119", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ color: "#6C5CE7", fontSize: 18 }}>Caricamento...</div>
    </div>
  );

  return (
    <div style={{ maxWidth: 430, margin: "0 auto", minHeight: "100vh", background: "#111119", color: "#eee", fontFamily: "'DM Sans', sans-serif", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "18px 16px 8px", display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: "1px solid #1e1e2e" }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: -0.5 }}>
            <span style={{ background: "linear-gradient(135deg, #6C5CE7, #a855f7)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>Finanza</span>
          </div>
          <div style={{ fontSize: 10, color: "#555", letterSpacing: 1 }}>TRACKER</div>
        </div>
        <div style={{ fontSize: 11, color: "#666", fontFamily: "'Space Mono',monospace" }}>{new Date().toLocaleDateString("it-IT", { day: "numeric", month: "long", year: "numeric" })}</div>
      </div>
      <div style={{ flex: 1, overflowY: "auto", paddingBottom: 10 }}>
        {tab === "home" && <HomeView transazioni={transazioni} onDelete={eliminaTransazione} />}
        {tab === "aggiungi" && <AggiungiView onAggiungi={aggiungiTransazione} />}
        {tab === "scansiona" && <ScansionaView onAggiungi={aggiungiTransazione} />}
        {tab === "stats" && <StatsView transazioni={transazioni} />}
      </div>
      <TabBar tab={tab} setTab={setTab} />
    </div>
  );
}
