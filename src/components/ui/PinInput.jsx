import { color, accentGradient, displayFont } from "./styles.js";

export function PinDots({ value, maxLen, shake }) {
  return (
    <div style={{ display: "flex", gap: 10, justifyContent: "center", margin: "24px 0 20px",
      animation: shake ? "pinShake 0.4s ease" : "none" }}>
      {Array.from({ length: maxLen }).map((_, i) => (
        <div key={i} style={{
          width: 13, height: 13, borderRadius: "50%",
          background: i < value.length ? accentGradient : "transparent",
          border: i < value.length ? "none" : `1.5px solid ${color.borderStrong}`,
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
    border: "none", borderRadius: "50%", fontFamily: displayFont,
    fontSize: 20, fontWeight: 600, cursor: "pointer", transition: "all 0.12s",
    display: "flex", alignItems: "center", justifyContent: "center",
    height: 64, userSelect: "none", WebkitUserSelect: "none",
  };
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, width: "100%", maxWidth: 260, margin: "0 auto" }}>
      {keys.map((k, i) => {
        if (k === "") return <div key={i} />;
        const isDel = k === "⌫";
        return (
          <button key={i}
            onPointerDown={e => { e.preventDefault(); if (disabled) return; isDel ? onDelete() : onDigit(k); }}
            style={{
              ...btnBase,
              background: isDel ? "transparent" : color.surface,
              color: isDel ? color.textSecondary : color.textPrimary,
              border: isDel ? "none" : `1px solid ${color.border}`,
              fontSize: isDel ? 18 : 20,
              fontFamily: isDel ? displayFont : "'IBM Plex Mono', monospace",
              opacity: disabled ? 0.4 : 1,
            }}
          >{k}</button>
        );
      })}
    </div>
  );
}
