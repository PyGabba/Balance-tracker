import { useState } from "react";
import { t } from "../../lib/i18n.js";
import { formattaValuta } from "../../lib/format.js";
import { GoalGauge } from "./GoalGauge.jsx";

// Goal row component
export function GoalRow({ goal, onUpdate, onDelete, conti = [], lang = "it" }) {
  const [mode, setMode] = useState(null); // null | "versa" | "edit"
  const [amount, setAmount] = useState("");
  const [eNome, setENome] = useState(goal.nome);
  const [eTarget, setETarget] = useState(String(goal.targetAmount || ""));
  const [eDate, setEDate] = useState(goal.targetDate || "");
  const [eCurrent, setECurrent] = useState(String(goal.currentAmount || 0));
  const [eCType, setECType] = useState(goal.contributionType || "manual");
  const [eCValue, setECValue] = useState(goal.contributionValue ? String(goal.contributionValue) : "");
  const [eAuto, setEAuto] = useState(goal.autoAdd === true);
  const [eConto, setEConto] = useState(goal.contoId || "");
  const conto = conti.find(c => c.id === goal.contoId);

  const current = goal.currentAmount || 0;
  const pct = goal.targetAmount > 0 ? (current / goal.targetAmount * 100) : 0;
  const done = goal.targetAmount > 0 && current >= goal.targetAmount;
  const daysLeft = goal.targetDate ? Math.ceil((new Date(goal.targetDate) - new Date()) / (1000*60*60*24)) : null;
  // Monthly pace needed to hit the target by the date
  const mesiRimasti = daysLeft !== null && daysLeft > 0 ? daysLeft / 30.44 : null;
  const alMese = !done && mesiRimasti ? (goal.targetAmount - current) / mesiRimasti : null;
  const isAuto = goal.autoAdd && goal.contributionType !== "manual" && goal.contributionValue > 0;

  function openEdit() {
    setENome(goal.nome); setETarget(String(goal.targetAmount || ""));
    setEDate(goal.targetDate || ""); setECurrent(String(current));
    setECType(goal.contributionType || "manual");
    setECValue(goal.contributionValue ? String(goal.contributionValue) : "");
    setEAuto(goal.autoAdd === true);
    setEConto(goal.contoId || "");
    setMode(mode === "edit" ? null : "edit");
  }

  function handleVersa() {
    const val = parseFloat(amount.replace(",", "."));
    if (!isNaN(val) && val !== 0) {
      onUpdate(goal.id, { currentAmount: Math.max(0, Math.round((current + val) * 100) / 100) });
    }
    setAmount(""); setMode(null);
  }

  function handleSaveEdit() {
    const target = parseFloat(eTarget.replace(",", "."));
    const curr = parseFloat(eCurrent.replace(",", "."));
    if (!eNome.trim() || isNaN(target) || target <= 0) return;
    onUpdate(goal.id, {
      nome: eNome.trim(),
      targetAmount: target,
      targetDate: eDate || null,
      currentAmount: !isNaN(curr) && curr >= 0 ? curr : current,
      contributionType: eCType,
      contributionValue: eCType !== "manual" ? parseFloat(eCValue.replace(",", ".")) || 0 : 0,
      autoAdd: eAuto,
      contoId: eConto || null,
    });
    setMode(null);
  }

  return (
    <div style={{ background: "#111119", borderRadius: 12, padding: 12, border: mode ? "1px solid #6C5CE7" : done ? "1px solid #4ECDC455" : "1px solid #252538" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <GoalGauge current={current} target={goal.targetAmount} size={50} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: "#eee" }}>{goal.nome}</span>
            {done && <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4, background: "#4ECDC422", color: "#4ECDC4" }}>{t(lang, "goals.achieved")}</span>}
            {isAuto && !done && (
              <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4, background: "#6C5CE722", color: "#a78bfa" }}>
                {t(lang, "goals.auto")} {goal.contributionType === "percent" ? `${goal.contributionValue}%` : formattaValuta(goal.contributionValue)}
              </span>
            )}
            {conto && (
              <span style={{ fontSize: 9, fontWeight: 600, padding: "2px 6px", borderRadius: 4, background: "#252538", color: "#999" }}>
                {conto.icona} {conto.nome}
              </span>
            )}
          </div>
          <div style={{ fontSize: 11, color: "#888" }}>
            {formattaValuta(current)} / {formattaValuta(goal.targetAmount)} ({pct.toFixed(0)}%)
            {daysLeft !== null && !done && <span style={{ color: daysLeft < 0 ? "#FF6B6B" : "#666", marginLeft: 8 }}>{daysLeft < 0 ? `${t(lang, "goals.overdueBy")} ${Math.abs(daysLeft)}${t(lang, "goals.daysUnit")}` : `${daysLeft}${t(lang, "stats.daysLeft")}`}</span>}
          </div>
          {alMese !== null && alMese > 0 && (
            <div style={{ fontSize: 10, color: "#F0A500", marginTop: 2 }}>≈ {formattaValuta(alMese)}{t(lang, "goals.perMonthToReach")}</div>
          )}
        </div>
        <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
          {!done && <button onClick={() => { setAmount(""); setMode(mode === "versa" ? null : "versa"); }} title={t(lang, "goals.deposit")} style={{ background: mode === "versa" ? "#4ECDC422" : "none", border: mode === "versa" ? "1px solid #4ECDC4" : "1px solid #252538", borderRadius: 7, color: "#4ECDC4", cursor: "pointer", fontSize: 13, padding: "3px 8px", fontWeight: 700 }}>+</button>}
          <button onClick={openEdit} style={{ background: "none", border: "none", color: "#6C5CE7", cursor: "pointer", fontSize: 14 }}>✏</button>
          <button onClick={() => { if (confirm(t(lang, "confirm.deleteGoal"))) onDelete(goal.id); }} style={{ background: "none", border: "none", color: "#FF6B6B", cursor: "pointer", fontSize: 14 }}>×</button>
        </div>
      </div>

      {/* Quick deposit */}
      {mode === "versa" && (
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <input type="text" inputMode="decimal" autoFocus value={amount} onChange={e => setAmount(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") handleVersa(); if (e.key === "Escape") setMode(null); }}
            placeholder={t(lang, "goals.depositPlaceholder")} style={{ flex: 1, padding: "8px 10px", background: "#1a1a28", border: "1px solid #4ECDC4", borderRadius: 8, color: "#eee", fontSize: 14, fontFamily: "'Space Mono',monospace", outline: "none", minWidth: 0 }} />
          <button onClick={handleVersa} style={{ padding: "8px 14px", background: "#4ECDC4", border: "none", borderRadius: 8, color: "#0a0a12", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>{t(lang, "goals.depositButton")}</button>
        </div>
      )}

      {/* Full edit */}
      {mode === "edit" && (
        <div style={{ marginTop: 10 }}>
          <input type="text" value={eNome} onChange={e => setENome(e.target.value)} placeholder={t(lang, "goals.namePlaceholder")}
            style={{ width: "100%", boxSizing: "border-box", padding: "8px 10px", background: "#1a1a28", border: "1px solid #252538", borderRadius: 8, color: "#eee", fontSize: 13, outline: "none", marginBottom: 8, fontFamily: "'DM Sans',sans-serif" }} />
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <input type="text" inputMode="decimal" value={eTarget} onChange={e => setETarget(e.target.value)} placeholder={t(lang, "goals.targetPlaceholder")}
              style={{ flex: 1, minWidth: 0, padding: "8px 10px", background: "#1a1a28", border: "1px solid #252538", borderRadius: 8, color: "#eee", fontSize: 13, outline: "none", fontFamily: "'Space Mono',monospace" }} />
            <input type="text" inputMode="decimal" value={eCurrent} onChange={e => setECurrent(e.target.value)} placeholder={t(lang, "goals.savedPlaceholder")}
              style={{ flex: 1, minWidth: 0, padding: "8px 10px", background: "#1a1a28", border: "1px solid #252538", borderRadius: 8, color: "#eee", fontSize: 13, outline: "none", fontFamily: "'Space Mono',monospace" }} />
          </div>
          <input type="date" value={eDate} onChange={e => setEDate(e.target.value)}
            style={{ width: "100%", boxSizing: "border-box", padding: "8px 10px", background: "#1a1a28", border: "1px solid #252538", borderRadius: 8, color: "#888", fontSize: 12, outline: "none", marginBottom: 8, colorScheme: "dark" }} />
          {conti.length > 0 && (
            <div style={{ display: "flex", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
              <button onClick={() => setEConto("")} style={{
                padding: "5px 10px", borderRadius: 8, cursor: "pointer", fontSize: 10, fontWeight: 600,
                background: eConto === "" ? "#6C5CE722" : "transparent",
                border: eConto === "" ? "1px solid #6C5CE7" : "1px solid #252538",
                color: eConto === "" ? "#a78bfa" : "#666",
              }}>{t(lang, "goals.noAccount")}</button>
              {conti.map(c => (
                <button key={c.id} onClick={() => setEConto(c.id)} style={{
                  padding: "5px 10px", borderRadius: 8, cursor: "pointer", fontSize: 10, fontWeight: 600,
                  background: eConto === c.id ? "#6C5CE722" : "transparent",
                  border: eConto === c.id ? "1px solid #6C5CE7" : "1px solid #252538",
                  color: eConto === c.id ? "#a78bfa" : "#888",
                }}>{c.icona} {c.nome}</button>
              ))}
            </div>
          )}
          <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
            {["manual", "percent", "fixed"].map(tp => (
              <button key={tp} onClick={() => setECType(tp)} style={{
                flex: 1, padding: "5px 0", borderRadius: 8, cursor: "pointer", fontSize: 10, fontWeight: 600,
                background: eCType === tp ? "#6C5CE722" : "transparent",
                color: eCType === tp ? "#a78bfa" : "#666",
                border: eCType === tp ? "1px solid #6C5CE7" : "1px solid #252538",
              }}>{tp === "manual" ? t(lang, "goals.manual") : tp === "percent" ? t(lang, "goals.percentIncome") : t(lang, "goals.fixedAmount")}</button>
            ))}
          </div>
          {eCType !== "manual" && (
            <>
              <input type="text" inputMode="decimal" value={eCValue} onChange={e => setECValue(e.target.value)}
                placeholder={eCType === "percent" ? t(lang, "goals.percentToSavePlaceholder") : t(lang, "goals.amountToSavePlaceholder")}
                style={{ width: "100%", boxSizing: "border-box", padding: "8px 10px", background: "#1a1a28", border: "1px solid #6C5CE7", borderRadius: 8, color: "#eee", fontSize: 13, outline: "none", marginBottom: 6, fontFamily: "'Space Mono',monospace" }} />
              <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, cursor: "pointer" }}>
                <input type="checkbox" checked={eAuto} onChange={e => setEAuto(e.target.checked)} style={{ width: 14, height: 14 }} />
                <span style={{ fontSize: 11, color: "#aaa" }}>{t(lang, "goals.autoApplyToIncome")}</span>
              </label>
            </>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => setMode(null)} style={{ padding: "8px 12px", background: "none", border: "1px solid #333", borderRadius: 8, color: "#888", fontSize: 12, cursor: "pointer" }}>✕</button>
            <button onClick={handleSaveEdit} disabled={!eNome.trim() || !eTarget} style={{ flex: 1, padding: "8px", background: eNome.trim() && eTarget ? "#6C5CE7" : "#252538", border: "none", borderRadius: 8, color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>{t(lang, "common.save")}</button>
          </div>
        </div>
      )}
    </div>
  );
}
