import { useState, useEffect, useCallback, useRef } from "react";
import { App as CapApp } from "@capacitor/app";
import { fetchTransactions, addTransaction, deleteTransaction, updateTransaction, isAPIConnected, logout, isLoggedIn, getSession, getPersone, getHouseholdName, fetchPositions, addPosition, fetchManualPrices, wakeupServer, deleteHousehold, getCategorieUscita, fetchCategorie, saveCategorie, setAuthErrorHandler, fetchGoals, addGoal, updateGoal, deleteGoal, fetchAccounts, addAccount, updateAccount, deleteAccount, downloadBackup, restoreBackup, createWidgetKey, revokeWidgetKey, createCalendarKey, revokeCalendarKey, getApiBase, setRecoveryEmail, fetchHousehold, fetchTrash, restoreTransaction, permanentDeleteTransaction, emptyTrash, updateValutaBase, fetchExchangeRates } from "./api.js";
import { calcolaDebitiMatrix, calcolaSaldiConti, calcolaValorePortfolio, filtraTransazioni, contaFiltriAttivi } from "./lib/finance.js";
import { LANGUAGES, getLang, setLang, t, mese, detectGuestLang } from "./lib/i18n.js";
import { toast, ToastHost } from "./components/Toast.jsx";
import { SyncStatusBadge } from "./components/SyncStatusBadge.jsx";
import { setImportiNascosti as setImportiNascostiFormat, importoOscurabile, formattaValuta, formattaData } from "./lib/format.js";
import { defaultCategorie, generaId, splitsTotalOk, evalImporto, getAllPersone } from "./lib/appHelpers.js";
import { TransactionRow } from "./features/transactions/TransactionRow.jsx";
import { AggiungiView } from "./features/transactions/AggiungiView.jsx";
import { calcolaProssimaData, VALUTE_FALLBACK } from "./features/transactions/helpers.js";
import { GoalGauge } from "./features/goals/GoalGauge.jsx";
import { GoalRow } from "./features/goals/GoalRow.jsx";
import { GoalsForm } from "./features/goals/GoalsForm.jsx";
import { ContiCard } from "./features/accounts/ContiCard.jsx";
import { FilterChip } from "./components/ui/FilterChip.jsx";
import { filterLabelStyle } from "./components/ui/styles.js";
import { LoginScreen } from "./features/auth/LoginScreen.jsx";
import { ViaggiView } from "./features/trips/ViaggiView.jsx";
import { TripGuestView } from "./features/trips/TripGuestView.jsx";
import { PortfolioView } from "./features/portfolio/PortfolioView.jsx";
import { MiniChart, DonutChart } from "./components/ui/Charts.jsx";
import { MonthBar } from "./components/ui/MonthBar.jsx";
import { StatsView } from "./features/statistics/StatsView.jsx";


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


// ─── Scanner ───

const labelStyle = { display: "block", fontSize: 11, color: "#888", marginBottom: 6, letterSpacing: 0.5, textTransform: "uppercase" };
const inputStyle = { width: "100%", maxWidth: "100%", padding: "14px 16px", background: "#1a1a28", border: "1px solid #252538", borderRadius: 14, color: "#eee", fontSize: 15, fontFamily: "'DM Sans',sans-serif", outline: "none", boxSizing: "border-box", WebkitAppearance: "none" };

// ─── Stats ───
// ─── Portfolio View ───
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
  setImportiNascostiFormat(nascondiImporti); // sync module flag on every render
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
    } catch (err) {
      // Server-rejected writes (bad splits, unknown account/participant,
      // exchange-rate unavailable, etc.) used to be swallowed silently here
      // and the transaction quietly saved to local storage instead — the
      // user had no idea it failed. Now surfaced like every other error in
      // the app (see api.js: ApiRequestError vs. genuine network failure).
      console.error("Add error:", err);
      toast(`${t(lang, "toast.errorSavePrefix")} ${err.message}`, "error");
    }
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
    } catch (err) {
      console.error("Saldo error:", err);
      toast(`${t(lang, "toast.errorSavePrefix")} ${err.message}`, "error");
    }
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
    } catch (err) {
      console.error("Delete error:", err);
      toast(`${t(lang, "toast.errorDeletePrefix")} ${err.message}`, "error");
    }
  }

  async function modificaTransazione(id, updates) {
    try {
      const updated = await updateTransaction(id, updates);
      setTransazioni(prev => prev.map(t => t.id === id ? { ...t, ...updated } : t));
    } catch (err) {
      console.error("Update error:", err);
      toast(`${t(lang, "toast.errorSavePrefix")} ${err.message}`, "error");
    }
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
          <SyncStatusBadge lang={lang} />
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
