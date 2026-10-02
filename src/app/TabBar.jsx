import { IconHome2, IconPlus, IconChartBar, IconPlane, IconChartLine, IconDownload } from "@tabler/icons-react";
import { t } from "../lib/i18n.js";
import { color, alpha, accentGradient, displayFont } from "../components/ui/styles.js";

export function TabBar({ tab, setTab, householdId, lang = "it" }) {
  const tabs = [
    { id: "home", label: t(lang, "nav.home") },
    { id: "aggiungi", label: t(lang, "nav.aggiungi") },
    { id: "portfolio", label: t(lang, "nav.portfolio") },
    { id: "viaggi", label: t(lang, "nav.viaggi") },
    { id: "stats", label: t(lang, "nav.stats") },
    { id: "export", label: t(lang, "nav.export") },
  ];

  const navColor = (active) => active ? color.accent : color.textMuted;

  const icons = {
    home: (active) => <IconHome2 size={21} color={navColor(active)} stroke={1.8} />,
    aggiungi: () => <IconPlus size={18} color="white" stroke={2.3} />,
    stats: (active) => <IconChartBar size={21} color={navColor(active)} stroke={1.8} />,
    export: (active) => <IconDownload size={21} color={navColor(active)} stroke={1.8} />,
    portfolio: (active) => <IconChartLine size={21} color={navColor(active)} stroke={1.8} />,
    viaggi: (active) => <IconPlane size={21} color={navColor(active)} stroke={1.8} />,
  };

  return (
    <div style={{
      position: "absolute",
      bottom: 0,
      left: 0,
      right: 0,
      width: "100%",
      background: color.bg,
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
        background: alpha(color.bg, 0.92),
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
                ? accentGradient
                : isActive ? color.accentSoft : "transparent",
              transition: "all 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
              boxShadow: isAdd ? `0 4px 14px ${alpha(color.accent, 0.4)}` : "none",
            }}>
              {icons[t.id]?.(isActive)}
            </div>
            <span style={{
              fontSize: "9px",
              fontFamily: displayFont,
              fontWeight: isActive ? 600 : 500,
              color: navColor(isActive),
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
