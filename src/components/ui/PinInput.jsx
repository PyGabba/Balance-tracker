export function PinDots({ value, maxLen, shake }) {
  return (
    <div style={{ display: "flex", gap: 14, justifyContent: "center", margin: "24px 0 20px",
      animation: shake ? "pinShake 0.4s ease" : "none" }}>
      {Array.from({ length: maxLen }).map((_, i) => (
        <div key={i} style={{
          width: 14, height: 14, borderRadius: "50%",
          background: i < value.length ? "linear-gradient(135deg, #6C5CE7, #a855f7)" : "#252538",
          border: i < value.length ? "none" : "2px solid #333",
          transition: "background 0.15s, transform 0.15s",
          transform: i === value.length - 1 ? "scale(1.25)" : "scale(1)",
        }} />
      ))}
    </div>
  );
}

export function NumPad({ onDigit, onDelete, disabled }) {
  const keys = ["1","2","3","4","5","6","7","8","9","","0","⌫"];
  const btnBase = {
    border: "none", borderRadius: 18, fontFamily: "'DM Sans',sans-serif",
    fontSize: 24, fontWeight: 700, cursor: "pointer", transition: "all 0.12s",
    display: "flex", alignItems: "center", justifyContent: "center",
    height: 68, userSelect: "none", WebkitUserSelect: "none",
  };
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, width: "100%", maxWidth: 280, margin: "0 auto" }}>
      {keys.map((k, i) => {
        if (k === "") return <div key={i} />;
        const isDel = k === "⌫";
        return (
          <button key={i}
            onPointerDown={e => { e.preventDefault(); if (disabled) return; isDel ? onDelete() : onDigit(k); }}
            style={{
              ...btnBase,
              background: isDel ? "transparent" : "#1a1a28",
              color: isDel ? "#888" : "#eee",
              border: isDel ? "none" : "1px solid #252538",
              fontSize: isDel ? 20 : 24,
              opacity: disabled ? 0.4 : 1,
            }}
          >{k}</button>
        );
      })}
    </div>
  );
}
