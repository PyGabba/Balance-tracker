// ─── Shared style constants (MOD-012) ───
// Used across many feature forms — extracted from App.jsx rather than
// duplicated per-feature.
export const labelStyle = { display: "block", fontSize: 11, color: "#888", marginBottom: 6, letterSpacing: 0.5, textTransform: "uppercase" };
export const inputStyle = { width: "100%", maxWidth: "100%", padding: "14px 16px", background: "#1a1a28", border: "1px solid #252538", borderRadius: 14, color: "#eee", fontSize: 15, fontFamily: "'DM Sans',sans-serif", outline: "none", boxSizing: "border-box", WebkitAppearance: "none" };
export const filterLabelStyle = { fontSize: 10, color: "#777", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 6 };

// ─── Design tokens (ledger redesign, home-screen proof of concept) ───
// A warm off-black instead of the previous near-neutral #111119, so the
// UI doesn't read as generic dashboard-dark-mode. `debt` is a fourth
// semantic color (alongside positive/negative/accent) reserved for the
// household-debt feature — the app's actual point of difference from a
// generic tracker — so that surface gets its own visual identity instead
// of borrowing violet or teal.
export const color = {
  bg: "#120f16",
  surface: "#1c1826",
  surfaceRaised: "#231f30",
  border: "#2c2638",
  borderStrong: "#3a3348",
  textPrimary: "#f3f0f7",
  textSecondary: "#a79fb8",
  textMuted: "#6f6680",
  accent: "#7c6cf0",
  accentSoft: "#7c6cf022",
  positive: "#4fd1c5",
  negative: "#ff6b81",
  debt: "#e8ac4e",
  debtSoft: "#e8ac4e1e",
  // Same hue as `debt` (household-debt feature's accent) reused as the
  // general amber/warning tone elsewhere (stats insights, goal deadlines)
  // — one warm accent for the app rather than a second unrelated amber.
  warn: "#e8ac4e",
};

// Tabular-figure money display — the hero of most cards, so it gets its
// own scale distinct from the DM Sans UI type used everywhere else.
export const moneyFont = "'Space Mono', ui-monospace, monospace";
export const displayFont = "'DM Sans', sans-serif";
