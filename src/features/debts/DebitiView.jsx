import { useState } from "react";
import { t, mese } from "../../lib/i18n.js";
import { formattaValuta, formattaData } from "../../lib/format.js";
import { generaId } from "../../lib/appHelpers.js";
import { buildSettlementTransaction } from "../../services/debtService.js";
import { color, alpha, moneyFont, displayFont } from "../../components/ui/styles.js";

// Small colored initial-circle avatar — used in the debt rows below instead
// of relying solely on a persona's emoji, so a row reads at a glance even
// when two people share the same emoji.
function Avatar({ persona }) {
  const initial = (persona.nome || "?").trim().charAt(0).toUpperCase();
  return (
    <div style={{
      width: 28, height: 28, borderRadius: "50%", flexShrink: 0,
      background: alpha(persona.colore || color.textMuted, 0.13), border: `1.5px solid ${alpha(persona.colore || color.textMuted, 0.47)}`,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: 13, fontWeight: 700, color: persona.colore || color.textSecondary,
    }}>
      {persona.emoji || initial}
    </div>
  );
}

// ─── Debiti — full-screen sub-page ───
// Reached from HomeView's compact debt card. Owns the settle-flow UI state
// and settlement history — the debt math itself (debitiMese/debitiGlobale/
// allPeople) is computed once in App.jsx and shared with the compact card,
// this component is presentation only.
export function DebitiView({ meseVis, debitiMese, debitiGlobale, allPeople, transazioni, onDelete, onSettle, onClose, lang = "it" }) {
  const [settlingKey, setSettlingKey] = useState(null);
  const [settleAmount, setSettleAmount] = useState("");
  const [showStoricoSaldi, setShowStoricoSaldi] = useState(true);

  const renderRow = (d, i, amountSize) => {
    const pDa = allPeople.find(p => p.id === d.da) || { nome: d.da, emoji: "👤", colore: color.textMuted };
    const pA = allPeople.find(p => p.id === d.a) || { nome: d.a, emoji: "👤", colore: color.textMuted };
    return (
      <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: 14, background: color.surface, borderRadius: 14, border: `1px solid ${color.border}`, marginBottom: 8 }}>
        <Avatar persona={pDa} />
        <span style={{ color: color.debt, fontSize: 12 }}>→</span>
        <Avatar persona={pA} />
        <div style={{ flex: 1, fontSize: 13, color: color.textSecondary, minWidth: 0 }}>{pDa.nome} <span style={{ color: color.textMuted }}>{t(lang, "home.owes")}</span> {pA.nome}</div>
        <div style={{ fontSize: amountSize, fontWeight: 700, fontFamily: moneyFont, color: color.debt, fontVariantNumeric: "tabular-nums" }}>{formattaValuta(d.importo)}</div>
      </div>
    );
  };

  const saldati = transazioni
    .filter(t => t.tipo === "saldo")
    .sort((a, b) => new Date(b.data) - new Date(a.data));

  return (
    <div style={{ position: "fixed", inset: 0, maxWidth: 430, margin: "0 auto", background: color.bg, zIndex: 200, overflowY: "auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "calc(18px + env(safe-area-inset-top, 0px)) 16px 18px", borderBottom: `1px solid ${color.border}` }}>
        <button onClick={onClose} style={{ background: "none", border: "none", color: color.textSecondary, fontSize: 22, cursor: "pointer", padding: "0 6px", lineHeight: 1 }}>‹</button>
        <div style={{ fontSize: 16, fontWeight: 700, color: color.textPrimary, fontFamily: displayFont }}>{t(lang, "home.debtBalance")}</div>
      </div>

      <div style={{ padding: 16 }}>
        {/* This month */}
        <div style={{ fontSize: 11, color: color.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>{mese(meseVis.getMonth(), lang)}</div>
        {debitiMese.length === 0 ? (
          <div style={{ fontSize: 13, color: color.textSecondary, marginBottom: 20 }}>{t(lang, "home.allSquare")}</div>
        ) : (
          <div style={{ marginBottom: 20 }}>{debitiMese.map((d, i) => renderRow(d, i, 15))}</div>
        )}

        {/* All-time */}
        <div style={{ fontSize: 11, color: color.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>{t(lang, "home.total")}</div>
        {debitiGlobale.length === 0 ? (
          <div style={{ fontSize: 13, color: color.textSecondary, marginBottom: 16 }}>{t(lang, "home.allSquare")}</div>
        ) : (
          <div style={{ marginBottom: 8 }}>{debitiGlobale.map((d, i) => renderRow(d, i, 17))}</div>
        )}

        {/* Settle flow */}
        {debitiGlobale.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 8 }}>
            {debitiGlobale.map((d, i) => {
              const pDa = allPeople.find(p => p.id === d.da) || { nome: d.da, emoji: "👤" };
              const pA = allPeople.find(p => p.id === d.a) || { nome: d.a, emoji: "👤" };
              const key = `${d.da}->${d.a}`;
              if (settlingKey === key) {
                return (
                  <div key={i} style={{ background: color.surface, borderRadius: 12, padding: 12, border: `1px solid ${alpha(color.positive, 0.2)}` }}>
                    <div style={{ fontSize: 12, color: color.textSecondary, marginBottom: 8 }}>
                      {pDa.emoji} {pDa.nome} → {pA.emoji} {pA.nome} <span style={{ color: color.textMuted }}>(max {formattaValuta(d.importo)})</span>
                    </div>
                    <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
                      <input
                        type="number" inputMode="decimal"
                        value={settleAmount}
                        onChange={e => setSettleAmount(e.target.value)}
                        style={{ flex: 1, padding: "9px 12px", background: color.bg, border: `1px solid ${alpha(color.positive, 0.33)}`, borderRadius: 10, color: color.textPrimary, fontSize: 15, fontFamily: moneyFont, outline: "none", boxSizing: "border-box" }}
                      />
                      <button onClick={() => setSettleAmount(String(d.importo))} style={{ padding: "9px 10px", border: `1px solid ${alpha(color.positive, 0.2)}`, borderRadius: 10, background: `${alpha(color.positive, 0.07)}`, color: color.positive, fontSize: 11, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap", fontFamily: displayFont }}>{t(lang, "home.max")}</button>
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button onClick={() => { setSettlingKey(null); setSettleAmount(""); }} style={{ flex: 1, padding: "9px", border: `1px solid ${color.border}`, borderRadius: 10, background: "transparent", color: color.textMuted, fontSize: 12, cursor: "pointer", fontFamily: displayFont }}>{t(lang, "home.cancel")}</button>
                      <button onClick={() => {
                        onSettle(buildSettlementTransaction(d, settleAmount, { generaId, recipientName: pA.nome }));
                        setSettlingKey(null); setSettleAmount("");
                      }} style={{ flex: 2, padding: "9px", border: "none", borderRadius: 10, background: color.positive, color: color.bg, fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: displayFont }}>
                        {t(lang, "home.confirmSettle")}
                      </button>
                    </div>
                  </div>
                );
              }
              return (
                <button key={i} onClick={() => { setSettlingKey(key); setSettleAmount(String(d.importo)); }} style={{
                  width: "100%", padding: 13, borderRadius: 12, cursor: "pointer",
                  background: `${alpha(color.positive, 0.1)}`, color: color.positive, border: `1px solid ${alpha(color.positive, 0.4)}`,
                  fontSize: 13, fontWeight: 700, fontFamily: displayFont,
                }}>
                  {t(lang, "home.settle")} {pDa.nome} → {pA.nome} ({formattaValuta(d.importo)})
                </button>
              );
            })}
          </div>
        )}

        {/* Settlement history */}
        {saldati.length > 0 && (
          <div style={{ marginTop: 26, borderTop: `1px solid ${color.border}`, paddingTop: 16 }}>
            <button onClick={() => setShowStoricoSaldi(v => !v)} style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", background: "none", border: "none", padding: 0, cursor: "pointer", marginBottom: showStoricoSaldi ? 12 : 0 }}>
              <span style={{ fontSize: 11, color: color.textMuted, letterSpacing: 0.5, textTransform: "uppercase" }}>{t(lang, "home.settleHistory")} ({saldati.length})</span>
              <span style={{ fontSize: 10, color: color.accent, transform: showStoricoSaldi ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.2s ease", display: "inline-block" }}>▼</span>
            </button>
            {showStoricoSaldi && (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {saldati.map((s, i) => {
                  const pDa = allPeople.find(p => p.id === s.pagatoDa) || { nome: s.pagatoDa, emoji: "👤" };
                  const pA = allPeople.find(p => p.id === s.ricevutoDa) || { nome: s.ricevutoDa, emoji: "👤" };
                  return (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0" }}>
                      <span style={{ fontSize: 13, color: color.positive }}>✓</span>
                      <span style={{ fontSize: 12, color: color.textMuted, flex: 1 }}>{pDa.nome} → {pA.nome}</span>
                      <span style={{ fontSize: 12, color: color.positive, fontFamily: moneyFont, fontWeight: 600 }}>{formattaValuta(s.importo)}</span>
                      <span style={{ fontSize: 11, color: color.textMuted, marginLeft: 4 }}>{formattaData(s.data)}</span>
                      <button onClick={() => onDelete(s.id)} style={{ background: "none", border: "none", color: `${alpha(color.negative, 0.53)}`, cursor: "pointer", fontSize: 12, padding: "0 2px", lineHeight: 1 }} title={t(lang, "home.deleteSettle")}>✕</button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
