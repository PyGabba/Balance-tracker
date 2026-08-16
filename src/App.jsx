import { useState, useEffect, useCallback, useRef } from "react";
import { App as CapApp } from "@capacitor/app";
import { fetchTransactions, addTransaction, deleteTransaction, updateTransaction, isAPIConnected, logout, isLoggedIn, getSession, getPersone, getHouseholdName, fetchPositions, addPosition, fetchManualPrices, wakeupServer, getCategorieUscita, fetchCategorie, saveCategorie, setAuthErrorHandler, fetchGoals, addGoal, updateGoal, deleteGoal, fetchAccounts, addAccount, updateAccount, deleteAccount, fetchHousehold } from "./api.js";
import { calcolaDebitiMatrix, calcolaSaldiConti, calcolaValorePortfolio, filtraTransazioni, contaFiltriAttivi } from "./lib/finance.js";
import { LANGUAGES, getLang, setLang, t, mese, detectGuestLang } from "./lib/i18n.js";
import { toast, ToastHost } from "./components/Toast.jsx";
import { SyncStatusBadge } from "./components/SyncStatusBadge.jsx";
import { setImportiNascosti as setImportiNascostiFormat, importoOscurabile, formattaValuta, formattaData } from "./lib/format.js";
import { defaultCategorie, generaId, splitsTotalOk, evalImporto, getAllPersone } from "./lib/appHelpers.js";
import { TransactionRow } from "./features/transactions/TransactionRow.jsx";
import { AggiungiView } from "./features/transactions/AggiungiView.jsx";
import { calcolaProssimaData } from "./features/transactions/helpers.js";
import { GoalGauge } from "./features/goals/GoalGauge.jsx";
import { GoalRow } from "./features/goals/GoalRow.jsx";
import { GoalsForm } from "./features/goals/GoalsForm.jsx";
import { ContiCard } from "./features/accounts/ContiCard.jsx";
import { FilterChip } from "./components/ui/FilterChip.jsx";
import { filterLabelStyle, inputStyle } from "./components/ui/styles.js";
import { LoginScreen } from "./features/auth/LoginScreen.jsx";
import { ViaggiView } from "./features/trips/ViaggiView.jsx";
import { TripGuestView } from "./features/trips/TripGuestView.jsx";
import { PortfolioView } from "./features/portfolio/PortfolioView.jsx";
import { MiniChart, DonutChart } from "./components/ui/Charts.jsx";
import { MonthBar } from "./components/ui/MonthBar.jsx";
import { StatsView } from "./features/statistics/StatsView.jsx";
import { ExportView } from "./features/settings/ExportView.jsx";
import { ImpostazioniView } from "./features/settings/ImpostazioniView.jsx";
import { DebtSummary } from "./features/debts/DebtSummary.jsx";


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
  const [search, setSearch] = useState("");
  const FILTRI_VUOTI = { tipo: "", categoria: "", personaId: "", contoId: "", minImporto: "", maxImporto: "" };
  const [filtri, setFiltri] = useState(FILTRI_VUOTI);
  const [showFiltri, setShowFiltri] = useState(false);
  const [tuttiIMesi, setTuttiIMesi] = useState(false);
  const [showAddGoal, setShowAddGoal] = useState(false);

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

      <DebtSummary meseVis={meseVis} debitiMese={debitiMese} debitiGlobale={debitiGlobale} allPeople={allPeople} transazioni={transazioni} onDelete={onDelete} onSettle={onSettle} lang={lang} />

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
