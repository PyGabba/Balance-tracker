import { useState } from "react";
import { personaLogin } from "../../api.js";
import { toast } from "../../components/Toast.jsx";
import { t } from "../../lib/i18n.js";

// Step 2 of the layered login flow (MOD-025) — optional, on top of the
// already-completed household PIN login. Only renders anything if at
// least one persona has a credential enrolled (hasCredential); a
// household that never uses this feature never sees this control at all.
export function PersonaSwitcher({ persone, activePersonaId, onSwitched, lang = "it" }) {
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const enrollable = persone.filter(p => p.hasCredential);
  if (enrollable.length === 0) return null;

  const active = persone.find(p => p.id === activePersonaId);

  function openPanel() {
    setOpen(true);
    setSelectedId(null);
    setPassword("");
    setError("");
  }

  async function handleLogin() {
    setBusy(true);
    setError("");
    try {
      await personaLogin(selectedId, password);
      onSwitched(selectedId);
      setOpen(false);
    } catch (e) {
      setError(e.message || t(lang, "toast.errorSavePrefix"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ position: "relative" }}>
      <button onClick={openPanel} title={t(lang, "personaSwitcher.title")} style={{
        background: active ? "#4ECDC422" : "none", border: active ? "1px solid #4ECDC4" : "1px solid #252538",
        borderRadius: 8, cursor: "pointer", color: active ? "#4ECDC4" : "#888",
        padding: "4px 8px", display: "flex", alignItems: "center", gap: 4,
        fontFamily: "'DM Sans',sans-serif", flexShrink: 0, minWidth: 0, maxWidth: 90,
      }}>
        {active ? (
          <>
            <span style={{ fontSize: 14, lineHeight: 1, flexShrink: 0 }}>{active.emoji}</span>
            <span style={{ fontSize: 12, lineHeight: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>{active.nome}</span>
          </>
        ) : <span style={{ fontSize: 12, lineHeight: 1 }}>👤</span>}
      </button>

      {open && (
        <div onClick={() => setOpen(false)} style={{
          position: "fixed", inset: 0, background: "#0006", zIndex: 20,
          display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
        }}>
          <div onClick={e => e.stopPropagation()} style={{
            width: "100%", maxWidth: 280,
            background: "#1a1a28", border: "1px solid #6C5CE744", borderRadius: 14, padding: 12,
            boxShadow: "0 8px 32px #0008",
          }}>
            <div style={{ fontSize: 11, color: "#a78bfa", fontWeight: 700, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>
              {t(lang, "personaSwitcher.title")}
            </div>

            {!selectedId ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {enrollable.map(p => (
                  <button key={p.id} onClick={() => { setSelectedId(p.id); setError(""); }} style={{
                    display: "flex", alignItems: "center", gap: 8, padding: "8px 10px",
                    background: p.id === activePersonaId ? "#4ECDC422" : "#111119",
                    border: "1px solid " + (p.id === activePersonaId ? "#4ECDC4" : "#252538"),
                    borderRadius: 10, color: "#eee", fontSize: 13, cursor: "pointer", textAlign: "left",
                  }}>
                    <span style={{ fontSize: 16 }}>{p.emoji}</span>
                    <span style={{ flex: 1 }}>{p.nome}</span>
                    {p.id === activePersonaId && <span style={{ fontSize: 10, color: "#4ECDC4" }}>✓</span>}
                  </button>
                ))}
                {active && (
                  <div style={{ fontSize: 10, color: "#555", marginTop: 4 }}>{t(lang, "personaSwitcher.currentlyAs")} {active.nome}</div>
                )}
              </div>
            ) : (
              <div>
                <div style={{ fontSize: 12, color: "#ccc", marginBottom: 8 }}>
                  {enrollable.find(p => p.id === selectedId)?.emoji} {enrollable.find(p => p.id === selectedId)?.nome}
                </div>
                <input
                  type="password" autoFocus placeholder={t(lang, "personaSwitcher.password")}
                  value={password} onChange={e => setPassword(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter" && password) handleLogin(); if (e.key === "Escape") setSelectedId(null); }}
                  style={{ width: "100%", padding: "8px 10px", background: "#111119", border: "1px solid #6C5CE7", borderRadius: 10, color: "#eee", fontSize: 13, outline: "none", boxSizing: "border-box", marginBottom: 8 }}
                />
                {error && <div style={{ fontSize: 11, color: "#FF6B6B", marginBottom: 8 }}>{error}</div>}
                <div style={{ display: "flex", gap: 6 }}>
                  <button disabled={busy || !password} onClick={handleLogin} style={{
                    flex: 1, padding: "8px", background: "#6C5CE7", border: "none", borderRadius: 10,
                    color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer", opacity: !password ? 0.5 : 1,
                  }}>{t(lang, "login.login")}</button>
                  <button onClick={() => setSelectedId(null)} style={{ padding: "8px 10px", background: "none", border: "1px solid #333", borderRadius: 10, color: "#888", fontSize: 12, cursor: "pointer" }}>✕</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
