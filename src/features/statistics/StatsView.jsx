import { calcolaDebitiMatrix, forecastNextMonthExpenses } from "../../lib/finance.js";
import { t, mese } from "../../lib/i18n.js";
import { formattaValuta } from "../../lib/format.js";
import { DonutChart, MiniChart } from "../../components/ui/Charts.jsx";
import { GoalGauge } from "../goals/GoalGauge.jsx";

export function StatsView({ transazioni, persone, meseOffset, categorie, goals, lang = "it" }) {
  const oggi = new Date();
  const meseVis = new Date(oggi.getFullYear(), oggi.getMonth() - meseOffset, 1);
  const nomeMese = mese(meseVis.getMonth()) + " " + meseVis.getFullYear();
  const txMese = transazioni.filter(t => { const d=new Date(t.data); return d.getMonth()===meseVis.getMonth()&&d.getFullYear()===meseVis.getFullYear(); });
  const usciteMese = txMese.filter(t => t.tipo === "uscita");
  const totalUscite = usciteMese.reduce((s,t) => s+t.importo, 0);
  const totalEntrate = txMese.filter(t=>t.tipo==="entrata").reduce((s,t)=>s+t.importo,0)
    + txMese.filter(t=>t.tipo==="saldo"&&!persone.some(p=>p.id===t.pagatoDa)).reduce((s,t)=>s+t.importo,0);
  const perCategoria = categorie.map(cat=>({...cat,valore:usciteMese.filter(t=>t.categoria===cat.id).reduce((s,t)=>s+t.importo,0)})).filter(c=>c.valore>0).sort((a,b)=>b.valore-a.valore);
  const ultimi6 = Array.from({length:6},(_,i)=>{const m=new Date(oggi.getFullYear(),oggi.getMonth()-(5-i),1);return{label:mese(m.getMonth()),valore:transazioni.filter(t=>t.tipo==="uscita"&&new Date(t.data).getMonth()===m.getMonth()&&new Date(t.data).getFullYear()===m.getFullYear()).reduce((s,t)=>s+t.importo,0),colore:"#6C5CE7"};});
  const spesoPerPersona = persone.map(p => ({
    ...p,
    speso: usciteMese.filter(t => t.pagatoDa === p.id).reduce((s, t) => s + t.importo, 0),
  }));
  const debitiMese = calcolaDebitiMatrix(txMese.filter(t => t.tipo !== "saldo"), persone); // saldi esclusi: pagano debiti di mesi precedenti e creerebbero debiti inversi fittizi nella vista mensile

  // ─── Frequency analysis (must be before Trends) ───
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

  // ─── Trends & Insights ───
  const mesePrecedente = new Date(meseVis.getFullYear(), meseVis.getMonth() - 1, 1);
  const txMesePrec = transazioni.filter(t => { const d=new Date(t.data); return d.getMonth()===mesePrecedente.getMonth()&&d.getFullYear()===mesePrecedente.getFullYear(); });
  const usciteMesePrec = txMesePrec.filter(t => t.tipo === "uscita");
  const totalUscitePrec = usciteMesePrec.reduce((s,t) => s+t.importo, 0);
  const totalEntratePrec = txMesePrec.filter(t=>t.tipo==="entrata").reduce((s,t)=>s+t.importo,0)
    + txMesePrec.filter(t=>t.tipo==="saldo"&&!persone.some(p=>p.id===t.pagatoDa)).reduce((s,t)=>s+t.importo,0);

  // Month over month change
  const deltaPct = totalUscitePrec > 0 ? ((totalUscite - totalUscitePrec) / totalUscitePrec * 100) : null;
  const deltaEntPct = totalEntratePrec > 0 ? ((totalEntrate - totalEntratePrec) / totalEntratePrec * 100) : null;

  // Category comparison vs previous month
  const catTrends = categorie.map(cat => {
    const curr = usciteMese.filter(t=>t.categoria===cat.id).reduce((s,t)=>s+t.importo,0);
    const prev = usciteMesePrec.filter(t=>t.categoria===cat.id).reduce((s,t)=>s+t.importo,0);
    const delta = prev > 0 ? ((curr - prev) / prev * 100) : (curr > 0 ? 100 : 0);
    return { ...cat, curr, prev, delta };
  }).filter(c => c.curr > 0 || c.prev > 0).sort((a,b) => Math.abs(b.delta) - Math.abs(a.delta));

  // Biggest single expense
  const maxTx = usciteMese.length > 0 ? usciteMese.reduce((a,b) => a.importo > b.importo ? a : b) : null;

  // Saving rate
  const savingRate = totalEntrate > 0 ? ((totalEntrate - totalUscite) / totalEntrate * 100) : 0;

  // Average daily spend
  const giornoOggi = meseVis.getMonth() === oggi.getMonth() && meseVis.getFullYear() === oggi.getFullYear() ? oggi.getDate() : giorniMese;
  const mediaGiornaliera = giornoOggi > 0 ? totalUscite / giornoOggi : 0;
  const mediaGiornalieraPrec = giorniMese > 0 && totalUscitePrec > 0 ? totalUscitePrec / new Date(mesePrecedente.getFullYear(), mesePrecedente.getMonth()+1, 0).getDate() : 0;

  // Top spending day
  const topDay = perGiorno.reduce((a,b) => a.totale > b.totale ? a : b, { giorno: 0, totale: 0 });

  // Generate smart insights
  const insights = [];
  if (deltaPct !== null) {
    if (deltaPct > 15) insights.push({ icon: "📈", color: "#FF6B6B", text: `${t(lang, "stats.expensesUpPrefix")} ${Math.round(deltaPct)}% ${t(lang, "stats.comparedTo")} ${mese(mesePrecedente.getMonth(), lang)}` });
    else if (deltaPct < -15) insights.push({ icon: "📉", color: "#4ECDC4", text: `${t(lang, "stats.expensesDownPrefix")} ${Math.round(Math.abs(deltaPct))}% ${t(lang, "stats.comparedTo")} ${mese(mesePrecedente.getMonth(), lang)}` });
    else insights.push({ icon: "➡️", color: "#F0A500", text: `${t(lang, "stats.expensesStablePrefix")} ${mese(mesePrecedente.getMonth(), lang)} (${deltaPct >= 0 ? "+" : ""}${Math.round(deltaPct)}%)` });
  }
  if (savingRate > 20) insights.push({ icon: "💪", color: "#4ECDC4", text: `${t(lang, "stats.savingRateLabel")}: ${Math.round(savingRate)}% ${t(lang, "stats.excellentSuffix")}` });
  else if (savingRate > 0) insights.push({ icon: "💡", color: "#F0A500", text: `${t(lang, "stats.savingRateLabel")}: ${Math.round(savingRate)}%` });
  else if (totalEntrate > 0) insights.push({ icon: "⚠️", color: "#FF6B6B", text: t(lang, "stats.spendingMoreThanEarn") });
  if (maxTx) {
    const maxCat = categorie.find(c=>c.id===maxTx.categoria);
    insights.push({ icon: "🏷️", color: "#DDA0DD", text: `${t(lang, "stats.biggestExpense")}: ${formattaValuta(maxTx.importo)} — ${maxTx.descrizione || maxCat?.nome || ""}` });
  }
  if (topDay.totale > 0) insights.push({ icon: "📅", color: "#45B7D1", text: `${t(lang, "stats.mostExpensiveDay")}: ${topDay.giorno} ${mese(meseVis.getMonth(), lang)} (${formattaValuta(topDay.totale)})` });
  const catUp = catTrends.find(c => c.delta > 30 && c.curr > 20);
  const catDown = catTrends.find(c => c.delta < -30 && c.prev > 20);
  if (catUp) insights.push({ icon: catUp.emoji, color: catUp.colore, text: `${catUp.nome} +${Math.round(catUp.delta)}% ${t(lang, "stats.vsLastMonth")} (${formattaValuta(catUp.curr)})` });
  if (catDown) insights.push({ icon: catDown.emoji, color: catDown.colore, text: `${catDown.nome} ${Math.round(catDown.delta)}% ${t(lang, "stats.vsLastMonth")} (${formattaValuta(catDown.curr)})` });
  if (mediaGiornaliera > 0) insights.push({ icon: "📊", color: "#6C5CE7", text: `${t(lang, "stats.dailyAverage")}: ${formattaValuta(mediaGiornaliera)}/${t(lang, "stats.perDay")}` });

  // Previsione prossimo mese — media mobile sugli ultimi 3 mesi completi,
  // sempre relativa a "oggi" (non al mese che l'utente sta visualizzando).
  const forecast = forecastNextMonthExpenses(transazioni, categorie, oggi, 3);
  const nextMonthDate = new Date(oggi.getFullYear(), oggi.getMonth() + 1, 1);

  return (
    <div>
      <div style={{ padding: "14px 16px 20px" }}>
      <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
        <div style={{ flex: 1, background: "#1a1a28", borderRadius: 16, padding: "16px 14px", border: "1px solid #252538" }}>
          <div style={{ fontSize: 10, color: "#6a6", letterSpacing: 0.5, textTransform: "uppercase" }}>{t(lang, "stats.income")}</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: "#4ECDC4", fontFamily: "'Space Mono',monospace", marginTop: 4 }}>{formattaValuta(totalEntrate)}</div>
        </div>
        <div style={{ flex: 1, background: "#1a1a28", borderRadius: 16, padding: "16px 14px", border: "1px solid #252538" }}>
          <div style={{ fontSize: 10, color: "#a66", letterSpacing: 0.5, textTransform: "uppercase" }}>{t(lang, "stats.expenses")}</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: "#FF6B6B", fontFamily: "'Space Mono',monospace", marginTop: 4 }}>{formattaValuta(totalUscite)}</div>
        </div>
      </div>
      {spesoPerPersona.some(p => p.speso > 0) && (
        <div style={{ background: "#1a1a28", borderRadius: 16, padding: "14px 16px", marginBottom: 16, border: "1px solid #252538" }}>
          <div style={{ fontSize: 11, color: "#999", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 10 }}>{t(lang, "stats.whoPaid")}</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 10 }}>
            {spesoPerPersona.map(p => (
              <div key={p.id} style={{ flex: "1 1 120px", display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 20 }}>{p.emoji}</span>
                <div>
                  <div style={{ fontSize: 11, color: p.colore, fontWeight: 600 }}>{p.nome}</div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: "#eee", fontFamily: "'Space Mono',monospace" }}>{formattaValuta(p.speso)}</div>
                </div>
              </div>
            ))}
          </div>
          {debitiMese.length > 0 && (
            <div style={{ borderTop: "1px solid #252538", paddingTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
              {debitiMese.map((d, i) => {
                const allP = getAllPersone(transazioni, persone);
                const pDa = allP.find(p => p.id === d.da) || { nome: d.da, emoji: "👤", colore: "#888" };
                const pA = allP.find(p => p.id === d.a) || { nome: d.a, emoji: "👤", colore: "#888" };
                return (
                  <div key={i} style={{ fontSize: 12, color: "#ccc" }}>
                    <span>{pDa.emoji} {pDa.nome} {t(lang, "stats.owes")} <strong style={{ color: pA.colore }}>{formattaValuta(d.importo)}</strong> {t(lang, "stats.owesToConnector")} {pA.nome}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
      {perCategoria.length > 0 && (
        <div style={{ background: "#1a1a28", borderRadius: 20, padding: 20, marginBottom: 24, border: "1px solid #252538" }}>
          <div style={{ fontSize: 12, color: "#999", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 16 }}>{t(lang, "stats.expensesByCategory")}</div>
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
      {goals && goals.length > 0 && (
        <div style={{ background: "#1a1a28", borderRadius: 20, padding: 20, marginBottom: 24, border: "1px solid #252538" }}>
          <div style={{ fontSize: 12, color: "#999", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 16 }}>{t(lang, "home.savingsGoals")}</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 12 }}>
            {goals.map(g => {
              const pct = g.targetAmount > 0 ? (g.currentAmount / g.targetAmount * 100) : 0;
              const daysLeft = g.targetDate ? Math.ceil((new Date(g.targetDate) - new Date()) / (1000*60*60*24)) : null;
              return (
                <div key={g.id} style={{ background: "#111119", borderRadius: 12, padding: 12, textAlign: "center" }}>
                  <GoalGauge current={g.currentAmount || 0} target={g.targetAmount} size={70} />
                  <div style={{ fontSize: 12, fontWeight: 600, color: "#eee", marginTop: 8 }}>{g.nome}</div>
                  <div style={{ fontSize: 11, color: pct >= 100 ? "#4ECDC4" : "#888" }}>{pct.toFixed(0)}%</div>
                  {daysLeft !== null && daysLeft < 30 && daysLeft >= 0 && (
                    <div style={{ fontSize: 10, color: "#F0A500", marginTop: 4 }}>{daysLeft}{t(lang, "stats.daysLeft")}</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
      <div style={{ background: "#1a1a28", borderRadius: 20, padding: 20, border: "1px solid #252538", marginBottom: 24 }}>
        <div style={{ fontSize: 12, color: "#999", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 16 }}>{t(lang, "stats.expenseTrend6m")}</div>
        <MiniChart dati={ultimi6} />
      </div>

      {numTransazioni > 0 && (
        <>
          <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
            <div style={{ flex: 1, background: "#1a1a28", borderRadius: 16, padding: "14px", border: "1px solid #252538", textAlign: "center" }}>
              <div style={{ fontSize: 10, color: "#999", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 4 }}>{t(lang, "stats.transactionsCount")}</div>
              <div style={{ fontSize: 26, fontWeight: 800, color: "#6C5CE7", fontFamily: "'Space Mono',monospace" }}>{numTransazioni}</div>
            </div>
            <div style={{ flex: 1, background: "#1a1a28", borderRadius: 16, padding: "14px", border: "1px solid #252538", textAlign: "center" }}>
              <div style={{ fontSize: 10, color: "#999", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 4 }}>{t(lang, "stats.avgExpense")}</div>
              <div style={{ fontSize: 18, fontWeight: 800, color: "#FF6B6B", fontFamily: "'Space Mono',monospace" }}>{formattaValuta(spesaMedia)}</div>
            </div>
            <div style={{ flex: 1, background: "#1a1a28", borderRadius: 16, padding: "14px", border: "1px solid #252538", textAlign: "center" }}>
              <div style={{ fontSize: 10, color: "#999", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 4 }}>{t(lang, "stats.dailyFreq")}</div>
              <div style={{ fontSize: 18, fontWeight: 800, color: "#4ECDC4", fontFamily: "'Space Mono',monospace" }}>{(numTransazioni / giorniMese).toFixed(1)}<span style={{ fontSize: 11, color: "#888" }}>/g</span></div>
            </div>
          </div>
          <div style={{ background: "#1a1a28", borderRadius: 20, padding: 20, marginBottom: 16, border: "1px solid #252538" }}>
            <div style={{ fontSize: 12, color: "#999", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 14 }}>{t(lang, "stats.amountDistribution")}</div>
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
            <div style={{ fontSize: 12, color: "#999", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 14 }}>{t(lang, "stats.dailyHeatmap")}</div>
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
              <span style={{ fontSize: 9, color: "#666" }}>{t(lang, "stats.less")}</span>
              {[0, 0.25, 0.5, 0.75, 1].map((v, i) => (
                <div key={i} style={{ width: 14, height: 14, borderRadius: 3, background: v === 0 ? "#1e1e2e" : `rgba(108, 92, 231, ${0.15 + v * 0.85})` }} />
              ))}
              <span style={{ fontSize: 9, color: "#666" }}>{t(lang, "stats.more")}</span>
            </div>
          </div>
        </>
      )}

      {/* ─── Trends & Insights ─── */}
      {(insights.length > 0 || catTrends.length > 0) && (
        <>
          {/* Smart insights */}
          {insights.length > 0 && (
            <div style={{ background: "#1a1a28", borderRadius: 20, padding: 20, marginBottom: 16, border: "1px solid #252538" }}>
              <div style={{ fontSize: 12, color: "#999", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 14 }}>{t(lang, "stats.insightsTitle")}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {insights.map((ins, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                    <span style={{ fontSize: 18, flexShrink: 0, lineHeight: 1.2 }}>{ins.icon}</span>
                    <span style={{ fontSize: 13, color: "#ccc", fontFamily: "'DM Sans',sans-serif", lineHeight: 1.4 }}>{ins.text}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Month over month comparison bars */}
          {totalUscitePrec > 0 && (
            <div style={{ background: "#1a1a28", borderRadius: 20, padding: 20, marginBottom: 16, border: "1px solid #252538" }}>
              <div style={{ fontSize: 12, color: "#999", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 14 }}>{t(lang, "stats.comparisonVs")} {mese(mesePrecedente.getMonth(), lang)}</div>
              {/* Uscite comparison */}
              <div style={{ marginBottom: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                  <span style={{ fontSize: 11, color: "#888" }}>{t(lang, "stats.expenses")}</span>
                  <span style={{ fontSize: 12, fontWeight: 700, fontFamily: "'Space Mono',monospace", color: deltaPct > 0 ? "#FF6B6B" : "#4ECDC4" }}>
                    {deltaPct >= 0 ? "+" : ""}{Math.round(deltaPct)}%
                  </span>
                </div>
                <div style={{ display: "flex", gap: 4, height: 20 }}>
                  <div style={{ position: "relative", flex: 1, background: "#252538", borderRadius: 6, overflow: "hidden" }}>
                    <div style={{ position: "absolute", inset: 0, width: `${Math.min(100, totalUscitePrec / Math.max(totalUscite, totalUscitePrec) * 100)}%`, background: "#FF6B6B44", borderRadius: 6 }} />
                    <div style={{ position: "relative", padding: "2px 8px", fontSize: 10, color: "#aaa" }}>{mese(mesePrecedente.getMonth(), lang)} {formattaValuta(totalUscitePrec)}</div>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 4, height: 20, marginTop: 4 }}>
                  <div style={{ position: "relative", flex: 1, background: "#252538", borderRadius: 6, overflow: "hidden" }}>
                    <div style={{ position: "absolute", inset: 0, width: `${Math.min(100, totalUscite / Math.max(totalUscite, totalUscitePrec) * 100)}%`, background: "#FF6B6B88", borderRadius: 6 }} />
                    <div style={{ position: "relative", padding: "2px 8px", fontSize: 10, color: "#eee", fontWeight: 600 }}>{mese(meseVis.getMonth(), lang)} {formattaValuta(totalUscite)}</div>
                  </div>
                </div>
              </div>
              {/* Entrate comparison */}
              {(totalEntrate > 0 || totalEntratePrec > 0) && (
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                    <span style={{ fontSize: 11, color: "#888" }}>{t(lang, "stats.income")}</span>
                    {deltaEntPct !== null && <span style={{ fontSize: 12, fontWeight: 700, fontFamily: "'Space Mono',monospace", color: deltaEntPct >= 0 ? "#4ECDC4" : "#FF6B6B" }}>
                      {deltaEntPct >= 0 ? "+" : ""}{Math.round(deltaEntPct)}%
                    </span>}
                  </div>
                  <div style={{ display: "flex", gap: 4, height: 20 }}>
                    <div style={{ position: "relative", flex: 1, background: "#252538", borderRadius: 6, overflow: "hidden" }}>
                      <div style={{ position: "absolute", inset: 0, width: `${Math.min(100, totalEntratePrec / Math.max(totalEntrate, totalEntratePrec, 1) * 100)}%`, background: "#4ECDC444", borderRadius: 6 }} />
                      <div style={{ position: "relative", padding: "2px 8px", fontSize: 10, color: "#aaa" }}>{mese(mesePrecedente.getMonth(), lang)} {formattaValuta(totalEntratePrec)}</div>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 4, height: 20, marginTop: 4 }}>
                    <div style={{ position: "relative", flex: 1, background: "#252538", borderRadius: 6, overflow: "hidden" }}>
                      <div style={{ position: "absolute", inset: 0, width: `${Math.min(100, totalEntrate / Math.max(totalEntrate, totalEntratePrec, 1) * 100)}%`, background: "#4ECDC488", borderRadius: 6 }} />
                      <div style={{ position: "relative", padding: "2px 8px", fontSize: 10, color: "#eee", fontWeight: 600 }}>{mese(meseVis.getMonth(), lang)} {formattaValuta(totalEntrate)}</div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Category trends vs previous month */}
          {catTrends.length > 0 && totalUscitePrec > 0 && (
            <div style={{ background: "#1a1a28", borderRadius: 20, padding: 20, marginBottom: 16, border: "1px solid #252538" }}>
              <div style={{ fontSize: 12, color: "#999", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 14 }}>{t(lang, "stats.categoryTrend")}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {catTrends.slice(0, 6).map(c => (
                  <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 16, width: 24, textAlign: "center", flexShrink: 0 }}>{c.emoji}</span>
                    <span style={{ fontSize: 12, color: "#ccc", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.nome}</span>
                    <span style={{ fontSize: 12, fontWeight: 600, fontFamily: "'Space Mono',monospace", color: "#888", flexShrink: 0 }}>{formattaValuta(c.curr)}</span>
                    <span style={{
                      fontSize: 11, fontWeight: 700, fontFamily: "'Space Mono',monospace", flexShrink: 0,
                      padding: "2px 6px", borderRadius: 6, minWidth: 48, textAlign: "center",
                      color: c.delta > 10 ? "#FF6B6B" : c.delta < -10 ? "#4ECDC4" : "#F0A500",
                      background: c.delta > 10 ? "#FF6B6B15" : c.delta < -10 ? "#4ECDC415" : "#F0A50015",
                    }}>
                      {c.delta >= 0 ? "+" : ""}{Math.round(c.delta)}%
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Saving rate gauge */}
          {totalEntrate > 0 && (
            <div style={{ background: "#1a1a28", borderRadius: 20, padding: 20, marginBottom: 24, border: "1px solid #252538" }}>
              <div style={{ fontSize: 12, color: "#999", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 14 }}>{t(lang, "stats.savingRate")}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                {/* Gauge ring */}
                <svg viewBox="0 0 80 80" width="70" height="70" style={{ flexShrink: 0 }}>
                  <circle cx="40" cy="40" r="32" fill="none" stroke="#252538" strokeWidth="8" />
                  <circle cx="40" cy="40" r="32" fill="none"
                    stroke={savingRate > 20 ? "#4ECDC4" : savingRate > 0 ? "#F0A500" : "#FF6B6B"}
                    strokeWidth="8" strokeLinecap="round"
                    strokeDasharray={`${Math.max(0, Math.min(100, savingRate)) / 100 * 201} 201`}
                    transform="rotate(-90 40 40)" />
                  <text x="40" y="38" textAnchor="middle" fill="#eee" fontSize="14" fontWeight="800" fontFamily="'Space Mono',monospace">
                    {Math.round(savingRate)}%
                  </text>
                  <text x="40" y="50" textAnchor="middle" fill="#888" fontSize="7" fontFamily="'DM Sans',sans-serif">{t(lang, "stats.savingsShort")}</text>
                </svg>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, color: "#ccc", marginBottom: 4 }}>
                    {savingRate > 30 ? t(lang, "stats.savingMsgExcellent") :
                     savingRate > 15 ? t(lang, "stats.savingMsgGood") :
                     savingRate > 0 ? t(lang, "stats.savingMsgLow") :
                     t(lang, "stats.savingMsgNegative")}
                  </div>
                  <div style={{ fontSize: 11, color: "#888" }}>
                    {t(lang, "stats.saved")}: {formattaValuta(Math.max(0, totalEntrate - totalUscite))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {perCategoria.length === 0 && <div style={{ color: "#555", textAlign: "center", padding: 40, fontSize: 14 }}>{t(lang, "stats.noDataThisMonth")}</div>}

      {/* ─── Previsione prossimo mese ─── */}
      <div style={{ background: "#1a1a28", borderRadius: 20, padding: 20, marginBottom: 24, border: "1px solid #252538" }}>
        <div style={{ fontSize: 12, color: "#999", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 14 }}>
          {t(lang, "stats.forecastTitle")} — {mese(nextMonthDate.getMonth(), lang)}
        </div>
        {forecast.monthsUsed === 0 ? (
          <div style={{ fontSize: 13, color: "#666" }}>{t(lang, "stats.forecastNotEnoughData")}</div>
        ) : (
          <>
            <div style={{ fontSize: 28, fontWeight: 800, fontFamily: "'Space Mono',monospace", color: "#a78bfa" }}>
              {formattaValuta(forecast.forecast)}
            </div>
            <div style={{ fontSize: 11, color: "#666", marginTop: 4 }}>
              {t(lang, "stats.forecastBasedOnPrefix")} {forecast.monthsUsed} {t(lang, "stats.forecastBasedOnSuffix")}
            </div>
            {forecast.perCategory.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <div style={{ fontSize: 10, color: "#777", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 8 }}>
                  {t(lang, "stats.forecastByCategory")}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {forecast.perCategory.slice(0, 5).map(c => (
                    <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 14 }}>{c.emoji}</span>
                      <span style={{ fontSize: 12, color: "#ccc", flex: 1 }}>{c.nome}</span>
                      <span style={{ fontSize: 12, color: "#aaa", fontFamily: "'Space Mono',monospace" }}>{formattaValuta(c.valore)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* ─── Storico saldi 12 mesi ─── */}
      {(() => {
        const mesi12 = Array.from({ length: 12 }, (_, i) => {
          const d = new Date(oggi.getFullYear(), oggi.getMonth() - (11 - i), 1);
          const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
          const txM = transazioni.filter(t => t.data?.slice(0, 7) === ym);
          const e = txM.filter(t => t.tipo === "entrata").reduce((s, t) => s + t.importo, 0);
          const u = txM.filter(t => t.tipo === "uscita").reduce((s, t) => s + t.importo, 0);
          return { label: mese(d.getMonth(), lang), anno: d.getFullYear(), ym, entrate: e, uscite: u, saldo: e - u };
        });

        const haData = mesi12.some(m => m.entrate > 0 || m.uscite > 0);
        if (!haData) return null;

        const maxVal = Math.max(...mesi12.flatMap(m => [m.entrate, m.uscite]), 1);
        const CHART_H = 90;
        const CHART_W = 300;
        const barW = 8;
        const gap = CHART_W / 12;

        // Saldo line points
        const maxAbs = Math.max(...mesi12.map(m => Math.abs(m.saldo)), 1);
        const midY = CHART_H / 2;
        const saldoPoints = mesi12.map((m, i) => {
          const x = gap * i + gap / 2;
          const y = midY - (m.saldo / maxAbs) * (midY - 8);
          return `${x},${y}`;
        }).join(" ");

        return (
          <div style={{ background: "#1a1a28", borderRadius: 20, padding: "18px 16px", margin: "0 0 24px", border: "1px solid #252538" }}>
            <div style={{ fontSize: 12, color: "#999", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 14 }}>{t(lang, "stats.history12m")}</div>

            {/* Bar chart: entrate + uscite */}
            <div style={{ overflowX: "auto" }}>
              <svg viewBox={`0 0 ${CHART_W} ${CHART_H + 28}`} style={{ width: "100%", minWidth: 280 }}>
                {/* Zero line */}
                <line x1="0" y1={CHART_H} x2={CHART_W} y2={CHART_H} stroke="#252538" strokeWidth="1" />

                {mesi12.map((m, i) => {
                  const x = gap * i + gap / 2;
                  const hE = m.entrate > 0 ? (m.entrate / maxVal) * CHART_H : 0;
                  const hU = m.uscite > 0 ? (m.uscite / maxVal) * CHART_H : 0;
                  const isCurrent = m.ym === `${oggi.getFullYear()}-${String(oggi.getMonth() + 1).padStart(2, "0")}`;
                  return (
                    <g key={m.ym}>
                      {/* Entrate bar */}
                      <rect x={x - barW - 1} y={CHART_H - hE} width={barW} height={Math.max(hE, 1)}
                        rx="2" fill={isCurrent ? "#4ECDC4" : "#4ECDC433"} />
                      {/* Uscite bar */}
                      <rect x={x + 1} y={CHART_H - hU} width={barW} height={Math.max(hU, 1)}
                        rx="2" fill={isCurrent ? "#FF6B6B" : "#FF6B6B33"} />
                      {/* Month label */}
                      <text x={x} y={CHART_H + 12} textAnchor="middle"
                        fill={isCurrent ? "#a78bfa" : "#555"} fontSize="7"
                        fontFamily="'DM Sans',sans-serif" fontWeight={isCurrent ? "700" : "400"}>
                        {m.label}
                      </text>
                      <text x={x} y={CHART_H + 21} textAnchor="middle"
                        fill="#333" fontSize="6" fontFamily="'DM Sans',sans-serif">
                        {m.anno !== oggi.getFullYear() ? m.anno : ""}
                      </text>
                    </g>
                  );
                })}

                {/* Saldo net line */}
                <polyline points={saldoPoints} fill="none" stroke="#a78bfa" strokeWidth="1.5"
                  strokeLinecap="round" strokeLinejoin="round" opacity="0.8" />
                {mesi12.map((m, i) => {
                  const x = gap * i + gap / 2;
                  const y = midY - (m.saldo / maxAbs) * (midY - 8);
                  return <circle key={m.ym} cx={x} cy={y} r="2.5" fill="#a78bfa" opacity="0.9" />;
                })}
              </svg>
            </div>

            {/* Legend */}
            <div style={{ display: "flex", gap: 16, marginTop: 4, justifyContent: "center" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, color: "#888" }}>
                <div style={{ width: 10, height: 10, borderRadius: 2, background: "#4ECDC4" }} /> {t(lang, "stats.income")}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, color: "#888" }}>
                <div style={{ width: 10, height: 10, borderRadius: 2, background: "#FF6B6B" }} /> {t(lang, "stats.expenses")}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, color: "#888" }}>
                <div style={{ width: 16, height: 2, borderRadius: 1, background: "#a78bfa" }} /> {t(lang, "stats.netBalance")}
              </div>
            </div>

            {/* Summary row: best and worst month */}
            {(() => {
              const withData = mesi12.filter(m => m.entrate > 0 || m.uscite > 0);
              if (withData.length < 2) return null;
              const best = withData.reduce((a, b) => a.saldo > b.saldo ? a : b);
              const worst = withData.reduce((a, b) => a.saldo < b.saldo ? a : b);
              const avgUscite = withData.reduce((s, m) => s + m.uscite, 0) / withData.length;
              return (
                <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                  <div style={{ flex: 1, background: "#111119", borderRadius: 10, padding: "8px 10px" }}>
                    <div style={{ fontSize: 9, color: "#555", textTransform: "uppercase", letterSpacing: 0.5 }}>{t(lang, "stats.bestMonth")}</div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#4ECDC4", fontFamily: "'Space Mono',monospace", marginTop: 2 }}>{best.label}</div>
                    <div style={{ fontSize: 10, color: "#4ECDC4" }}>{best.saldo >= 0 ? "+" : ""}{formattaValuta(best.saldo)}</div>
                  </div>
                  <div style={{ flex: 1, background: "#111119", borderRadius: 10, padding: "8px 10px" }}>
                    <div style={{ fontSize: 9, color: "#555", textTransform: "uppercase", letterSpacing: 0.5 }}>{t(lang, "stats.worstMonth")}</div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#FF6B6B", fontFamily: "'Space Mono',monospace", marginTop: 2 }}>{worst.label}</div>
                    <div style={{ fontSize: 10, color: "#FF6B6B" }}>{worst.saldo >= 0 ? "+" : ""}{formattaValuta(worst.saldo)}</div>
                  </div>
                  <div style={{ flex: 1, background: "#111119", borderRadius: 10, padding: "8px 10px" }}>
                    <div style={{ fontSize: 9, color: "#555", textTransform: "uppercase", letterSpacing: 0.5 }}>{t(lang, "stats.avgExpensesLabel")}</div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#F0A500", fontFamily: "'Space Mono',monospace", marginTop: 2 }}>
                      {formattaValuta(avgUscite)}
                    </div>
                    <div style={{ fontSize: 10, color: "#555" }}>{t(lang, "stats.perMonth")}</div>
                  </div>
                </div>
              );
            })()}
          </div>
        );
      })()}
      </div>
    </div>
  );
}
