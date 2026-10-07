import { forwardRef } from "react";
import { color, alpha, accentGradient, displayFont } from "./styles.js";

// ─── Shared button ───
// One look per intent, so "primary / secondary / danger / success" mean the
// same thing on every screen instead of ~180 hand-rolled inline styles.
//   primary   — the one main action on a screen (gradient)
//   secondary — neutral outline (cancel, back, less important)
//   success   — positive action (settle, confirm payment)
//   danger    — destructive (delete, revoke, remove)
//   ghost     — text-only, for low-emphasis inline actions
// `loading` shows a spinner and blocks clicks; `disabled` dims it.
const VARIANTS = {
  primary:   { background: accentGradient, color: color.bg, border: "none" },
  secondary: { background: "transparent", color: color.textSecondary, border: `1px solid ${color.border}` },
  success:   { background: alpha(color.positive, 0.1), color: color.positive, border: `1px solid ${alpha(color.positive, 0.4)}` },
  danger:    { background: alpha(color.negative, 0.1), color: color.negative, border: `1px solid ${alpha(color.negative, 0.4)}` },
  ghost:     { background: "none", color: color.accent, border: "none" },
};
const SIZES = {
  sm: { padding: "7px 12px", fontSize: 12, borderRadius: 10 },
  md: { padding: "13px 16px", fontSize: 14, borderRadius: 14 },
};

export const Button = forwardRef(function Button({ variant = "secondary", size = "md", fullWidth = false, loading = false, disabled = false, icon: Icon, children, style, ...rest }, ref) {
  const v = VARIANTS[variant] || VARIANTS.secondary;
  const inactive = disabled || loading;
  return (
    <button
      ref={ref}
      type="button"
      disabled={inactive}
      aria-busy={loading || undefined}
      {...rest}
      style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
        width: fullWidth ? "100%" : undefined, fontWeight: 700, fontFamily: displayFont,
        cursor: inactive ? "default" : "pointer", opacity: disabled ? 0.5 : 1,
        ...SIZES[size], ...v, ...style,
      }}
    >
      {loading ? <Spinner size={14} /> : Icon ? <Icon size={size === "sm" ? 14 : 16} /> : null}
      {children}
    </button>
  );
});

// Spinner lives here (not its own file) so Button can use it; export it for
// LoadingState and anything else that needs a bare spinner.
export function Spinner({ size = 18 }) {
  return (
    <span role="status" aria-label="loading" style={{
      display: "inline-block", width: size, height: size, borderRadius: "50%", flexShrink: 0,
      border: "2px solid currentColor", borderTopColor: "transparent",
      animation: "finanza-spin 0.7s linear infinite",
    }} />
  );
}
