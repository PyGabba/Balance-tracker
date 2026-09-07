import { color, displayFont } from "./styles.js";

// ─── Filter chip (search & advanced filters) ───
export function FilterChip({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      background: active ? color.accentSoft : color.surface,
      border: "1px solid " + (active ? color.accent : color.border),
      borderRadius: 10, color: active ? color.accent : color.textSecondary,
      cursor: "pointer", fontSize: 12, fontWeight: active ? 700 : 500, fontFamily: displayFont,
      padding: "6px 10px", whiteSpace: "nowrap", flexShrink: 0, transition: "all 0.15s",
    }}>{children}</button>
  );
}
