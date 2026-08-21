import { mese } from "../../lib/i18n.js";

// ─── Month selector bar (fixed, shared between Home and Stats) ───
export function MonthBar({ meseOffset, setMeseOffset }) {
  const oggi = new Date();
  const meseVis = new Date(oggi.getFullYear(), oggi.getMonth() - meseOffset, 1);
  const nomeMese = mese(meseVis.getMonth()) + " " + meseVis.getFullYear();
  const navBtn = { background: "#1a1a28", border: "1px solid #252538", borderRadius: 10, color: "#eee", fontSize: 16, padding: "5px 12px", cursor: "pointer" };

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 16px", background: "#120f16", borderBottom: "1px solid #1e1e2e", flexShrink: 0 }}>
      <button onClick={() => setMeseOffset(o => o + 1)} style={navBtn}>◂</button>
      <div style={{ fontSize: 16, fontWeight: 700, color: "#eee", fontFamily: "'DM Sans',sans-serif" }}>{nomeMese}</div>
      <button onClick={() => setMeseOffset(o => Math.max(0, o - 1))} style={{ ...navBtn, opacity: meseOffset === 0 ? 0.3 : 1 }} disabled={meseOffset === 0}>▸</button>
    </div>
  );
}
