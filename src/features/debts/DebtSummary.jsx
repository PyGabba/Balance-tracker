import { t } from "../../lib/i18n.js";
import { formattaValuta } from "../../lib/format.js";
import { color, moneyFont } from "../../components/ui/styles.js";

// ─── Debt summary card ───
// Compact, tappable one-line summary of the household's all-time debt —
// opens the full DebitiView sub-page (see App.jsx) for the month/global
// breakdown, settle flow, and settlement history. Debt data itself
// (debitiGlobale/allPeople) is computed once in App.jsx and shared with
// DebitiView, this component is presentation only.
export function DebtSummary({ debitiGlobale, allPeople, onOpen, lang = "it" }) {
  const allSquare = debitiGlobale.length === 0;
  const top = debitiGlobale[0] || null;
  const pDa = top ? (allPeople.find(p => p.id === top.da) || { nome: top.da, colore: color.textMuted }) : null;
  const pA = top ? (allPeople.find(p => p.id === top.a) || { nome: top.a, colore: color.textMuted }) : null;
  const extra = debitiGlobale.length - 1;

  return (
    <button onClick={onOpen} style={{
      width: "100%", textAlign: "left", background: color.surface, borderRadius: 16,
      padding: "14px 16px", marginBottom: 14, border: `1px solid ${color.debtSoft}`,
      cursor: "pointer", display: "flex", alignItems: "center", gap: 10, boxSizing: "border-box",
      font: "inherit",
    }}>
      <span style={{ fontSize: 17 }}>⚖</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 11, color: color.debt, textTransform: "uppercase", letterSpacing: 0.6, fontWeight: 700 }}>{t(lang, "home.debtBalance")}</div>
        <div style={{ fontSize: 13, color: color.textSecondary, marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {allSquare ? t(lang, "home.allSquare") : <>{pDa.nome} {t(lang, "home.owes")} {pA.nome}{extra > 0 ? ` +${extra}` : ""}</>}
        </div>
      </div>
      {!allSquare && (
        <div style={{ fontSize: 17, fontWeight: 700, fontFamily: moneyFont, color: color.debt, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>{formattaValuta(top.importo)}</div>
      )}
      <span style={{ color: color.textMuted, fontSize: 16, flexShrink: 0 }}>›</span>
    </button>
  );
}
