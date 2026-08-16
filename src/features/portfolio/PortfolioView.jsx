import { useState, useEffect } from "react";
import { fetchPositions, addPosition, deletePosition, fetchManualPrices, saveManualPricesRemote } from "../../api.js";
import { t } from "../../lib/i18n.js";
import { formattaValuta, importoOscurabile } from "../../lib/format.js";
import { toast } from "../../components/Toast.jsx";
import { labelStyle, inputStyle } from "../../components/ui/styles.js";
import { DonutChart } from "../../components/ui/Charts.jsx";

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
