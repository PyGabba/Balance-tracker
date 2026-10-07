import { IconCalendarEvent } from "@tabler/icons-react";
import { t } from "../lib/i18n.js";
import { formattaValuta } from "../lib/format.js";
import { color, moneyFont, displayFont } from "../components/ui/styles.js";

// ─── "Coming up" card ───
// The next recurring expenses due (rent, subscriptions, bills) so nobody is
// surprised by them. `bills` comes from services/dashboardService.js; the card
// renders nothing when there are none, keeping a quiet household's home quiet.
function whenLabel(days, lang) {
  if (days === 0) return t(lang, "home.today");
  if (days === 1) return t(lang, "home.tomorrow");
  return t(lang, "home.inDays").replace("{n}", String(days));
}

export function UpcomingBills({ bills, total, categorie, lang = "it" }) {
  if (!bills || bills.length === 0) return null;
  return (
    <div style={{ background: color.surface, borderRadius: 16, padding: "14px 16px 4px", marginBottom: 14, border: `1px solid ${color.border}` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span style={{ color: color.accent, display: "flex" }}><IconCalendarEvent size={16} /></span>
        <span style={{ fontSize: 11, color: color.textSecondary, letterSpacing: 0.5, textTransform: "uppercase", fontWeight: 600 }}>{t(lang, "home.upcoming")}</span>
      </div>
      {bills.map((b, i) => {
        const cat = categorie.find(c => c.id === b.categoria);
        return (
          <div key={b.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0", borderTop: i === 0 ? "none" : `1px solid ${color.border}`, fontFamily: displayFont }}>
            <span style={{ fontSize: 18, width: 24, textAlign: "center" }}>{cat?.emoji || "📦"}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, color: color.textPrimary, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.descrizione || cat?.nome || b.categoria}</div>
              <div style={{ fontSize: 11, color: b.days <= 1 ? color.warn : color.textMuted, marginTop: 1 }}>{whenLabel(b.days, lang)}</div>
            </div>
            <div style={{ fontSize: 14, fontWeight: 700, fontFamily: moneyFont, color: color.textPrimary, fontVariantNumeric: "tabular-nums" }}>
              {b.variabile ? "~" : ""}{formattaValuta(b.importo)}
            </div>
          </div>
        );
      })}
      {total > bills.length && (
        <div style={{ fontSize: 11, color: color.textMuted, padding: "6px 0 10px" }}>{t(lang, "home.moreUpcoming").replace("{n}", String(total - bills.length))}</div>
      )}
      {total <= bills.length && <div style={{ height: 6 }} />}
    </div>
  );
}
