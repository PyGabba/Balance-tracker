import { useState } from "react";
import { calcolaDebitiMatrix, calcolaSaldiConti, calcolaValorePortfolio, filtraTransazioni, contaFiltriAttivi } from "../lib/finance.js";
import { t, mese } from "../lib/i18n.js";
import { formattaValuta } from "../lib/format.js";
import { getAllPersone, generaId } from "../lib/appHelpers.js";
import { filterLabelStyle, inputStyle } from "../components/ui/styles.js";
import { FilterChip } from "../components/ui/FilterChip.jsx";
import { TransactionRow } from "../features/transactions/TransactionRow.jsx";
import { GoalRow } from "../features/goals/GoalRow.jsx";
import { GoalsForm } from "../features/goals/GoalsForm.jsx";
import { ContiCard } from "../features/accounts/ContiCard.jsx";
import { DebtSummary } from "../features/debts/DebtSummary.jsx";

// DEFAULT_PERSONE fallback for offline/localStorage mode, used only when
// a household somehow has zero configured persone (shouldn't normally
// happen post-login, but keeps p1/p2 lookups below from ever being
// undefined).
const DEFAULT_PERSONE = [
  { id: "persona1", nome: "Persona 1", emoji: "👤", colore: "#E84393" },
  { id: "persona2", nome: "Persona 2", emoji: "👤", colore: "#0984E3" },
];

export function HomeView({ transazioni, onDelete, onEdit, onSettle, persone, meseOffset, categorie, goals, onAddGoal, onUpdateGoal, onDeleteGoal, conti = [], onAddConto, onUpdateConto, onDeleteConto, positions = [], manualPrices = {}, lang = "it" }) {
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
