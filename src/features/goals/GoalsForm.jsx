import { useState } from "react";
import { t } from "../../lib/i18n.js";
import { inputStyle } from "../../components/ui/styles.js";

// Goals form component
export function GoalsForm({ onAdd, onCancel, conti = [], lang = "it" }) {
  const [nome, setNome] = useState("");
  const [targetAmount, setTargetAmount] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [currentAmount, setCurrentAmount] = useState("");
  const [contributionType, setContributionType] = useState("manual");
  const [contributionValue, setContributionValue] = useState("");
  const [autoAdd, setAutoAdd] = useState(false);
  const [contoId, setContoId] = useState("");
  
  function handleSubmit() {
    if (!nome.trim() || !targetAmount) return;
    onAdd({
      nome: nome.trim(),
      targetAmount: parseFloat(targetAmount),
      targetDate: targetDate || null,
      currentAmount: parseFloat(currentAmount) || 0,
      contributionType,
      contributionValue: contributionType !== "manual" ? parseFloat(contributionValue) || 0 : 0,
      autoAdd,
      contoId: contoId || null,
    });
    setNome(""); setTargetAmount(""); setTargetDate(""); setCurrentAmount("");
    setContributionType("manual"); setContributionValue(""); setAutoAdd(false); setContoId("");
    onCancel?.();
  }
  
  return (
    <div style={{ background: "#111119", borderRadius: 12, padding: 12, marginBottom: 10, border: "1px solid #252538" }}>
      <input type="text" value={nome} onChange={e => setNome(e.target.value)} placeholder={t(lang, "goals.namePlaceholderLong")}
        style={{ ...inputStyle, marginBottom: 8, background: "#1a1a28" }} />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
        <input type="number" inputMode="decimal" value={targetAmount} onChange={e => setTargetAmount(e.target.value)} placeholder={t(lang, "goals.targetPlaceholder")}
          style={{ flex: "1 1 100px", padding: "8px 10px", background: "#1a1a28", border: "1px solid #252538", borderRadius: 8, color: "#eee", fontSize: 13, fontFamily: "'DM Sans',sans-serif", outline: "none" }} />
        <input type="number" inputMode="decimal" value={currentAmount} onChange={e => setCurrentAmount(e.target.value)} placeholder={t(lang, "goals.savedPlaceholderLong")}
          style={{ flex: "1 1 100px", padding: "8px 10px", background: "#1a1a28", border: "1px solid #252538", borderRadius: 8, color: "#eee", fontSize: 13, fontFamily: "'DM Sans',sans-serif", outline: "none" }} />
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
        <input type="date" value={targetDate} onChange={e => setTargetDate(e.target.value)} placeholder={t(lang, "form.date")}
          style={{ flex: "1 1 100px", padding: "8px 10px", background: "#1a1a28", border: "1px solid #252538", borderRadius: 8, color: "#666", fontSize: 12, outline: "none", colorScheme: "dark" }} />
      </div>
      {conti.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 11, color: "#888", marginBottom: 6 }}>{t(lang, "goals.linkedAccount")}</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button onClick={() => setContoId("")} style={{
              padding: "5px 10px", borderRadius: 8, cursor: "pointer", fontSize: 11, fontWeight: 600,
              background: contoId === "" ? "#6C5CE722" : "transparent",
              border: contoId === "" ? "1px solid #6C5CE7" : "1px solid #252538",
              color: contoId === "" ? "#a78bfa" : "#666",
            }}>{t(lang, "form.none")}</button>
            {conti.map(c => (
              <button key={c.id} onClick={() => setContoId(c.id)} style={{
                padding: "5px 10px", borderRadius: 8, cursor: "pointer", fontSize: 11, fontWeight: 600,
                background: contoId === c.id ? "#6C5CE722" : "transparent",
                border: contoId === c.id ? "1px solid #6C5CE7" : "1px solid #252538",
                color: contoId === c.id ? "#a78bfa" : "#888",
              }}>{c.icona} {c.nome}</button>
            ))}
          </div>
        </div>
      )}
      {/* Contribution type */}
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 11, color: "#888", marginBottom: 6 }}>{t(lang, "goals.autoSavings")}</div>
        <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
          {["manual", "percent", "fixed"].map(tp => (
            <button key={tp} onClick={() => setContributionType(tp)} style={{
              flex: 1, padding: "6px 0", borderRadius: 8, cursor: "pointer",
              fontSize: 11, fontWeight: 600,
              background: contributionType === tp ? "#6C5CE722" : "transparent",
              color: contributionType === tp ? "#a78bfa" : "#666",
              border: contributionType === tp ? "1px solid #6C5CE7" : "1px solid #252538",
            }}>
              {tp === "manual" ? t(lang, "goals.manual") : tp === "percent" ? t(lang, "goals.percentIncome") : t(lang, "goals.fixedAmount")}
            </button>
          ))}
        </div>
        {contributionType !== "manual" && (
          <input type="number" inputMode="decimal" value={contributionValue} onChange={e => setContributionValue(e.target.value)}
            placeholder={contributionType === "percent" ? t(lang, "goals.percentToSavePlaceholder") : t(lang, "goals.amountToSavePlaceholder")}
            style={{ width: "100%", padding: "8px 10px", background: "#1a1a28", border: "1px solid #6C5CE7", borderRadius: 8, color: "#eee", fontSize: 13, fontFamily: "'DM Sans',sans-serif", outline: "none" }} />
        )}
      </div>
      {/* Auto-add toggle */}
      <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, cursor: "pointer" }}>
        <input type="checkbox" checked={autoAdd} onChange={e => setAutoAdd(e.target.checked)} style={{ width: 16, height: 16 }} />
        <span style={{ fontSize: 12, color: "#aaa" }}>{t(lang, "goals.autoApplyToIncome")}</span>
      </label>
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={onCancel} style={{ padding: "8px 12px", background: "none", border: "1px solid #333", borderRadius: 8, color: "#888", fontSize: 12 }}>✕</button>
        <button onClick={handleSubmit} disabled={!nome.trim() || !targetAmount} style={{ flex: 1, padding: "8px", background: nome.trim() && targetAmount ? "#6C5CE7" : "#252538", border: "none", borderRadius: 8, color: nome.trim() && targetAmount ? "#fff" : "#555", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>{t(lang, "common.add")}</button>
      </div>
    </div>
  );
}
