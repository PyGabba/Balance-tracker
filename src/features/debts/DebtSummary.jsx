import { useState, useRef, useEffect } from "react";
import { IconScale, IconChevronRight, IconCheck } from "@tabler/icons-react";
import { t } from "../../lib/i18n.js";
import { formattaValuta } from "../../lib/format.js";
import { generaId } from "../../lib/appHelpers.js";
import { buildSettlementTransaction } from "../../services/debtService.js";
import { color, alpha, moneyFont, displayFont } from "../../components/ui/styles.js";

const MAX_ROWS = 3;      // debts shown on the home card; the rest are one tap away in DebitiView
const UNDO_MS = 8000;    // how long a just-settled row stays around with its Undo link

// ─── Debt card ───
// "Marco owes Anna €37.50  [Settle €37.50]" — settling is one tap, right here,
// and the row then turns into "✓ Settled · Undo" instead of silently
// vanishing. Undo deletes the settlement transaction again, so an accidental
// tap costs nothing. Partial payments, the month breakdown and the history
// live in DebitiView (header tap). Debt data (debitiGlobale/allPeople) is
// computed once in App.jsx and shared with DebitiView; settling goes through
// onSettle/onUndoSettle, so it uses the same offline-first write path.
export function DebtSummary({ debitiGlobale, allPeople, onOpen, onSettle, onUndoSettle, lang = "it" }) {
  const [settled, setSettled] = useState([]); // { txId, pDa, pA, importo }
  const busy = useRef(new Set());               // keys mid-settle: a double tap must not settle twice
  const timers = useRef(new Map());

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const person = (id) => allPeople.find(p => p.id === id) || { id, nome: id, emoji: "👤", colore: color.textMuted };

  async function settle(d) {
    const key = `${d.da}->${d.a}`;
    if (busy.current.has(key)) return;
    busy.current.add(key);
    const pDa = person(d.da), pA = person(d.a);
    const tx = buildSettlementTransaction(d, d.importo, { generaId, recipientName: pA.nome });
    try {
      await onSettle(tx);
      setSettled(list => [...list, { txId: tx.id, pDa, pA, importo: tx.importo }]);
      timers.current.set(tx.id, setTimeout(() => dismiss(tx.id), UNDO_MS));
    } finally {
      busy.current.delete(key);
    }
  }

  function dismiss(txId) {
    clearTimeout(timers.current.get(txId));
    timers.current.delete(txId);
    setSettled(list => list.filter(s => s.txId !== txId));
  }

  async function undo(txId) {
    dismiss(txId);
    await onUndoSettle(txId);
  }

  const shown = debitiGlobale.slice(0, MAX_ROWS);
  const hidden = debitiGlobale.length - shown.length;
  const allSquare = debitiGlobale.length === 0;

  const rowStyle = { display: "flex", alignItems: "center", gap: 10, padding: "10px 0", borderTop: `1px solid ${color.border}` };
  const names = { fontSize: 13, color: color.textSecondary, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

  return (
    <div style={{ background: color.surface, borderRadius: 16, padding: "14px 16px 6px", marginBottom: 14, border: `1px solid ${color.debtSoft}`, boxSizing: "border-box" }}>
      <button onClick={onOpen} style={{
        width: "100%", textAlign: "left", background: "none", border: "none", padding: 0, marginBottom: 10,
        cursor: "pointer", display: "flex", alignItems: "center", gap: 10, font: "inherit",
      }}>
        <span style={{ color: color.debt, display: "flex" }}><IconScale size={17} /></span>
        <span style={{ flex: 1, fontSize: 11, color: color.debt, textTransform: "uppercase", letterSpacing: 0.6, fontWeight: 700 }}>{t(lang, "home.debtBalance")}</span>
        <span style={{ color: color.textMuted, display: "flex" }}><IconChevronRight size={16} /></span>
      </button>

      {settled.map(s => (
        <div key={s.txId} style={rowStyle}>
          <span style={{ color: color.positive, display: "flex" }}><IconCheck size={16} /></span>
          <div style={{ ...names, color: color.positive, fontWeight: 600 }}>
            {t(lang, "home.settled")} · {s.pDa.nome} → {s.pA.nome} {formattaValuta(s.importo)}
          </div>
          <button onClick={() => undo(s.txId)} style={{
            background: "none", border: "none", color: color.accent, fontSize: 12, fontWeight: 700,
            cursor: "pointer", padding: "6px 0 6px 8px", fontFamily: displayFont,
          }}>{t(lang, "home.undo")}</button>
        </div>
      ))}

      {allSquare && settled.length === 0 && (
        <div style={{ ...rowStyle, color: color.positive, fontSize: 13, fontWeight: 600 }}>
          <IconCheck size={16} />{t(lang, "home.allSquare")}
        </div>
      )}

      {shown.map(d => {
        const pDa = person(d.da), pA = person(d.a);
        return (
          <div key={`${d.da}->${d.a}`} style={rowStyle}>
            <div style={names}>
              {pDa.emoji} <b style={{ color: color.textPrimary, fontWeight: 600 }}>{pDa.nome}</b> {t(lang, "home.owes")} <b style={{ color: color.textPrimary, fontWeight: 600 }}>{pA.nome}</b>
            </div>
            <button onClick={() => settle(d)} style={{
              flexShrink: 0, padding: "8px 12px", borderRadius: 10, cursor: "pointer",
              background: alpha(color.positive, 0.1), color: color.positive, border: `1px solid ${alpha(color.positive, 0.4)}`,
              fontSize: 13, fontWeight: 700, fontFamily: moneyFont, fontVariantNumeric: "tabular-nums",
            }}>
              <span style={{ fontFamily: displayFont }}>{t(lang, "home.settle")}</span> {formattaValuta(d.importo)}
            </button>
          </div>
        );
      })}

      {hidden > 0 && (
        <button onClick={onOpen} style={{
          ...rowStyle, width: "100%", background: "none", border: "none", borderTop: `1px solid ${color.border}`,
          color: color.textMuted, fontSize: 12, cursor: "pointer", fontFamily: displayFont, textAlign: "left",
        }}>
          {hidden === 1 ? t(lang, "home.moreDebtsOne") : t(lang, "home.moreDebts").replace("{n}", String(hidden))}
        </button>
      )}
      {!hidden && <div style={{ height: 8 }} />}
    </div>
  );
}
