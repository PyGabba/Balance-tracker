import { useState } from "react";
import { IconCheck, IconPlus, IconTarget, IconWallet, IconReceipt2 } from "@tabler/icons-react";
import { t } from "../lib/i18n.js";
import { AccountIcon } from "../components/ui/AccountIcon.jsx";
import { Button } from "../components/ui/Button.jsx";
import { toast } from "../components/Toast.jsx";
import { missingDefaultAccounts, DEFAULT_ACCOUNTS } from "../services/onboardingService.js";
import { color, alpha, accentGradient, displayFont } from "../components/ui/styles.js";

// ─── "Get started" card ───
// Shown on an empty home so a new household knows what to do without reading
// anything: one primary action (add the first expense), and two optional
// one-tap setups (default accounts, a first goal). Which steps are done comes
// from the data (services/onboardingService.js); this component only renders
// them and offers the actions.
const STEP_ICON = { expense: IconReceipt2, accounts: IconWallet, goal: IconTarget };

export function GettingStarted({ steps, householdName, conti, onAddConto, onAddExpense, onAddGoal, onDismiss, lang = "it" }) {
  const [busyKey, setBusyKey] = useState(null);
  const names = { bank: t(lang, "onboarding.accBank"), cash: t(lang, "onboarding.accCash"), card: t(lang, "onboarding.accCard") };
  const missing = new Set(missingDefaultAccounts(conti, names).map(d => d.key));

  async function addDefault(d) {
    if (busyKey) return;
    setBusyKey(d.key);
    try { await onAddConto({ nome: names[d.key], icona: d.icona, saldoIniziale: 0 }); }
    catch (e) { toast(`${t(lang, "toast.errorSavePrefix")} ${e.message}`, "error"); }
    finally { setBusyKey(null); }
  }

  return (
    <div style={{
      background: color.surface, borderRadius: 20, padding: 18, marginBottom: 14, fontFamily: displayFont,
      border: `1px solid ${alpha(color.accent, 0.35)}`, boxShadow: `0 8px 28px ${alpha(color.accent, 0.12)}`,
    }}>
      <div style={{ fontSize: 18, fontWeight: 800, color: color.textPrimary }}>
        {t(lang, "onboarding.welcome")}{householdName ? `, ${householdName}` : ""}!
      </div>
      <div style={{ fontSize: 13, color: color.textSecondary, lineHeight: 1.5, marginTop: 4, marginBottom: 14 }}>{t(lang, "onboarding.intro")}</div>

      {steps.map(s => {
        const Icon = STEP_ICON[s.id];
        return (
          <div key={s.id} style={{ display: "flex", gap: 12, padding: "12px 0", borderTop: `1px solid ${color.border}` }}>
            <span style={{
              width: 28, height: 28, borderRadius: "50%", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
              background: s.done ? alpha(color.positive, 0.15) : color.surfaceRaised, color: s.done ? color.positive : color.textSecondary,
            }}>{s.done ? <IconCheck size={15} /> : <Icon size={15} />}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: s.done ? color.textMuted : color.textPrimary }}>
                {t(lang, `onboarding.${s.id}.title`)}
                {s.optional && !s.done && <span style={{ fontSize: 10, fontWeight: 600, color: color.textMuted, marginLeft: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>{t(lang, "onboarding.optional")}</span>}
              </div>
              {!s.done && <div style={{ fontSize: 12, color: color.textMuted, lineHeight: 1.45, marginTop: 2 }}>{t(lang, `onboarding.${s.id}.hint`)}</div>}

              {s.id === "expense" && !s.done && (
                <Button variant="primary" size="sm" icon={IconPlus} onClick={onAddExpense} style={{ marginTop: 10, background: accentGradient }}>{t(lang, "onboarding.expense.cta")}</Button>
              )}
              {/* Stays after the first tap while defaults are still missing: you
                  usually want bank AND cash, and the step turns done at one. */}
              {s.id === "accounts" && missing.size > 0 && (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10, alignItems: "center" }}>
                  {s.done && <span style={{ fontSize: 12, color: color.textMuted }}>{t(lang, "onboarding.addMore")}</span>}
                  {DEFAULT_ACCOUNTS.map(d => missing.has(d.key) && (
                    <Button key={d.key} size="sm" loading={busyKey === d.key} onClick={() => addDefault(d)} style={{ borderRadius: 20 }}>
                      <AccountIcon icona={d.icona} size={13} />{names[d.key]}
                    </Button>
                  ))}
                </div>
              )}
              {s.id === "goal" && !s.done && (
                <Button size="sm" icon={IconPlus} onClick={onAddGoal} style={{ marginTop: 10 }}>{t(lang, "onboarding.goal.cta")}</Button>
              )}
            </div>
          </div>
        );
      })}

      <div style={{ textAlign: "right", marginTop: 4 }}>
        <Button variant="ghost" size="sm" onClick={onDismiss} style={{ color: color.textMuted, fontWeight: 600 }}>{t(lang, "onboarding.dismiss")}</Button>
      </div>
    </div>
  );
}
