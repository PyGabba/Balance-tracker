// ─── Shared style constants ───
// Used across many feature forms — extracted from App.jsx rather than
// duplicated per-feature.
export const labelStyle = { display: "block", fontSize: 11, color: "oklch(54% 0.018 258)", marginBottom: 6, letterSpacing: 0.5, textTransform: "uppercase" };
export const inputStyle = { width: "100%", maxWidth: "100%", padding: "14px 16px", background: "oklch(19% 0.022 258)", border: "1px solid oklch(28% 0.02 258)", borderRadius: 14, color: "oklch(96% 0.008 258)", fontSize: 15, fontFamily: "'Inter',sans-serif", outline: "none", boxSizing: "border-box", WebkitAppearance: "none" };
export const filterLabelStyle = { fontSize: 10, color: "oklch(54% 0.018 258)", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 6 };

// ─── Design tokens (visual redesign — oklch palette) ───
// One cool-neutral hue family for backgrounds/text, one accent hue (blue),
// and semantic colors (positive/negative/debt-warn) sharing the accent's
// lightness/chroma — only the hue rotates. `debt`/`warn` are the same
// token: the household-debt feature's amber doubles as the app's general
// warning tone (stats insights, goal deadlines) rather than introducing a
// second unrelated amber.
export const color = {
  bg: "oklch(15% 0.02 258)",
  surface: "oklch(19% 0.022 258)",
  surfaceRaised: "oklch(23% 0.025 258)",
  border: "oklch(28% 0.02 258)",
  borderStrong: "oklch(36% 0.024 258)",
  textPrimary: "oklch(96% 0.008 258)",
  textSecondary: "oklch(72% 0.02 258)",
  textMuted: "oklch(54% 0.018 258)",
  accent: "oklch(65% 0.17 250)",
  accentSoft: "oklch(65% 0.17 250 / 0.14)",
  // Second stop for accentGradient — never used standalone as a semantic color.
  accentSecondary: "oklch(70% 0.15 200)",
  // Second persona/avatar hue (first persona defaults to `accent`).
  personaPink: "oklch(68% 0.16 350)",
  positive: "oklch(70% 0.15 165)",
  negative: "oklch(66% 0.19 20)",
  debt: "oklch(74% 0.13 80)",
  debtSoft: "oklch(74% 0.13 80 / 0.15)",
  warn: "oklch(74% 0.13 80)",
};

// Shared purple→cyan CTA gradient — was a repeated raw literal
// (#6C5CE7→#a855f7) in nearly every primary button across the app.
export const accentGradient = `linear-gradient(135deg, ${color.accent}, ${color.accentSecondary})`;

// Appends an alpha channel to a color — used for soft tinted backgrounds/
// borders. Handles both this file's `oklch(L% C H)` tokens (which need the
// `oklch(L% C H / A)` slash syntax — the old hex "#RRGGBB + 2-digit-suffix"
// trick silently produces an invalid, dropped CSS value on them) and plain
// "#RRGGBB" hex (persona/category colors, still hex from a color-picker
// input, so the old suffix trick stays correct there). `a` is a 0-1 fraction.
export function alpha(tokenOrHex, a) {
  if (tokenOrHex.startsWith("#")) {
    return tokenOrHex + Math.round(a * 255).toString(16).padStart(2, "0");
  }
  return tokenOrHex.replace(/\)$/, ` / ${a})`);
}

// Tabular-figure money display — the hero of most cards, so it gets its
// own scale distinct from the Inter UI type used everywhere else.
export const moneyFont = "'IBM Plex Mono', ui-monospace, monospace";
export const displayFont = "'Inter', sans-serif";
