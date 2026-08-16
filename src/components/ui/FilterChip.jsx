// ─── Filter chip (search & advanced filters) ───
export function FilterChip({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      background: active ? "#6C5CE722" : "#12121e",
      border: "1px solid " + (active ? "#6C5CE7" : "#252538"),
      borderRadius: 10, color: active ? "#a78bfa" : "#999",
      cursor: "pointer", fontSize: 12, fontWeight: active ? 700 : 500,
      padding: "6px 10px", whiteSpace: "nowrap", flexShrink: 0, transition: "all 0.15s",
    }}>{children}</button>
  );
}
