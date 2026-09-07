import { mese } from "../../lib/i18n.js";
import { color, moneyFont } from "./styles.js";

// ─── Month selector bar (fixed, shared between Home and Stats) ───
export function MonthBar({ meseOffset, setMeseOffset }) {
  const oggi = new Date();
  const meseVis = new Date(oggi.getFullYear(), oggi.getMonth() - meseOffset, 1);
  const nomeMese = mese(meseVis.getMonth()) + " " + meseVis.getFullYear();
  const navBtn = { background: "none", border: "none", color: color.textSecondary, fontSize: 17, padding: "4px 10px", cursor: "pointer" };

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 16px", background: color.bg, borderBottom: `1px solid ${color.border}`, flexShrink: 0 }}>
      <button onClick={() => setMeseOffset(o => o + 1)} style={navBtn}>‹</button>
      <div style={{ fontSize: 13, fontWeight: 700, color: color.textPrimary, fontFamily: moneyFont }}>{nomeMese}</div>
      <button onClick={() => setMeseOffset(o => Math.max(0, o - 1))} style={{ ...navBtn, color: meseOffset === 0 ? color.textMuted : color.textSecondary, cursor: meseOffset === 0 ? "not-allowed" : "pointer" }} disabled={meseOffset === 0}>›</button>
    </div>
  );
}
