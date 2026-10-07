import { useEffect, useRef, useState } from "react";
import { t } from "../../lib/i18n.js";
import { color, displayFont } from "./styles.js";
import { Button } from "./Button.jsx";

// ─── Confirm dialog ───
// Replaces the browser's confirm(): same one-line call site, but styled like
// the app, translated, and with destructive actions marked as such.
//
//   if (!(await confirmDialog({ message: t(lang, "confirm.deleteGoal"), danger: true, lang }))) return;
//
// Like toast(), it's a module-level function plus a <DialogHost /> mounted
// once in the root. Resolves true (confirmed) / false (cancelled, Escape or
// backdrop tap). A second call while one is open cancels the first.

let listener = null;

export function confirmDialog({ title, message, confirmLabel, cancelLabel, danger = false, lang = "it" }) {
  return new Promise(resolve => {
    if (!listener) { resolve(window.confirm(message)); return; } // host not mounted (tests, early boot)
    listener({ title, message, confirmLabel, cancelLabel, danger, lang, resolve });
  });
}

export function DialogHost() {
  const [dlg, setDlg] = useState(null);
  const cancelRef = useRef(null);
  const confirmRef = useRef(null);

  useEffect(() => {
    listener = (next) => setDlg(prev => { prev?.resolve(false); return next; });
    return () => { listener = null; };
  }, []);

  const close = (result) => { dlg?.resolve(result); setDlg(null); };

  useEffect(() => {
    if (!dlg) return;
    // Destructive: focus lands on Cancel so a stray Enter can't delete.
    (dlg.danger ? cancelRef : confirmRef).current?.focus();
    const onKey = (e) => { if (e.key === "Escape") close(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!dlg) return null;
  return (
    <div onClick={() => close(false)} style={{
      position: "fixed", inset: 0, zIndex: 10000, background: "rgba(0,0,0,.6)",
      display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
    }}>
      <div role="alertdialog" aria-modal="true" aria-label={dlg.title || dlg.message} onClick={e => e.stopPropagation()} style={{
        width: "min(340px, 100%)", background: color.surface, border: `1px solid ${color.border}`,
        borderRadius: 18, padding: 20, boxShadow: "0 16px 48px rgba(0,0,0,.6)", fontFamily: displayFont,
      }}>
        {dlg.title && <div style={{ fontSize: 16, fontWeight: 700, color: color.textPrimary, marginBottom: 8 }}>{dlg.title}</div>}
        <div style={{ fontSize: 14, color: color.textSecondary, lineHeight: 1.5, whiteSpace: "pre-line", marginBottom: 18 }}>{dlg.message}</div>
        <div style={{ display: "flex", gap: 8 }}>
          <Button ref={cancelRef} variant="secondary" fullWidth onClick={() => close(false)}>{dlg.cancelLabel || t(dlg.lang, "common.cancel")}</Button>
          <Button ref={confirmRef} variant={dlg.danger ? "danger" : "primary"} fullWidth onClick={() => close(true)}>
            {dlg.confirmLabel || t(dlg.lang, dlg.danger ? "common.delete" : "common.continue")}
          </Button>
        </div>
      </div>
    </div>
  );
}
