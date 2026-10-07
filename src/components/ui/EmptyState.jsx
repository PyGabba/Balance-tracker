import { color, displayFont } from "./styles.js";
import { Spinner } from "./Button.jsx";

// ─── Empty & loading states ───
// "Nothing here yet" should say what the thing is for and what to do next,
// not just be a muted line of text; a loading screen should look like one.
export function EmptyState({ icon: Icon, title, hint, action, compact = false }) {
  return (
    <div style={{
      textAlign: "center", fontFamily: displayFont, padding: compact ? "16px 12px" : "40px 20px",
      display: "flex", flexDirection: "column", alignItems: "center", gap: 6,
    }}>
      {Icon && <span style={{ color: color.textMuted, display: "flex", marginBottom: 4 }}><Icon size={compact ? 22 : 30} stroke={1.5} /></span>}
      <div style={{ fontSize: compact ? 13 : 15, fontWeight: 600, color: color.textSecondary }}>{title}</div>
      {hint && <div style={{ fontSize: 12, color: color.textMuted, lineHeight: 1.5, maxWidth: 280 }}>{hint}</div>}
      {action && <div style={{ marginTop: 10 }}>{action}</div>}
    </div>
  );
}

export function LoadingState({ label }) {
  return (
    <div style={{ padding: 40, display: "flex", flexDirection: "column", alignItems: "center", gap: 10, color: color.textMuted, fontFamily: displayFont, fontSize: 13 }}>
      <Spinner size={20} />
      {label}
    </div>
  );
}
