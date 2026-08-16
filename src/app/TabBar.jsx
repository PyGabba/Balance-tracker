import { t } from "../lib/i18n.js";

export function TabBar({ tab, setTab, householdId, lang = "it" }) {
  const baseTabs = [
    { id: "home", label: t(lang, "nav.home"), icon: "⌂" },
    { id: "aggiungi", label: t(lang, "nav.aggiungi"), icon: "+" },
    { id: "portfolio", label: t(lang, "nav.portfolio"), icon: "📈" },
    { id: "viaggi", label: t(lang, "nav.viaggi"), icon: "✈" },
    { id: "stats", label: t(lang, "nav.stats"), icon: "◔" },
    { id: "export", label: t(lang, "nav.export"), icon: "↓" },
  ];
  const tabs = baseTabs;

  const icons = {
    home: (active) => (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={active ? "#a78bfa" : "#94a3b8"} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 9.5L12 3l9 6.5V20a1 1 0 01-1 1H4a1 1 0 01-1-1V9.5z"/>
        <path d="M9 21V12h6v9"/>
      </svg>
    ),
    aggiungi: () => (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round">
        <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
      </svg>
    ),
    stats: (active) => (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={active ? "#a78bfa" : "#94a3b8"} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="12" width="4" height="9" rx="1"/>
        <rect x="10" y="7" width="4" height="14" rx="1"/>
        <rect x="17" y="3" width="4" height="18" rx="1"/>
      </svg>
    ),
    export: (active) => (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={active ? "#a78bfa" : "#94a3b8"} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>
        <line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="18" x2="20" y2="18"/>
      </svg>
    ),
    portfolio: (active) => (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={active ? "#a78bfa" : "#94a3b8"} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
      </svg>
    ),
    viaggi: (active) => (
      <svg width="22" height="22" viewBox="0 0 100 100" fill="none">
        <path d="M50 2C52 2 54 4 55 8L58 28L84 42C88 44 90 47 90 50C90 53 88 54 84 53L58 48L56 62L68 68C70 69 71 71 71 73C71 75 70 76 68 75L55 71L52 82C51 86 50 88 50 88C50 88 49 86 48 82L45 71L32 75C30 76 29 75 29 73C29 71 30 69 32 68L44 62L42 48L16 53C12 54 10 53 10 50C10 47 12 44 16 42L42 28L45 8C46 4 48 2 50 2Z" fill={active ? "#a78bfa" : "#94a3b8"} />
      </svg>
    ),
    };

  return (
    <div style={{
      position: "absolute",
      bottom: 0,
      left: 0,
      right: 0,
      width: "100%",
      background: "#111119",
      display: "flex",
      flexDirection: "column",
      zIndex: 100,
      flexShrink: 0,
      pointerEvents: "none",
    }}>
      <div style={{
        display: "flex",
        justifyContent: "space-around",
        alignItems: "center",
        background: "rgba(17, 17, 25, 0.92)",
        backdropFilter: "blur(25px) saturate(180%)",
        WebkitBackdropFilter: "blur(25px) saturate(180%)",
        borderRadius: "16px 16px 0 0",
        padding: "4px 12px 2px",
        border: "1px solid rgba(255, 255, 255, 0.08)",
        borderBottom: "none",
        pointerEvents: "all",
        gap: "2px",
      }}>
      {tabs.map(t => {
        const isActive = tab === t.id;
        const isAdd = t.id === "aggiungi";
        return (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            onTouchStart={(e) => e.currentTarget.style.opacity = "0.7"}
            onTouchEnd={(e) => e.currentTarget.style.opacity = "1"}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: "1px",
              padding: "3px 6px",
              flex: 1,
              transition: "all 0.25s cubic-bezier(0.4, 0, 0.2, 1)",
              opacity: 1,
            }}
          >
            <div style={{
              width: isAdd ? 32 : 22,
              height: isAdd ? 32 : 22,
              borderRadius: isAdd ? "50%" : "8px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: isAdd
                ? "linear-gradient(135deg, #6C5CE7, #a855f7)"
                : isActive ? "rgba(167, 139, 250, 0.18)" : "transparent",
              transition: "all 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
              boxShadow: isAdd ? "0 4px 12px rgba(108, 92, 231, 0.3)" : "none",
            }}>
              {icons[t.id]?.(isActive)}
            </div>
            <span style={{
              fontSize: "7px",
              fontFamily: "'DM Sans', 'Segoe UI', sans-serif",
              fontWeight: isActive ? 600 : 500,
              color: isActive ? "#a78bfa" : "#94a3b8",
              letterSpacing: "0.3px",
              whiteSpace: "nowrap",
              textOverflow: "ellipsis",
              overflow: "hidden",
              maxWidth: "100%",
              transition: "color 0.3s ease",
            }}>
              {t.label}
            </span>
          </button>
        );
      })}
      </div>
    </div>
  );
}
