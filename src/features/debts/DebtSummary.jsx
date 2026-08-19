import { useState } from "react";
import { t, mese } from "../../lib/i18n.js";
import { formattaValuta, formattaData } from "../../lib/format.js";
import { generaId } from "../../lib/appHelpers.js";
import { buildSettlementTransaction } from "../../services/debtService.js";

// ─── Debt summary card (MOD-013) ───
// Shows this month's and all-time debts between household members, lets
// the user settle a debt (full or partial), and shows settlement history.
// Extracted from HomeView, which still owns the actual data (debitiMese/
// debitiGlobale/allPeople are computed there from the full transaction
// list — this component is presentation + its own settle-flow UI state).
export function DebtSummary({ meseVis, debitiMese, debitiGlobale, allPeople, transazioni, onDelete, onSettle, lang = "it" }) {
  const [settlingKey, setSettlingKey] = useState(null);
  const [settleAmount, setSettleAmount] = useState("");
  const [showStoricoSaldi, setShowStoricoSaldi] = useState(false);

  return (
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
                        onSettle(buildSettlementTransaction(d, settleAmount, { generaId, recipientName: pA.nome }));
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
  );
}
