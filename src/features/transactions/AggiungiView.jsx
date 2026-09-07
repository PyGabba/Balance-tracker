import { useState, useEffect, useRef } from "react";
import { fetchExchangeRates } from "../../api.js";
import { t } from "../../lib/i18n.js";
import { formattaValuta } from "../../lib/format.js";
import { evalImporto, splitsTotalOk, generaId } from "../../lib/appHelpers.js";
import { toast } from "../../components/Toast.jsx";
import { labelStyle, inputStyle, color, alpha, accentGradient, moneyFont, displayFont } from "../../components/ui/styles.js";
import { SplitSelector } from "./components/SplitSelector.jsx";
import { ReceiptScanner } from "./components/ReceiptScanner.jsx";
import { calcolaProssimaData, VALUTE_FALLBACK, RICORRENZA_IDS } from "./helpers.js";

// ─── Add ───
export function AggiungiView({ onAggiungi, persone, transazioni = [], categorie, conti = [], initialTipo = "uscita", initialImporto = "", initialDescrizione = "", initialCategoria = "", initialPagatoDa = "", valutaBase = "EUR", lang = "it" }) {
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
      if (!contoDa || !contoA) return;
      if (contoDa === contoA) { toast(t(lang, "form.transferSameAccountError"), "error"); return; }
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
    if (tipo === "uscita" && !splitsTotalOk(splits)) {
      const total = (splits || []).reduce((s, x) => s + (x.quota || 0), 0);
      toast(t(lang, "form.splitTotalError").replace("{total}", String(Math.round(total * 100) / 100)), "error");
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
      <div style={{ fontSize: 22, fontWeight: 800, color: color.textPrimary, marginBottom: 20 }}>{t(lang, "aggiungi.title")}</div>
      <div style={{ marginBottom: 16 }}><ReceiptScanner onScanComplete={handleReceiptScan} /></div>
      <div style={{ display: "flex", background: color.surface, borderRadius: 14, padding: 4, marginBottom: 20, border: `1px solid ${color.border}` }}>
        {["uscita", "entrata", ...(conti.length >= 2 ? ["trasferimento"] : [])].map(tp => (
          <button key={tp} onClick={() => setTipo(tp)} style={{
            flex: 1, padding: "10px 0", border: "none", borderRadius: 11, cursor: "pointer",
            fontFamily: displayFont, fontSize: 14, fontWeight: 600,
            background: tipo===tp?(tp==="uscita"?`${alpha(color.negative, 0.13)}`:tp==="trasferimento"?color.accentSoft:`${alpha(color.positive, 0.13)}`):"transparent",
            color: tipo===tp?(tp==="uscita"?color.negative:tp==="trasferimento"?color.accent:color.positive):color.textMuted,
          }}>{tp === "uscita" ? t(lang, "type.expense") : tp === "entrata" ? t(lang, "type.income") : t(lang, "type.transfer")}</button>
        ))}
      </div>
      <div style={{ marginBottom: 18 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <label style={{ ...labelStyle, marginBottom: 0 }}>{t(lang, "home.filterAmount")}</label>
          {tipo !== "trasferimento" && (
            <select value={valuta} onChange={e => setValuta(e.target.value)} style={{
              background: valuta !== valutaBase ? `${alpha(color.accent, 0.13)}` : color.surface,
              border: `1px solid ${valuta !== valutaBase ? `${alpha(color.accent, 0.4)}` : color.border}`,
              borderRadius: 10, color: valuta !== valutaBase ? color.accent : color.textSecondary,
              fontFamily: displayFont, fontSize: 13, fontWeight: 700, letterSpacing: 0.3,
              padding: "8px 14px", cursor: "pointer", appearance: "none", WebkitAppearance: "none",
              backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%2372809c' stroke-width='1.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")",
              backgroundRepeat: "no-repeat", backgroundPosition: "right 10px center", paddingRight: 28,
            }}>
              {valuteDisponibili.map(v => <option key={v} value={v}>{v}</option>)}
            </select>
          )}
        </div>
        <input type="text" ref={importoInputRef} inputMode="decimal" value={importoRaw} onChange={e => { setImportoRaw(e.target.value); setImporto(evalImporto(e.target.value)); }} placeholder="0€"
          style={{ ...inputStyle, fontSize: 28, fontWeight: 800, fontFamily: moneyFont, fontVariantNumeric: "tabular-nums", textAlign: "center", color: tipo==="uscita"?color.negative:tipo==="trasferimento"?color.accent:color.positive }} />
        {valuta !== valutaBase && (
          <div style={{ fontSize: 11, color: color.accent, textAlign: "center", marginTop: 4 }}>
            {t(lang, "aggiungi.convertedPrefix")} {valutaBase} {t(lang, "aggiungi.convertedSuffix")}
          </div>
        )}
        {isComputed && (
          <div style={{ fontSize: 12, color: color.accent, textAlign: "center", marginTop: 4, fontFamily: moneyFont, fontVariantNumeric: "tabular-nums" }}>
            = {formattaValuta(computedImporto)}
          </div>
        )}
        {/* Calculator keypad */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6 }}>
            {["+", "-", "*", "/"].map(op => (
              <button key={op} onClick={(e) => { e.preventDefault(); const newVal = importoRaw + op; setImportoRaw(newVal); setImporto(evalImporto(newVal)); importoInputRef.current?.focus(); }}
                style={{ padding: "10px", background: color.surface, border: `1px solid ${color.border}`, borderRadius: 10, color: color.accent, fontSize: 18, fontWeight: 700, cursor: "pointer" }}>
                {op}
              </button>
            ))}
          </div>
          <button onClick={(e) => { e.preventDefault(); setImportoRaw(String(computedImporto)); setImporto(computedImporto); importoInputRef.current?.focus(); }}
            style={{ padding: "10px", background: color.accent, border: "none", borderRadius: 10, color: "#fff", fontSize: 18, fontWeight: 700, fontFamily: moneyFont, fontVariantNumeric: "tabular-nums", cursor: "pointer" }}>
            = {formattaValuta(computedImporto)}
          </button>
        </div>
      </div>
      {tipo === "uscita" && (
        <>
          <div style={{ marginBottom: 18 }}>
            <label style={labelStyle}>{t(lang, "home.filterCategory")}</label>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
              {categorie.map(c => (
                <button key={c.id} onClick={() => setCategoria(c.id)} style={{
                  background: categoria===c.id?c.colore+"33":color.surface, border: categoria===c.id?`2px solid ${c.colore}88`:`2px solid ${color.border}`,
                  borderRadius: 14, padding: "10px 4px", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
                }}>
                  <span style={{ fontSize: 22 }}>{c.emoji}</span>
                  <span style={{ fontSize: 10, color: categoria===c.id?c.colore:color.textMuted, fontWeight: 600 }}>{c.nome}</span>
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
                flex: "1 1 auto", minWidth: 0, padding: "12px 8px", border: intestataA === p.id ? `2px solid ${p.colore}` : `2px solid ${color.border}`,
                borderRadius: 14, cursor: "pointer", background: intestataA === p.id ? p.colore + "22" : color.surface,
                display: "flex", alignItems: "center", justifyContent: "center", gap: 8, transition: "all 0.2s",
              }}>
                <span style={{ fontSize: 22 }}>{p.emoji}</span>
                <span style={{ fontSize: 14, fontWeight: 700, color: intestataA === p.id ? p.colore : color.textMuted, fontFamily: displayFont }}>{p.nome}</span>
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
              background: color.surface, border: `1px solid ${color.border}`, borderRadius: 14,
              marginTop: 4, overflow: "hidden", boxShadow: "0 8px 24px rgba(0,0,0,.35)",
            }}>
              {suggestions.map((s, i) => (
                <div
                  key={i}
                  onMouseDown={() => { setDescrizione(s); setSuggestOpen(false); }}
                  style={{
                    padding: "12px 16px", cursor: "pointer", fontSize: 14,
                    color: color.textPrimary, fontFamily: displayFont,
                    borderBottom: i < suggestions.length - 1 ? `1px solid ${color.border}` : "none",
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = color.border}
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
                padding: "8px 12px", borderRadius: 10, cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: displayFont,
                background: contoDa === c.id ? `${alpha(color.negative, 0.13)}` : color.surface,
                border: contoDa === c.id ? `1px solid ${color.negative}` : `1px solid ${color.border}`,
                color: contoDa === c.id ? color.negative : color.textMuted,
              }}>{c.icona} {c.nome}</button>
            ))}
          </div>
          <label style={labelStyle}>{t(lang, "aggiungi.toAccount")}</label>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {conti.map(c => (
              <button key={c.id} onClick={() => setContoA(c.id)} disabled={c.id === contoDa} style={{
                padding: "8px 12px", borderRadius: 10, cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: displayFont,
                background: contoA === c.id ? `${alpha(color.positive, 0.13)}` : color.surface,
                border: contoA === c.id ? `1px solid ${color.positive}` : `1px solid ${color.border}`,
                color: c.id === contoDa ? color.textMuted : contoA === c.id ? color.positive : color.textMuted,
                opacity: c.id === contoDa ? 0.4 : 1,
              }}>{c.icona} {c.nome}</button>
            ))}
          </div>
          {contoDa && contoA && contoDa !== contoA && (
            <div style={{ fontSize: 11, color: color.accent, marginTop: 8 }}>
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
              padding: "8px 12px", borderRadius: 10, cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: displayFont,
              background: contoId === "" ? `${alpha(color.accent, 0.13)}` : color.surface,
              border: contoId === "" ? `1px solid ${color.accent}` : `1px solid ${color.border}`,
              color: contoId === "" ? color.accent : color.textMuted,
            }}>{t(lang, "form.none")}</button>
            {conti.map(c => (
              <button key={c.id} onClick={() => setContoId(c.id)} style={{
                padding: "8px 12px", borderRadius: 10, cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: displayFont,
                background: contoId === c.id ? `${alpha(color.accent, 0.13)}` : color.surface,
                border: contoId === c.id ? `1px solid ${color.accent}` : `1px solid ${color.border}`,
                color: contoId === c.id ? color.accent : color.textMuted,
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
              fontFamily: displayFont,
              background: ricorrenza === id ? `${alpha(color.accent, 0.13)}` : color.surface,
              border: ricorrenza === id ? `2px solid ${color.accent}` : `2px solid ${color.border}`,
              color: ricorrenza === id ? color.accent : color.textMuted,
              transition: "all 0.15s",
            }}>{t(lang, `recur.${id}`)}</button>
          ))}
        </div>
        {ricorrenza !== "no" && (
          <>
            <div style={{ fontSize: 11, color: color.accent, marginTop: 8 }}>
              {t(lang, "aggiungi.nextOccurrence")} {calcolaProssimaData(data, ricorrenza)}
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, cursor: "pointer" }}>
              <input type="checkbox" checked={importoVariabile} onChange={e => setImportoVariabile(e.target.checked)} style={{ width: 16, height: 16, accentColor: color.accent }} />
              <span style={{ fontSize: 12, color: color.textSecondary }}>{t(lang, "aggiungi.variableAmountFull")}</span>
            </label>
          </>
        )}
      </div>}
      <button onClick={handleSubmit} style={{
        width: "100%", padding: "15px", border: "none", borderRadius: 14, cursor: "pointer",
        fontSize: 15, fontWeight: 700, fontFamily: displayFont,
        background: tipo==="uscita"?color.negative:tipo==="trasferimento"?accentGradient:color.positive,
        color: "#fff", boxShadow: tipo==="uscita"?`0 4px 20px ${alpha(color.negative, 0.27)}`:tipo==="trasferimento"?`0 4px 20px ${alpha(color.accent, 0.27)}`:`0 4px 20px ${alpha(color.positive, 0.27)}`,
      }}>{salvato ? t(lang, "form.saved") : tipo === "trasferimento" ? t(lang, "aggiungi.transferSubmit") : t(lang, "aggiungi.saveTransaction")}</button>
    </div>
  );
}
