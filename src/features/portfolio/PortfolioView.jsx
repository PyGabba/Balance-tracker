import { useState, useEffect } from "react";
import { fetchPositions, addPosition, deletePosition, fetchManualPrices, saveManualPricesRemote, fetchQuotes, getSession } from "../../api.js";
import { t } from "../../lib/i18n.js";
import { formattaValuta, importoOscurabile } from "../../lib/format.js";
import { toast } from "../../components/Toast.jsx";
import { labelStyle, inputStyle, color, alpha, accentGradient, moneyFont, displayFont } from "../../components/ui/styles.js";
import { DonutChart } from "../../components/ui/Charts.jsx";
import { computeHoldingsBreakdown } from "../../services/portfolioService.js";

export function PortfolioView({ lang = "it" }) {
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

  // Average-cost accounting (realized P&L, open vs. closed positions) is
  // computed by services/portfolioService.js — pure, tested in isolation,
  // shared with anything else that needs the same accounting rules instead
  // of a second copy drifting from calcolaValorePortfolio in lib/finance.js.
  const { holdings, closedHoldings, totalRealizzato } = computeHoldingsBreakdown(positions);

  async function handleAdd() {
    if (!ticker.trim() || !quantita || !prezzoAcquisto) return;
    setAdding(true);
    try {
      const pos = await addPosition({
        ticker: ticker.trim().toUpperCase(), nome: nome.trim() || ticker.trim().toUpperCase(),
        quantita: parseFloat(quantita.replace(",", ".")), prezzoAcquisto: parseFloat(prezzoAcquisto.replace(",", ".")),
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

  // ── Live prices (Yahoo Finance, best-effort) ──
  // Fetched only on demand via the refresh button below, never on load —
  // but the last-fetched values are persisted to localStorage (scoped by
  // household, same convention as offlineDb.js) so they survive a reload
  // instead of vanishing until the next manual refresh. A ticker Yahoo
  // can't resolve just stays out of autoPrices, and the price resolution
  // below already falls back to the manual override / cost basis for
  // anything missing here.
  function autoPricesStorageKey() {
    const householdId = getSession()?.householdId;
    return householdId ? `portfolioAutoPrices:${householdId}` : null;
  }
  const [autoPrices, setAutoPrices] = useState(() => {
    try {
      const key = autoPricesStorageKey();
      return key ? JSON.parse(localStorage.getItem(key) || "{}") : {};
    } catch { return {}; }
  });
  const [refreshingPrices, setRefreshingPrices] = useState(false);
  const tickerKey = holdings.map(h => h.ticker).sort().join(",");

  function persistAutoPrices(updated) {
    setAutoPrices(updated);
    try {
      const key = autoPricesStorageKey();
      if (key) localStorage.setItem(key, JSON.stringify(updated));
    } catch {}
  }

  async function handleRefreshPrices() {
    if (!tickerKey || refreshingPrices) return;
    setRefreshingPrices(true);
    const before = tickerKey.split(",").length;
    const q = await fetchQuotes(tickerKey.split(","), { force: true });
    persistAutoPrices({ ...autoPrices, ...q });
    setRefreshingPrices(false);
    const got = Object.keys(q).length;
    toast(got > 0 ? `${t(lang, "portfolio.pricesUpdated")} (${got}/${before})` : t(lang, "portfolio.pricesUpdateFailed"), got > 0 ? "success" : "error");
  }

  function saveManualPrices(updated) {
    setManualPrices(updated);
    saveManualPricesRemote(updated);
  }

  function prezzoDi(ticker) {
    return manualPrices[ticker] || autoPrices[ticker] || 0;
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

  // Portfolio totals — manual price override wins, else the live quote,
  // else cost basis
  let totalInvestito = 0, totalValore = 0;
  for (const h of holdings) {
    const prezzo = prezzoDi(h.ticker);
    totalInvestito += h.costoTotale;
    totalValore += prezzo > 0 ? h.quantita * prezzo : h.costoTotale;
  }
  const totalPL = totalValore - totalInvestito;
  const totalPLPct = totalInvestito > 0 ? (totalPL / totalInvestito * 100) : 0;

  // Sort holdings
  const holdingsOrdinate = [...holdings].sort((a, b) => {
    const pa = prezzoDi(a.ticker); const pb = prezzoDi(b.ticker);
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
    const pa = prezzoDi(a.ticker);
    const pb = prezzoDi(b.ticker);
    const va = pa > 0 ? a.quantita * pa : a.costoTotale;
    const vb = pb > 0 ? b.quantita * pb : b.costoTotale;
    return vb - va;
  });

  const holdingsByPL = [...holdings].sort((a, b) => {
    const pa = prezzoDi(a.ticker);
    const pb = prezzoDi(b.ticker);
    const pla = pa > 0 ? (a.quantita * pa) - a.costoTotale : 0;
    const plb = pb > 0 ? (b.quantita * pb) - b.costoTotale : 0;
    return plb - pla;
  });

  if (loading) return <div style={{ padding: 40, textAlign: "center", color: color.textMuted }}>{t(lang, "portfolio.loading")}</div>;

  return (
    <div style={{ padding: "20px 16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 800, color: color.textPrimary }}>{t(lang, "nav.portfolio")}</div>
          <div style={{ fontSize: 12, color: color.textMuted }}>{holdings.length} {t(lang, "portfolio.tickers")}</div>
          <div style={{ fontSize: 10, color: color.textMuted, marginTop: 2 }}>{t(lang, "portfolio.notTaxAdviceNote")}</div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {holdings.length > 0 && (
            <button onClick={handleRefreshPrices} disabled={refreshingPrices} title={t(lang, "portfolio.refreshPrices")} style={{
                background: "none", border: `1px solid ${color.border}`, borderRadius: 8, cursor: refreshingPrices ? "default" : "pointer",
                color: color.textMuted, fontSize: 15, padding: "4px 10px", opacity: refreshingPrices ? 0.5 : 1,
                animation: refreshingPrices ? "portfolio-refresh-spin 0.8s linear infinite" : "none",
              }}>↻</button>
          )}
          <button onClick={() => setShowAdd(!showAdd)} style={{
              background: showAdd ? color.accentSoft : "none", border: showAdd ? `1px solid ${color.accent}` : `1px solid ${color.border}`,
              borderRadius: 8, cursor: "pointer", color: showAdd ? color.accent : color.textMuted, fontSize: 16, padding: "4px 10px",
            }}>{showAdd ? "✕" : "+"}</button>
        </div>
      </div>
      <style>{"@keyframes portfolio-refresh-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }"}</style>

      {/* Summary card */}
      {(holdings.length > 0 || closedHoldings.length > 0) && (
        <div style={{ background: `linear-gradient(155deg, ${color.surfaceRaised} 0%, oklch(27% 0.05 265) 60%, oklch(30% 0.06 260) 100%)`, borderRadius: 22, padding: "22px 20px", marginBottom: 16, border: `1px solid ${color.borderStrong}`, boxShadow: "0 12px 32px rgba(0,0,0,.4)" }}>
          <div style={{ fontSize: 11, color: color.textSecondary, letterSpacing: 1, textTransform: "uppercase", fontWeight: 600 }}>{t(lang, "portfolio.totalValue")}</div>
          <div style={{ fontSize: 38, fontWeight: 700, fontFamily: moneyFont, color: color.textPrimary, marginTop: 6, letterSpacing: -1, fontVariantNumeric: "tabular-nums" }}>
            {formattaValuta(totalValore)}
          </div>
          <div style={{ display: "flex", gap: 20, marginTop: 14, flexWrap: "wrap" }}>
            <div>
              <div style={{ fontSize: 10, color: color.textMuted, letterSpacing: 0.6, textTransform: "uppercase", fontWeight: 600 }}>{t(lang, "portfolio.invested")}</div>
              <div style={{ fontSize: 14, fontWeight: 600, fontFamily: moneyFont, color: color.textSecondary, fontVariantNumeric: "tabular-nums", marginTop: 2 }}>{formattaValuta(totalInvestito)}</div>
            </div>
            <div>
              <div style={{ fontSize: 10, color: color.textMuted, letterSpacing: 0.6, textTransform: "uppercase", fontWeight: 600 }}>{t(lang, "portfolio.unrealizedPL")}</div>
              <div style={{ fontSize: 14, fontWeight: 700, fontFamily: moneyFont, color: totalPL >= 0 ? color.positive : color.negative, fontVariantNumeric: "tabular-nums", marginTop: 2 }}>
                {totalPL >= 0 ? "+" : ""}{formattaValuta(totalPL)} ({totalPLPct >= 0 ? "+" : ""}{totalPLPct.toFixed(1)}%)
              </div>
            </div>
            {Math.abs(totalRealizzato) > 0.005 && (
              <div>
                <div style={{ fontSize: 10, color: color.textMuted, letterSpacing: 0.6, textTransform: "uppercase", fontWeight: 600 }}>{t(lang, "portfolio.realizedPL")}</div>
                <div style={{ fontSize: 14, fontWeight: 700, fontFamily: moneyFont, color: totalRealizzato >= 0 ? color.positive : color.negative, fontVariantNumeric: "tabular-nums", marginTop: 2 }}>
                  {totalRealizzato >= 0 ? "+" : ""}{formattaValuta(totalRealizzato)}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Add form */}
      {showAdd && (
        <div style={{ background: color.surface, borderRadius: 16, padding: 16, marginBottom: 16, border: `2px solid ${color.accent}` }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: color.textPrimary, marginBottom: 12 }}>{t(lang, "portfolio.addPosition")}</div>

          {/* Buy/Sell toggle */}
          <div style={{ display: "flex", background: color.bg, borderRadius: 12, padding: 3, marginBottom: 12, border: `1px solid ${color.border}` }}>
            {["buy", "sell"].map(tp => (
              <button key={tp} onClick={() => setTradeType(tp)} style={{
                flex: 1, padding: "8px 0", border: "none", borderRadius: 10, cursor: "pointer",
                fontSize: 13, fontWeight: 600,
                background: tradeType === tp ? (tp === "buy" ? `${alpha(color.positive, 0.13)}` : `${alpha(color.negative, 0.13)}`) : "transparent",
                color: tradeType === tp ? (tp === "buy" ? color.positive : color.negative) : color.textMuted,
              }}>{tp === "buy" ? t(lang, "portfolio.buy") : t(lang, "portfolio.sell")}</button>
            ))}
          </div>

          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>{t(lang, "portfolio.ticker")}</label>
              <input type="text" value={ticker} onChange={e => setTicker(e.target.value.toUpperCase())} placeholder="AAPL"
                style={{ ...inputStyle, fontSize: 16, fontWeight: 700, fontFamily: moneyFont, fontVariantNumeric: "tabular-nums", textTransform: "uppercase", background: color.bg }} />
            </div>
            <div style={{ flex: 2 }}>
              <label style={labelStyle}>{t(lang, "portfolio.nameOptional")}</label>
              <input type="text" value={nome} onChange={e => setNome(e.target.value)} placeholder="Apple Inc."
                style={{ ...inputStyle, background: color.bg }} />
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>{t(lang, "portfolio.quantity")}</label>
              <input type="text" inputMode="decimal" value={quantita} onChange={e => setQuantita(e.target.value)} placeholder="10"
                style={{ ...inputStyle, fontFamily: moneyFont, fontVariantNumeric: "tabular-nums", background: color.bg }} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>{t(lang, "portfolio.purchasePrice")}</label>
              <input type="text" inputMode="decimal" value={prezzoAcquisto} onChange={e => setPrezzoAcquisto(e.target.value)} placeholder="150.00"
                style={{ ...inputStyle, fontFamily: moneyFont, fontVariantNumeric: "tabular-nums", background: color.bg }} />
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>{t(lang, "portfolio.purchaseDate")}</label>
              <input type="date" value={dataAcquisto} onChange={e => setDataAcquisto(e.target.value)}
                style={{ ...inputStyle, background: color.bg, colorScheme: "dark" }} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>{t(lang, "portfolio.notes")}</label>
              <input type="text" value={note} onChange={e => setNote(e.target.value)} placeholder="..."
                style={{ ...inputStyle, background: color.bg }} />
            </div>
          </div>
          <button onClick={handleAdd} disabled={adding || !ticker || !quantita || !prezzoAcquisto} style={{
            width: "100%", padding: "12px", border: "none", borderRadius: 12, cursor: "pointer",
            fontSize: 14, fontWeight: 700, color: "#fff",
            background: ticker && quantita && prezzoAcquisto ? (tradeType === "buy" ? color.positive : color.negative) : color.border,
            opacity: adding ? 0.6 : 1,
          }}>{adding ? t(lang, "viaggi.saving") : (tradeType === "buy" ? t(lang, "portfolio.addBuy") : t(lang, "portfolio.recordSell"))}</button>
        </div>
      )}

      {/* Holdings list */}
      {holdings.length === 0 ? (
        <div style={{ color: color.textMuted, textAlign: "center", padding: 40, fontSize: 14 }}>
          {t(lang, "portfolio.noPositions")}<br/>{t(lang, "portfolio.tapToAddTicker")}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {/* Sort selector */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 11, color: color.textMuted, flexShrink: 0 }}>{t(lang, "portfolio.sortBy")}</span>
            <select value={sortPortfolio} onChange={e => setSortPortfolio(e.target.value)} style={{
              flex: 1, background: color.surface, border: `1px solid ${color.border}`, borderRadius: 8,
              color: color.textSecondary, fontSize: 12, padding: "6px 8px", fontFamily: displayFont,
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
            const isAuto = !isManuale && autoPrices[h.ticker] > 0;
            const prezzoCorrente = prezzoDi(h.ticker);
            const valoreCorrente = prezzoCorrente > 0 ? h.quantita * prezzoCorrente : h.costoTotale;
            const pl = prezzoCorrente > 0 ? valoreCorrente - h.costoTotale : 0;
            const plPct = h.costoTotale > 0 && prezzoCorrente > 0 ? (pl / h.costoTotale * 100) : 0;
            const isEditing = editingTicker === h.ticker;

            return (
              <div key={h.ticker} style={{ background: color.surface, borderRadius: 16, padding: "14px 16px", border: isEditing ? `1px solid ${color.accent}` : `1px solid ${color.border}`, transition: "border-color 0.2s" }}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 8 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 15, fontWeight: 800, color: color.textPrimary, fontFamily: moneyFont, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>{h.ticker}</span>
                      <span style={{ fontSize: 11, color: color.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{h.nome}</span>
                      {isManuale && (
                        <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 5px", borderRadius: 4, background: `${alpha(color.warn, 0.13)}`, color: color.warn, letterSpacing: 0.3, flexShrink: 0 }}>{t(lang, "portfolio.manualBadge")}</span>
                      )}
                      {isAuto && (
                        <span title={t(lang, "portfolio.updatePriceAuto")} style={{ fontSize: 9, fontWeight: 700, padding: "2px 5px", borderRadius: 4, background: `${alpha(color.positive, 0.13)}`, color: color.positive, letterSpacing: 0.3, flexShrink: 0 }}>{t(lang, "portfolio.autoBadge")}</span>
                      )}
                    </div>
                    <div style={{ fontSize: 11, color: color.textMuted, marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {h.quantita.toFixed(h.quantita % 1 === 0 ? 0 : 2)} {t(lang, "portfolio.units")} × {formattaValuta(h.prezzoMedio)} {t(lang, "portfolio.avgSuffix")}
                    </div>
                  </div>
                  <div style={{ textAlign: "right", flexShrink: 0, maxWidth: "48%" }}>
                    <div style={{ fontSize: 15, fontWeight: 700, fontFamily: moneyFont, fontVariantNumeric: "tabular-nums", color: color.textPrimary, wordBreak: "break-all" }}>
                      {prezzoCorrente > 0 ? formattaValuta(valoreCorrente) : "—"}
                    </div>
                    {totalValore > 0 && (
                      <div style={{ fontSize: 9, color: color.textMuted, fontFamily: moneyFont, fontVariantNumeric: "tabular-nums" }}>{(valoreCorrente / totalValore * 100).toFixed(1)}{t(lang, "portfolio.ofPortfolio")}</div>
                    )}
                    {prezzoCorrente > 0 && (
                      <div style={{ fontSize: 11, fontWeight: 700, fontFamily: moneyFont, fontVariantNumeric: "tabular-nums", color: pl >= 0 ? color.positive : color.negative, wordBreak: "break-all" }}>
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
                        <span style={{ fontSize: 12, color: color.textSecondary, fontFamily: moneyFont, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{formattaValuta(prezzoCorrente)}</span>
                      </div>
                    ) : !isEditing ? (
                      <span style={{ fontSize: 11, color: color.textMuted }}>{t(lang, "portfolio.enterManualPrice")}</span>
                    ) : null}
                  </div>

                  {/* Edit ✏ + Delete × — always on right, never wrap */}
                  {!isEditing && (
                    <div style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
                      <button onClick={() => startEditPrice(h.ticker, manuale)} title={t(lang, "portfolio.updatePriceManually")} style={{
                        background: prezzoCorrente === 0 ? color.accentSoft : "none",
                        border: prezzoCorrente === 0 ? `1px solid ${alpha(color.accent, 0.33)}` : "none",
                        borderRadius: 7, color: prezzoCorrente === 0 ? color.accent : color.textMuted,
                        cursor: "pointer", fontSize: 13, lineHeight: 1,
                        padding: prezzoCorrente === 0 ? "4px 8px" : "4px 6px",
                        fontFamily: displayFont,
                      }}>✏</button>
                      <button onClick={() => handleDeleteHolding(h.trades)} style={{
                        background: "none", border: "none", color: color.textMuted, cursor: "pointer", fontSize: 16, lineHeight: 1, padding: "4px 6px",
                      }}>×</button>
                    </div>
                  )}
                </div>

                {/* "Inserisci prezzo" call-to-action when no price and not editing */}
                {prezzoCorrente === 0 && !isEditing && (
                  <button onClick={() => startEditPrice(h.ticker, manuale)} style={{
                    marginTop: 8, width: "100%", padding: "8px", background: color.accentSoft,
                    border: `1px dashed ${alpha(color.accent, 0.33)}`, borderRadius: 10, color: color.accent,
                    cursor: "pointer", fontSize: 12, fontWeight: 700, fontFamily: displayFont,
                  }}>✏ {t(lang, "portfolio.enterManualPrice")}</button>
                )}

                {/* Inline manual price editor */}
                {isEditing && (
                  <div style={{ marginTop: 10, padding: "12px", background: color.bg, borderRadius: 12, border: `1px solid ${alpha(color.accent, 0.2)}` }}>
                    <div style={{ fontSize: 11, color: color.accent, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 8 }}>
                      {t(lang, "portfolio.manualPricePrefix")} {h.ticker}
                    </div>
                    <input
                      type="text" inputMode="decimal" autoFocus
                      value={editPriceVal}
                      onChange={e => setEditPriceVal(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter") handleSaveManualPrice(h.ticker); if (e.key === "Escape") setEditingTicker(null); }}
                      placeholder="Es: 42.50"
                      style={{ width: "100%", padding: "10px 12px", background: color.surface, border: `1px solid ${color.accent}`, borderRadius: 10, color: color.textPrimary, fontSize: 16, fontFamily: moneyFont, fontVariantNumeric: "tabular-nums", outline: "none", boxSizing: "border-box", marginBottom: 8 }}
                    />
                    <div style={{ display: "flex", gap: 8 }}>
                      <button onClick={() => handleSaveManualPrice(h.ticker)} style={{
                        flex: 1, padding: "10px", background: accentGradient, border: "none",
                        borderRadius: 10, color: "#fff", fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: displayFont,
                      }}>{t(lang, "common.save")}</button>
                      <button onClick={() => setEditingTicker(null)} style={{
                        padding: "10px 14px", background: "none", border: `1px solid ${color.border}`, borderRadius: 10,
                        color: color.textMuted, fontSize: 14, cursor: "pointer", fontFamily: displayFont,
                      }}>✕</button>
                    </div>
                    {manuale && (
                      <button onClick={() => handleClearManualPrice(h.ticker)} style={{
                        marginTop: 8, background: "none", border: "none", color: `${alpha(color.negative, 0.53)}`, cursor: "pointer",
                        fontSize: 11, fontFamily: displayFont, padding: 0,
                      }}>{t(lang, "portfolio.removeManualPrice")}</button>
                    )}
                    <div style={{ fontSize: 10, color: color.textMuted, marginTop: 8 }}>
                      {t(lang, "portfolio.apiPriceNote")}
                    </div>
                  </div>
                )}

                {/* Toggle trade history button */}
                {h.trades && h.trades.length > 1 && !isEditing && (
                  <button onClick={() => setExpandedTicker(expandedTicker === h.ticker ? null : h.ticker)} style={{
                    marginTop: 8, width: "100%", padding: "6px", background: "none",
                    border: "none", color: color.accent, cursor: "pointer",
                    fontSize: 11, fontFamily: displayFont,
                  }}>
                    {expandedTicker === h.ticker ? t(lang, "portfolio.hideHistory") : `${t(lang, "portfolio.viewTrades")} ${h.trades.length} ${t(lang, "portfolio.trades")}`}
                  </button>
                )}

                {/* Expandable trade history */}
                {expandedTicker === h.ticker && h.trades && h.trades.length > 0 && (
                  <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${color.border}` }}>
                    <div style={{ fontSize: 10, color: color.textMuted, letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 8 }}>{t(lang, "portfolio.tradeHistory")}</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      {[...h.trades].sort((a, b) => new Date(b.dataAcquisto) - new Date(a.dataAcquisto)).map((tr, i) => (
                        <div key={tr.id || i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", background: color.bg, borderRadius: 8 }}>
                          <span style={{ fontSize: 10, color: color.textMuted, minWidth: 60 }}>{tr.dataAcquisto}</span>
                          <span style={{ fontSize: 11, fontWeight: 600, color: tr.tipo === "sell" ? color.negative : color.positive, minWidth: 35 }}>
                            {tr.tipo === "sell" ? "SELL" : "BUY"}
                          </span>
                          <span style={{ flex: 1, fontSize: 12, color: color.textSecondary, fontFamily: moneyFont, fontVariantNumeric: "tabular-nums" }}>{tr.quantita} {t(lang, "portfolio.units")}</span>
                          <span style={{ fontSize: 12, color: color.textSecondary, fontFamily: moneyFont, fontVariantNumeric: "tabular-nums" }}>@{formattaValuta(tr.prezzoAcquisto)}</span>
                          <button onClick={() => handleDeleteTrade(tr)} title={t(lang, "portfolio.deleteThisTrade")} style={{ background: "none", border: "none", color: `${alpha(color.negative, 0.4)}`, cursor: "pointer", fontSize: 13, lineHeight: 1, padding: "2px 4px" }}>✕</button>
                        </div>
                      ))}
                    </div>
                    {Math.abs(h.realizzato) > 0.005 && (
                      <div style={{ marginTop: 8, fontSize: 11, color: color.textMuted, display: "flex", justifyContent: "space-between" }}>
                        <span>{t(lang, "portfolio.realizedPL")} ({h.ticker})</span>
                        <span style={{ fontFamily: moneyFont, fontVariantNumeric: "tabular-nums", fontWeight: 700, color: h.realizzato >= 0 ? color.positive : color.negative }}>
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

      {!showAdd && (
        <button onClick={() => setShowAdd(true)} style={{
          width: "100%", marginTop: 8, padding: "13px", borderRadius: 12, border: `1px dashed ${color.borderStrong}`,
          background: "none", color: color.accent, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: displayFont,
        }}>+ {t(lang, "portfolio.addPosition")}</button>
      )}

      {/* Closed positions */}
      {closedHoldings.length > 0 && (
        <div style={{ background: color.surface, borderRadius: 20, padding: 16, marginTop: 16, border: `1px solid ${color.border}` }}>
          <div style={{ fontSize: 12, color: color.textSecondary, letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 12 }}>{t(lang, "portfolio.closedPositions")}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {closedHoldings.map(h => (
              <div key={h.ticker} style={{ background: color.bg, borderRadius: 12, padding: "10px 12px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ fontSize: 13, fontWeight: 800, color: color.textSecondary, fontFamily: moneyFont, fontVariantNumeric: "tabular-nums" }}>{h.ticker}</span>
                    <span style={{ fontSize: 10, color: color.textMuted, marginLeft: 6 }}>{h.nome}</span>
                    <div style={{ fontSize: 10, color: color.textMuted, marginTop: 2 }}>{t(lang, "portfolio.closedOn")} {h.ultimaData} · {h.trades.length} {t(lang, "portfolio.trades")}</div>
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 700, fontFamily: moneyFont, fontVariantNumeric: "tabular-nums", color: h.realizzato >= 0 ? color.positive : color.negative, flexShrink: 0 }}>
                    {h.realizzato >= 0 ? "+" : ""}{formattaValuta(h.realizzato)}
                  </div>
                  <button onClick={() => setExpandedTicker(expandedTicker === h.ticker ? null : h.ticker)} style={{ background: "none", border: "none", color: color.accent, cursor: "pointer", fontSize: 11, padding: "2px 4px", flexShrink: 0 }}>
                    {expandedTicker === h.ticker ? "▲" : "▼"}
                  </button>
                  <button onClick={() => handleDeleteHolding(h.trades)} style={{ background: "none", border: "none", color: color.textMuted, cursor: "pointer", fontSize: 14, padding: "2px 4px", flexShrink: 0 }}>×</button>
                </div>
                {expandedTicker === h.ticker && (
                  <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
                    {[...h.trades].sort((a, b) => new Date(b.dataAcquisto) - new Date(a.dataAcquisto)).map((tr, i) => (
                      <div key={tr.id || i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 8px", background: color.surface, borderRadius: 8 }}>
                        <span style={{ fontSize: 10, color: color.textMuted, minWidth: 60 }}>{tr.dataAcquisto}</span>
                        <span style={{ fontSize: 11, fontWeight: 600, color: tr.tipo === "sell" ? color.negative : color.positive, minWidth: 35 }}>{tr.tipo === "sell" ? "SELL" : "BUY"}</span>
                        <span style={{ flex: 1, fontSize: 12, color: color.textSecondary, fontFamily: moneyFont, fontVariantNumeric: "tabular-nums" }}>{tr.quantita} {t(lang, "portfolio.units")}</span>
                        <span style={{ fontSize: 12, color: color.textSecondary, fontFamily: moneyFont, fontVariantNumeric: "tabular-nums" }}>@{formattaValuta(tr.prezzoAcquisto)}</span>
                        <button onClick={() => handleDeleteTrade(tr)} title={t(lang, "portfolio.deleteThisTrade")} style={{ background: "none", border: "none", color: `${alpha(color.negative, 0.4)}`, cursor: "pointer", fontSize: 13, lineHeight: 1, padding: "2px 4px" }}>✕</button>
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
        <div style={{ background: color.surface, borderRadius: 20, padding: 20, marginTop: 16, border: `1px solid ${color.border}` }}>
          <div style={{ fontSize: 12, color: color.textSecondary, letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 14 }}>{t(lang, "portfolio.allocation")}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
            <DonutChart segmenti={holdingsByValue.map((h, i) => {
              const prezzo = prezzoDi(h.ticker);
              const val = prezzo > 0 ? h.quantita * prezzo : h.costoTotale;
              const colors = [color.accent, color.positive, color.negative, "#FFEAA7", "#DDA0DD", color.warn, "#74B9FF", "#55EFC4"];
              return { valore: val, colore: colors[i % colors.length], label: h.ticker };
            })} />
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
              {holdingsByValue.map((h, i) => {
                const prezzo = prezzoDi(h.ticker);
                const val = prezzo > 0 ? h.quantita * prezzo : h.costoTotale;
                const pct = totalValore > 0 ? (val / totalValore * 100) : 0;
                const colors = [color.accent, color.positive, color.negative, "#FFEAA7", "#DDA0DD", color.warn, "#74B9FF", "#55EFC4"];
                const swatchColor = colors[i % colors.length];
                return (
                  <div key={h.ticker} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <div style={{ width: 10, height: 10, borderRadius: 3, background: swatchColor }} />
                    <span style={{ fontSize: 12, color: color.textSecondary, fontWeight: 600, flex: 1 }}>{h.ticker}</span>
                    <span style={{ fontSize: 12, color: color.textSecondary, fontFamily: moneyFont, fontVariantNumeric: "tabular-nums" }}>{pct.toFixed(1)}%</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* P&L Bar Chart */}
      {holdings.length >= 1 && totalValore > 0 && (
        <div style={{ background: color.surface, borderRadius: 20, padding: 20, marginTop: 16, border: `1px solid ${color.border}`, overflow: "hidden" }}>
          <div style={{ fontSize: 12, color: color.textSecondary, letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 14 }}>{t(lang, "portfolio.profitLoss")}</div>
          <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 100, minWidth: "max-content" }}>
            {holdingsByPL.map(h => {
              const prezzo = prezzoDi(h.ticker);
              const valore = prezzo > 0 ? h.quantita * prezzo : 0;
              const pl = prezzo > 0 ? valore - h.costoTotale : 0;
              const maxPL = Math.max(...holdings.map(h => {
                const p = prezzoDi(h.ticker);
                return p > 0 ? Math.abs((h.quantita * p) - h.costoTotale) : 0;
              }), 1);
              const height = Math.max(2, (Math.abs(pl) / maxPL) * 80);
              const isPositive = pl >= 0;
              return (
                <div key={h.ticker} style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 44, flexShrink: 0 }}>
                  <div style={{ width: 28, height, background: isPositive ? color.positive : color.negative, borderRadius: "4px 4px 0 0", transition: "height 0.5s" }} />
                  <span style={{ fontSize: 9, color: color.textMuted, marginTop: 4, whiteSpace: "nowrap" }}>{h.ticker}</span>
                  <span style={{ fontSize: 8, color: isPositive ? color.positive : color.negative, whiteSpace: "nowrap" }}>{importoOscurabile(`${isPositive ? "+" : ""}${pl >= 1000 ? (pl/1000).toFixed(1) + "k" : pl.toFixed(0)}€`)}</span>
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
