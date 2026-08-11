import { useEffect, useState } from "react";

// ─── Toast leggeri, senza dipendenze ───
// Uso: import { toast } from "./components/Toast"; toast("Salvato!", "success");
// <ToastHost /> va montato una volta nel root.

let listeners = [];
let nextId = 1;

export function toast(message, type = "info") {
  const t = { id: nextId++, message, type };
  listeners.forEach(fn => fn(t));
}

export function ToastHost() {
  const [toasts, setToasts] = useState([]);

  useEffect(() => {
    const onToast = (t) => {
      setToasts(prev => [...prev.slice(-2), t]); // max 3 visibili
      setTimeout(() => setToasts(prev => prev.filter(x => x.id !== t.id)), 3500);
    };
    listeners.push(onToast);
    return () => { listeners = listeners.filter(fn => fn !== onToast); };
  }, []);

  if (toasts.length === 0) return null;

  const colors = {
    success: { bg: "#4ECDC418", border: "#4ECDC455", text: "#4ECDC4", icon: "✓" },
    error:   { bg: "#FF6B6B18", border: "#FF6B6B55", text: "#FF6B6B", icon: "✕" },
    info:    { bg: "#6C5CE718", border: "#6C5CE755", text: "#a78bfa", icon: "ℹ" },
  };

  return (
    <div style={{
      position: "fixed", top: "calc(12px + env(safe-area-inset-top, 0px))", left: "50%",
      transform: "translateX(-50%)", zIndex: 9999, display: "flex", flexDirection: "column",
      gap: 8, width: "min(92vw, 400px)", pointerEvents: "none",
    }}>
      {toasts.map(t => {
        const c = colors[t.type] || colors.info;
        return (
          <div key={t.id} style={{
            background: "#1a1a28", border: `1px solid ${c.border}`, borderRadius: 12,
            padding: "10px 14px", display: "flex", alignItems: "flex-start", gap: 10,
            boxShadow: "0 8px 24px #000a", fontFamily: "'DM Sans', sans-serif",
            animation: "toastIn 0.25s ease",
          }}>
            <span style={{ color: c.text, fontWeight: 800, fontSize: 13, flexShrink: 0 }}>{c.icon}</span>
            <span style={{ color: "#ddd", fontSize: 13, lineHeight: 1.4, whiteSpace: "pre-line" }}>{t.message}</span>
          </div>
        );
      })}
      <style>{`@keyframes toastIn { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }`}</style>
    </div>
  );
}
