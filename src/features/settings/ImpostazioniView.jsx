import { useState, useEffect } from "react";
import { deleteHousehold, setRecoveryEmail, fetchHousehold, createWidgetKey, revokeWidgetKey, createCalendarKey, revokeCalendarKey, getApiBase, fetchTrash, restoreTransaction, permanentDeleteTransaction, emptyTrash, updateValutaBase, fetchExchangeRates, updatePersonaRuolo, enrollPersonaCredential, removePersonaCredential, addPersona, removePersona } from "../../api.js";
import { LANGUAGES, t, mese } from "../../lib/i18n.js";
import { formattaValuta } from "../../lib/format.js";
import { toast } from "../../components/Toast.jsx";
import { labelStyle, inputStyle, color, alpha, accentGradient, moneyFont, displayFont } from "../../components/ui/styles.js";
import { VALUTE_FALLBACK } from "../transactions/helpers.js";
import { RecurringManagerSection } from "./RecurringManagerSection.jsx";
import { BackupSection } from "./BackupSection.jsx";
import { ContiCard } from "../accounts/ContiCard.jsx";

const HOUSEHOLD_ROLES = ["owner", "admin", "member", "guest"];

// ─── Back-chevron header shared by every settings sub-screen ───
function SubHeader({ title, onBack }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
      <button onClick={onBack} style={{ background: "none", border: "none", color: color.textSecondary, fontSize: 22, cursor: "pointer", padding: "0 6px 0 0", lineHeight: 1 }}>‹</button>
      <div style={{ fontSize: 18, fontWeight: 700, color: color.textPrimary }}>{title}</div>
    </div>
  );
}

export function ImpostazioniView({ householdName, householdId, persone, activePersonaId, onDeleted, categorie, onCategorieChange, onRestoreTransazione, valutaBase = "EUR", onValutaBaseChange, lang = "it", onLangChange, transazioni = [], onEditTransazione, onDeleteTransazione, conti = [], goals = [], onAddConto, onUpdateConto, onDeleteConto }) {
  const [screen, setScreen] = useState("list");
  const back = () => setScreen("list");

  const [valutaBusy, setValutaBusy] = useState(false);
  const [valuteDisponibili, setValuteDisponibili] = useState(VALUTE_FALLBACK);

  // MOD-025 foundation: a household-visible label, not a permission check —
  // see server/validation.js's validateRuolo comment. `persone` is derived
  // from the session on every parent render, so it won't reflect a role
  // change on its own until something re-triggers that render; mirror it
  // into local state so the chip list updates immediately after a save.
  const [personeLocal, setPersoneLocal] = useState(persone);
  useEffect(() => { setPersoneLocal(persone); }, [persone]);
  const [editingRuoloId, setEditingRuoloId] = useState(null);
  const [ruoloBusy, setRuoloBusy] = useState(false);

  const [addNomeInput, setAddNomeInput] = useState("");
  const [addBusy, setAddBusy] = useState(false);

  const [removeBusyId, setRemoveBusyId] = useState(null);
  // Best-effort client-side hint only — the server is the real
  // authority (owner+, see server/index.js). Shown for a PIN-only
  // session too, same as every other admin/owner control here.
  const isOwnerSession = !activePersonaId || personeLocal.find(p => p.id === activePersonaId)?.ruolo === "owner";

  async function handleRemovePersona(persona) {
    if (!confirm(`${t(lang, "confirm.removePersonaPrefix")} ${persona.nome} ${t(lang, "confirm.removePersonaSuffix")}`)) return;
    setRemoveBusyId(persona.id);
    try {
      const updated = await removePersona(persona.id);
      setPersoneLocal(updated);
    } catch (e) {
      toast(e.message || t(lang, "toast.errorSavePrefix"), "error");
    } finally {
      setRemoveBusyId(null);
    }
  }

  async function handleAddPersona() {
    const nome = addNomeInput.trim();
    if (!nome) return;
    setAddBusy(true);
    try {
      const updated = await addPersona(nome);
      setPersoneLocal(updated);
      setAddNomeInput("");
    } catch (e) {
      toast(e.message || t(lang, "toast.errorSavePrefix"), "error");
    } finally {
      setAddBusy(false);
    }
  }

  async function handleRuoloChange(personaId, ruolo) {
    setRuoloBusy(true);
    try {
      const updated = await updatePersonaRuolo(personaId, ruolo);
      setPersoneLocal(updated);
      setEditingRuoloId(null);
    } catch (e) {
      toast(e.message || t(lang, "toast.errorSavePrefix"), "error");
    } finally {
      setRuoloBusy(false);
    }
  }

  // MOD-025 Stage 1: fully optional per-persona password. Enrolling one
  // doesn't change how anyone logs in by default — see MOD-025-DESIGN.md.
  const [editingCredId, setEditingCredId] = useState(null);
  const [credCurrentInput, setCredCurrentInput] = useState("");
  const [credNewInput, setCredNewInput] = useState("");
  const [credEmailInput, setCredEmailInput] = useState("");
  const [credBusy, setCredBusy] = useState(false);

  function startEditCred(persona) {
    setEditingCredId(persona.id);
    setCredCurrentInput("");
    setCredNewInput("");
    setCredEmailInput(persona.credentialEmail || "");
  }

  async function handleCredSave(persona) {
    setCredBusy(true);
    try {
      // Only send email if it actually changed from what's already saved —
      // an untouched field shouldn't risk a spurious EMAIL_ALREADY_IN_USE
      // (e.g. re-saving a password without re-typing the email that's
      // already this same persona's own).
      const emailChanged = credEmailInput.trim() !== (persona.credentialEmail || "");
      const updated = await enrollPersonaCredential(
        persona.id, credNewInput, persona.hasCredential ? credCurrentInput : undefined,
        emailChanged ? credEmailInput.trim() : undefined
      );
      setPersoneLocal(updated);
      setEditingCredId(null);
      toast(t(lang, "toast.credentialSaved"), "success");
    } catch (e) {
      toast(e.message || t(lang, "toast.errorSavePrefix"), "error");
    } finally {
      setCredBusy(false);
    }
  }

  async function handleCredRemove(personaId) {
    setCredBusy(true);
    try {
      const updated = await removePersonaCredential(personaId);
      setPersoneLocal(updated);
      setEditingCredId(null);
    } catch (e) {
      toast(e.message || t(lang, "toast.errorSavePrefix"), "error");
    } finally {
      setCredBusy(false);
    }
  }

  useEffect(() => {
    fetchExchangeRates().then(r => {
      const codes = Object.keys(r.rates || {});
      if (codes.length > 0) setValuteDisponibili(codes.sort());
    }).catch(() => {});
  }, []);

  async function handleValutaBaseChange(nuovaValuta) {
    if (nuovaValuta === valutaBase) return;
    setValutaBusy(true);
    try {
      await updateValutaBase(nuovaValuta);
      onValutaBaseChange?.(nuovaValuta);
      toast(`${t(lang, "toast.currencyBaseSetPrefix")} ${nuovaValuta}`, "success");
    } catch (e) {
      toast(e.message || t(lang, "toast.errorCurrencyUpdate"), "error");
    } finally {
      setValutaBusy(false);
    }
  }

  const [fase, setFase] = useState("idle"); // idle | confirm | pin | deleting | done
  const [pin, setPin] = useState("");
  const [errore, setErrore] = useState("");

  // Household creation date (for the "N persone · dal Mese Anno" header
  // subtitle) piggybacks on the same fetchHousehold() call already made
  // for the recovery-email status below — no extra request.
  const [householdCreatedAt, setHouseholdCreatedAt] = useState(null);

  // Email di recupero
  const [hasRecoveryEmail, setHasRecoveryEmail] = useState(null); // null = ancora in caricamento
  const [recoveryEmailErrDetail, setRecoveryEmailErrDetail] = useState("");
  const [recoveryEmailInput, setRecoveryEmailInput] = useState("");
  const [recoveryEmailBusy, setRecoveryEmailBusy] = useState(false);
  const [editingRecoveryEmail, setEditingRecoveryEmail] = useState(false);

  useEffect(() => { loadRecoveryEmailStatus(); }, []);

  function loadRecoveryEmailStatus() {
    setHasRecoveryEmail(null);
    setRecoveryEmailErrDetail("");
    let done = false;
    (async () => {
      try {
        const h = await fetchHousehold(); // ora rifiuta (throw) su risposta non-ok, non torna più null silenziosamente
        if (!done) { setHasRecoveryEmail(!!h.hasRecoveryEmail); setHouseholdCreatedAt(h.createdAt || null); }
      } catch (e) {
        if (!done) { setHasRecoveryEmail("error"); setRecoveryEmailErrDetail(e.message || t(lang, "settings.unknownError")); }
      }
    })();
    const timeoutId = setTimeout(() => { if (!done) { done = true; setHasRecoveryEmail(prev => prev === null ? "error" : prev); setRecoveryEmailErrDetail(prev => prev || t(lang, "settings.recoveryEmailTimeout")); } }, 8000);
    return () => { done = true; clearTimeout(timeoutId); };
  }

  async function handleSaveRecoveryEmail() {
    const email = recoveryEmailInput.trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      toast(t(lang, "toast.enterValidEmail"), "error");
      return;
    }
    setRecoveryEmailBusy(true);
    try {
      await setRecoveryEmail(email);
      setHasRecoveryEmail(true);
      setEditingRecoveryEmail(false);
      setRecoveryEmailInput("");
      toast(t(lang, "toast.recoveryEmailSaved"), "success");
    } catch (e) { toast(`${t(lang, "toast.errorPrefix")} ${e.message}`, "error"); }
    setRecoveryEmailBusy(false);
  }

  // Widget key state
  const [widgetUrl, setWidgetUrl] = useState(null);
  const [widgetBusy, setWidgetBusy] = useState(false);

  async function handleCreateWidgetKey() {
    setWidgetBusy(true);
    try {
      const key = await createWidgetKey();
      setWidgetUrl(`${getApiBase()}/api/widget?key=${key}`);
      toast(t(lang, "toast.widgetKeyGenerated"), "success");
    } catch (e) { toast(`${t(lang, "toast.errorPrefix")} ${e.message}`, "error"); }
    setWidgetBusy(false);
  }

  async function handleRevokeWidgetKey() {
    if (!confirm(t(lang, "confirm.revokeWidgetKey"))) return;
    setWidgetBusy(true);
    try {
      await revokeWidgetKey();
      setWidgetUrl(null);
      toast(t(lang, "toast.widgetKeyRevoked"), "success");
    } catch (e) { toast(`${t(lang, "toast.errorPrefix")} ${e.message}`, "error"); }
    setWidgetBusy(false);
  }

  // Calendar sync key state
  const [calendarUrl, setCalendarUrl] = useState(null);
  const [calendarBusy, setCalendarBusy] = useState(false);

  async function handleCreateCalendarKey() {
    setCalendarBusy(true);
    try {
      const key = await createCalendarKey();
      setCalendarUrl(`${getApiBase()}/api/calendar.ics?key=${key}`);
      toast(t(lang, "toast.calendarKeyGenerated"), "success");
    } catch (e) { toast(`${t(lang, "toast.errorPrefix")} ${e.message}`, "error"); }
    setCalendarBusy(false);
  }

  async function handleRevokeCalendarKey() {
    if (!confirm(t(lang, "confirm.revokeCalendarKey"))) return;
    setCalendarBusy(true);
    try {
      await revokeCalendarKey();
      setCalendarUrl(null);
      toast(t(lang, "toast.calendarKeyRevoked"), "success");
    } catch (e) { toast(`${t(lang, "toast.errorPrefix")} ${e.message}`, "error"); }
    setCalendarBusy(false);
  }

  // Cestino (trash) state — loaded eagerly on mount (not just when opened)
  // so the settings-list row can show an accurate count badge.
  const [cestino, setCestino] = useState([]);
  const [cestinoLoading, setCestinoLoading] = useState(true);
  const [cestinoBusyId, setCestinoBusyId] = useState(null);

  async function loadCestino() {
    setCestinoLoading(true);
    try { setCestino(await fetchTrash()); } catch (e) { toast(`${t(lang, "toast.errorLoadTrashPrefix")} ${e.message}`, "error"); }
    setCestinoLoading(false);
  }
  useEffect(() => { loadCestino(); }, []);

  async function handleRestore(id) {
    setCestinoBusyId(id);
    try {
      const restored = await restoreTransaction(id);
      setCestino(prev => prev.filter(t => t.id !== id));
      onRestoreTransazione?.(restored);
      toast(t(lang, "toast.txRestored"), "success");
    } catch (e) { toast(`${t(lang, "toast.errorRestoreTxPrefix")} ${e.message}`, "error"); }
    setCestinoBusyId(null);
  }

  async function handlePermanentDelete(id) {
    if (!confirm(t(lang, "confirm.permanentDeleteTx"))) return;
    setCestinoBusyId(id);
    try {
      await permanentDeleteTransaction(id);
      setCestino(prev => prev.filter(t => t.id !== id));
      toast(t(lang, "toast.txPermanentlyDeleted"), "success");
    } catch (e) { toast(`${t(lang, "toast.errorPrefix")} ${e.message}`, "error"); }
    setCestinoBusyId(null);
  }

  async function handleEmptyCestino() {
    if (cestino.length === 0) return;
    if (!confirm(`${t(lang, "confirm.emptyTrashPrefix")} ${cestino.length} ${t(lang, "confirm.emptyTrashSuffix")}`)) return;
    try {
      await emptyTrash();
      setCestino([]);
      toast(t(lang, "toast.trashEmptied"), "success");
    } catch (e) { toast(`${t(lang, "toast.errorPrefix")} ${e.message}`, "error"); }
  }

  function giorniRimanenti(deletedAt) {
    const eliminato = new Date(deletedAt);
    const scadenza = new Date(eliminato.getTime() + 30 * 24 * 60 * 60 * 1000);
    const giorni = Math.ceil((scadenza - new Date()) / (24 * 60 * 60 * 1000));
    return Math.max(giorni, 0);
  }

  // Category editor state
  const [editingCatId, setEditingCatId] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [showNewCat, setShowNewCat] = useState(false);
  const [newCat, setNewCat] = useState({ emoji: "📦", nome: "", colore: "#A8A8A8" });

  function handleSaveEdit(id) {
    onCategorieChange(categorie.map(c => c.id === id ? { ...c, ...editForm } : c));
    setEditingCatId(null);
  }
  function handleDeleteCat(id) {
    onCategorieChange(categorie.filter(c => c.id !== id));
  }
  function handleAddCat() {
    if (!newCat.nome.trim()) return;
    const newId = newCat.nome.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "") + "_" + Date.now().toString(36);
    const without = categorie.filter(c => c.id !== "altro");
    const altro = categorie.find(c => c.id === "altro");
    const updated = [...without, { ...newCat, id: newId }, ...(altro ? [altro] : [])];
    onCategorieChange(updated);
    setShowNewCat(false);
    setNewCat({ emoji: "📦", nome: "", colore: "#A8A8A8" });
  }

  async function eseguiElimina() {
    if (!pin) return;
    setFase("deleting");
    setErrore("");
    try {
      await deleteHousehold(pin);
      setFase("done");
      setTimeout(() => onDeleted(), 1500);
    } catch (err) {
      setErrore(err.message || t(lang, "settings.deleteAccountErrorFallback"));
      setFase("pin");
    }
  }

  // ─── Flat settings-row list (default screen) ───
  if (screen === "list") {
    const currentLangLabel = LANGUAGES.find(l => l.code === lang)?.label || lang;
    const createdAtLabel = householdCreatedAt
      ? `${t(lang, "settings.since")} ${mese(new Date(householdCreatedAt).getMonth(), lang)} ${new Date(householdCreatedAt).getFullYear()}`
      : null;

    const rows = [
      { id: "persone", icon: "👥", label: t(lang, "settings.people") },
      { id: "categorie", icon: "🏷️", label: t(lang, "settings.row.categorie") },
      { id: "conti", icon: "🏦", label: t(lang, "settings.row.conti") },
      { id: "cestino", icon: "🗑️", label: t(lang, "settings.row.cestino"), badge: cestinoLoading ? null : String(cestino.length) },
      { id: "widget", icon: "📲", label: t(lang, "settings.row.widget") },
      { id: "calendario", icon: "📅", label: t(lang, "settings.row.calendario") },
      { id: "backup", icon: "💾", label: t(lang, "settings.row.backup") },
      { id: "email", icon: "✉️", label: t(lang, "settings.row.email") },
      { id: "valuta", icon: "💱", label: t(lang, "settings.row.valuta") },
      { id: "lingua", icon: "🌐", label: `${t(lang, "settings.row.lingua")} — ${currentLangLabel}` },
      { id: "ricorrenti", icon: "🔁", label: t(lang, "settings.row.ricorrenti") },
    ];

    return (
      <div style={{ padding: "20px 16px" }}>
        <div style={{ textAlign: "center", padding: "20px 0 24px" }}>
          <div style={{ fontSize: 20, fontWeight: 700, color: color.textPrimary }}>{householdName}</div>
          <div style={{ fontSize: 11, color: color.textMuted, marginTop: 4 }}>
            {personeLocal.length} {t(lang, "settings.people").toLowerCase()}{createdAtLabel ? ` · ${createdAtLabel}` : ""}
          </div>
        </div>

        <div style={{ background: color.surface, borderRadius: 16, border: `1px solid ${color.border}`, overflow: "hidden", marginBottom: 16 }}>
          {rows.map((row, i) => (
            <div key={row.id} onClick={() => setScreen(row.id)} style={{
              display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", cursor: "pointer",
              borderBottom: i < rows.length - 1 ? `1px solid ${color.border}` : "none",
            }}>
              <span style={{ fontSize: 16 }}>{row.icon}</span>
              <span style={{ flex: 1, fontSize: 13, color: color.textPrimary }}>{row.label}</span>
              {row.badge && <span style={{ fontSize: 11, color: color.warn, fontFamily: moneyFont }}>{row.badge}</span>}
              <span style={{ color: color.textMuted, fontSize: 14 }}>›</span>
            </div>
          ))}
        </div>

        <button onClick={() => setScreen("elimina")} style={{
          width: "100%", padding: "13px", border: `1px solid ${alpha(color.negative, 0.4)}`, borderRadius: 12,
          background: alpha(color.negative, 0.1), color: color.negative, fontFamily: displayFont,
          fontSize: 13, fontWeight: 700, cursor: "pointer",
        }}>
          {t(lang, "settings.deleteAccount")}
        </button>
      </div>
    );
  }

  // ─── Persone ───
  if (screen === "persone") return (
    <div style={{ padding: "20px 16px" }}>
      <SubHeader title={t(lang, "settings.people")} onBack={back} />
      {householdId && (
        <div style={{ fontSize: 11, color: color.textMuted, fontFamily: moneyFont, fontVariantNumeric: "tabular-nums", marginBottom: 16 }}>ID: {householdId}</div>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {personeLocal.map(p => (
          <div key={p.id} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, background: color.border, borderRadius: 20, padding: "6px 6px 6px 12px" }}>
              <span style={{ fontSize: 18 }}>{p.emoji}</span>
              <span style={{ fontSize: 13, color: color.textSecondary, fontWeight: 600 }}>{p.nome}</span>
              {editingRuoloId === p.id ? (
                <select
                  autoFocus
                  disabled={ruoloBusy}
                  value={p.ruolo || "member"}
                  onChange={e => handleRuoloChange(p.id, e.target.value)}
                  onBlur={() => setEditingRuoloId(null)}
                  style={{ background: color.bg, border: `1px solid ${color.accent}`, borderRadius: 8, color: color.textPrimary, fontSize: 11, padding: "3px 6px", colorScheme: "dark" }}
                >
                  {HOUSEHOLD_ROLES.map(r => <option key={r} value={r}>{t(lang, `settings.role.${r}`)}</option>)}
                </select>
              ) : (
                <button
                  onClick={() => setEditingRuoloId(p.id)}
                  title={t(lang, "settings.roleNotEnforcedHint")}
                  style={{ background: color.bg, border: `1px solid ${color.border}`, borderRadius: 8, color: color.textMuted, fontSize: 10, fontWeight: 700, padding: "3px 8px", cursor: "pointer", textTransform: "uppercase", letterSpacing: 0.3 }}
                >
                  {t(lang, `settings.role.${p.ruolo || "member"}`)}
                </button>
              )}
              <button
                onClick={() => editingCredId === p.id ? setEditingCredId(null) : startEditCred(p)}
                title={p.hasCredential ? t(lang, "settings.credentialChange") : t(lang, "settings.credentialSet")}
                style={{ background: "none", border: "none", color: p.hasCredential ? color.positive : color.textMuted, cursor: "pointer", fontSize: 13, padding: "3px 4px" }}
              >
                {p.hasCredential ? "🔐" : "🔓"}
              </button>
              {isOwnerSession && p.id !== activePersonaId && (
                <button
                  onClick={() => handleRemovePersona(p)}
                  disabled={removeBusyId === p.id}
                  title={t(lang, "confirm.removePersonaPrefix")}
                  style={{ background: "none", border: "none", color: color.negative, cursor: "pointer", fontSize: 13, padding: "3px 4px", opacity: removeBusyId === p.id ? 0.5 : 1 }}
                >✕</button>
              )}
            </div>

            {editingCredId === p.id && (
              <div style={{ background: color.bg, border: `1px solid ${alpha(color.accent, 0.2)}`, borderRadius: 12, padding: 10, minWidth: 220 }}>
                <div style={{ fontSize: 10, color: color.accent, marginBottom: 6 }}>
                  {p.hasCredential ? t(lang, "settings.credentialChange") : t(lang, "settings.credentialSet")} — {p.nome}
                </div>
                {p.hasCredential && (
                  <input
                    type="password" placeholder={t(lang, "settings.credentialCurrent")}
                    value={credCurrentInput} onChange={e => setCredCurrentInput(e.target.value)}
                    style={{ ...inputStyle, marginBottom: 6, fontSize: 12, padding: "6px 8px", background: color.surface }}
                  />
                )}
                <input
                  type="password" placeholder={t(lang, "settings.credentialNew")} autoFocus={!p.hasCredential}
                  value={credNewInput} onChange={e => setCredNewInput(e.target.value)}
                  style={{ ...inputStyle, marginBottom: 6, fontSize: 12, padding: "6px 8px", background: color.surface }}
                />
                <input
                  type="email" placeholder={t(lang, "settings.credentialEmail")}
                  value={credEmailInput} onChange={e => setCredEmailInput(e.target.value)}
                  style={{ ...inputStyle, marginBottom: 4, fontSize: 12, padding: "6px 8px", background: color.surface }}
                />
                <div style={{ fontSize: 9, color: color.textMuted, marginBottom: 8 }}>{t(lang, "settings.credentialEmailHint")}</div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button
                    disabled={credBusy || credNewInput.length < 8}
                    onClick={() => handleCredSave(p)}
                    style={{ flex: 1, padding: "6px", background: color.accent, border: "none", borderRadius: 8, color: "#fff", fontSize: 11, fontWeight: 700, cursor: "pointer", opacity: credNewInput.length < 8 ? 0.5 : 1 }}
                  >{t(lang, "common.save")}</button>
                  {p.hasCredential && (
                    <button
                      disabled={credBusy}
                      onClick={() => handleCredRemove(p.id)}
                      style={{ padding: "6px 10px", background: "none", border: `1px solid ${alpha(color.negative, 0.27)}`, borderRadius: 8, color: color.negative, fontSize: 11, cursor: "pointer" }}
                    >{t(lang, "settings.credentialRemove")}</button>
                  )}
                  <button onClick={() => setEditingCredId(null)} style={{ padding: "6px 10px", background: "none", border: `1px solid ${color.border}`, borderRadius: 8, color: color.textMuted, fontSize: 11, cursor: "pointer" }}>✕</button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 6, marginTop: 12 }}>
        <input
          value={addNomeInput}
          onChange={e => setAddNomeInput(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") handleAddPersona(); }}
          placeholder={t(lang, "settings.addPersonaPlaceholder")}
          style={{ ...inputStyle, flex: 1, fontSize: 12, padding: "6px 10px", background: color.bg }}
        />
        <button
          disabled={addBusy || !addNomeInput.trim()}
          onClick={handleAddPersona}
          style={{ padding: "6px 12px", background: color.accent, border: "none", borderRadius: 8, color: "#fff", fontSize: 11, fontWeight: 700, cursor: "pointer", opacity: (addBusy || !addNomeInput.trim()) ? 0.5 : 1, whiteSpace: "nowrap" }}
        >{t(lang, "settings.addPersona")}</button>
      </div>
      <div style={{ fontSize: 10, color: color.textMuted, marginTop: 8 }}>{t(lang, "settings.roleNotEnforcedHint")}</div>
    </div>
  );

  // ─── Categorie ───
  if (screen === "categorie") return (
    <div style={{ padding: "20px 16px" }}>
      <SubHeader title={t(lang, "settings.row.categorie")} onBack={back} />
      {categorie.map(c => (
        <div key={c.id}>
          {editingCatId === c.id ? (
            <div style={{ padding: "10px 0", borderBottom: `1px solid ${color.border}` }}>
              <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
                <input value={editForm.emoji || c.emoji} onChange={e => setEditForm(f => ({ ...f, emoji: e.target.value }))}
                  style={{ ...inputStyle, width: 52, textAlign: "center", fontSize: 18, padding: "8px 4px" }} />
                <input value={editForm.nome ?? c.nome} onChange={e => setEditForm(f => ({ ...f, nome: e.target.value }))}
                  placeholder={t(lang, "viaggi.categoryNamePlaceholder")} style={{ ...inputStyle, flex: 1, padding: "8px 10px" }} />
                <input type="color" value={editForm.colore || c.colore} onChange={e => setEditForm(f => ({ ...f, colore: e.target.value }))}
                  style={{ width: 36, height: 36, border: "none", background: "none", cursor: "pointer", padding: 2 }} />
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => setEditingCatId(null)} style={{ flex: 1, padding: "8px", border: `1px solid ${color.border}`, borderRadius: 10, background: "transparent", color: color.textMuted, fontSize: 12, cursor: "pointer", fontFamily: displayFont }}>{t(lang, "common.cancel")}</button>
                <button onClick={() => handleSaveEdit(c.id)} style={{ flex: 1, padding: "8px", border: "none", borderRadius: 10, background: color.accent, color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: displayFont }}>{t(lang, "common.save")}</button>
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0", borderBottom: `1px solid ${color.border}` }}>
              <span style={{ fontSize: 20 }}>{c.emoji}</span>
              <div style={{ width: 10, height: 10, borderRadius: "50%", background: c.colore, flexShrink: 0 }} />
              <span style={{ flex: 1, fontSize: 14, color: color.textSecondary, fontWeight: 600 }}>{c.nome}</span>
              <button onClick={() => { setEditingCatId(c.id); setEditForm({}); }} style={{ padding: "5px 8px", border: `1px solid ${color.border}`, borderRadius: 8, background: "transparent", color: color.textMuted, fontSize: 11, cursor: "pointer" }}>{t(lang, "common.edit")}</button>
              {categorie.length > 1 && (
                <button onClick={() => handleDeleteCat(c.id)} style={{ padding: "5px 8px", border: `1px solid ${alpha(color.negative, 0.2)}`, borderRadius: 8, background: "transparent", color: color.negative, fontSize: 11, cursor: "pointer" }}>{t(lang, "common.delete")}</button>
              )}
            </div>
          )}
        </div>
      ))}
      {showNewCat ? (
        <div style={{ paddingTop: 12 }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
            <input value={newCat.emoji} onChange={e => setNewCat(n => ({ ...n, emoji: e.target.value }))}
              style={{ ...inputStyle, width: 52, textAlign: "center", fontSize: 18, padding: "8px 4px" }} />
            <input value={newCat.nome} onChange={e => setNewCat(n => ({ ...n, nome: e.target.value }))}
              placeholder={t(lang, "viaggi.categoryNamePlaceholder")} style={{ ...inputStyle, flex: 1, padding: "8px 10px" }} autoFocus />
            <input type="color" value={newCat.colore} onChange={e => setNewCat(n => ({ ...n, colore: e.target.value }))}
              style={{ width: 36, height: 36, border: "none", background: "none", cursor: "pointer", padding: 2 }} />
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => { setShowNewCat(false); setNewCat({ emoji: "📦", nome: "", colore: "#A8A8A8" }); }} style={{ flex: 1, padding: "8px", border: `1px solid ${color.border}`, borderRadius: 10, background: "transparent", color: color.textMuted, fontSize: 12, cursor: "pointer", fontFamily: displayFont }}>{t(lang, "common.cancel")}</button>
            <button onClick={handleAddCat} disabled={!newCat.nome.trim()} style={{ flex: 1, padding: "8px", border: "none", borderRadius: 10, background: newCat.nome.trim() ? color.accent : color.border, color: newCat.nome.trim() ? "#fff" : color.textMuted, fontSize: 12, fontWeight: 700, cursor: newCat.nome.trim() ? "pointer" : "default", fontFamily: displayFont }}>{t(lang, "common.add")}</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setShowNewCat(true)} style={{ marginTop: 12, width: "100%", padding: "10px", border: `1px dashed ${color.borderStrong}`, borderRadius: 10, background: "transparent", color: color.textMuted, fontSize: 13, cursor: "pointer", fontFamily: displayFont }}>
          {t(lang, "settings.newCategory")}
        </button>
      )}
    </div>
  );

  // ─── Conti ───
  if (screen === "conti") return (
    <div style={{ padding: "20px 16px" }}>
      <SubHeader title={t(lang, "settings.row.conti")} onBack={back} />
      <ContiCard conti={conti} transazioni={transazioni} goals={goals} onAdd={onAddConto} onUpdate={onUpdateConto} onDelete={onDeleteConto} valutaBase={valutaBase} lang={lang} />
    </div>
  );

  // ─── Cestino ───
  if (screen === "cestino") return (
    <div style={{ padding: "20px 16px" }}>
      <SubHeader title={t(lang, "settings.row.cestino")} onBack={back} />
      <div style={{ fontSize: 11, color: color.textMuted, marginBottom: 12, lineHeight: 1.5 }}>
        {t(lang, "settings.trashHint")}
      </div>
      {cestinoLoading ? (
        <div style={{ textAlign: "center", color: color.textMuted, fontSize: 12, padding: 12 }}>{t(lang, "common.loading")}</div>
      ) : cestino.length === 0 ? (
        <div style={{ textAlign: "center", color: color.textMuted, fontSize: 12, padding: 12 }}>{t(lang, "settings.trashEmpty")}</div>
      ) : (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
            {cestino.map(item => {
              const cat = categorie.find(c => c.id === item.categoria);
              const busy = cestinoBusyId === item.id;
              return (
                <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 10, background: color.surface, borderRadius: 12, padding: "10px 12px", opacity: busy ? 0.5 : 1 }}>
                  <span style={{ fontSize: 18, flexShrink: 0 }}>{cat?.emoji || (item.tipo === "entrata" ? "💰" : "📦")}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: color.textSecondary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {item.descrizione || cat?.nome || item.categoria}
                    </div>
                    <div style={{ fontSize: 10, color: color.textMuted }}>
                      {formattaValuta(item.importo)} · {giorniRimanenti(item.deletedAt)}{t(lang, "stats.daysLeft")}
                    </div>
                  </div>
                  <button disabled={busy} onClick={() => handleRestore(item.id)} style={{ background: `${alpha(color.accent, 0.13)}`, border: `1px solid ${color.accent}`, borderRadius: 8, color: color.accent, fontSize: 11, fontWeight: 700, padding: "6px 10px", cursor: busy ? "default" : "pointer" }}>{t(lang, "common.restore")}</button>
                  <button disabled={busy} onClick={() => handlePermanentDelete(item.id)} style={{ background: "none", border: "none", color: `${alpha(color.negative, 0.53)}`, fontSize: 16, cursor: busy ? "default" : "pointer", padding: "0 2px" }}>✕</button>
                </div>
              );
            })}
          </div>
          <button onClick={handleEmptyCestino} style={{ width: "100%", padding: "10px", border: `1px solid ${alpha(color.negative, 0.2)}`, borderRadius: 10, background: "transparent", color: color.negative, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: displayFont }}>
            {t(lang, "settings.emptyTrash")}
          </button>
        </>
      )}
    </div>
  );

  // ─── Widget ───
  if (screen === "widget") return (
    <div style={{ padding: "20px 16px" }}>
      <SubHeader title={t(lang, "settings.row.widget")} onBack={back} />
      <div style={{ fontSize: 12, color: color.textMuted, lineHeight: 1.5, marginBottom: 12 }}>
        {t(lang, "settings.widgetHint")}
      </div>
      {widgetUrl ? (
        <div>
          <div style={{ fontSize: 10, color: color.warn, marginBottom: 6 }}>{t(lang, "settings.widgetCopyNow")}</div>
          <div onClick={() => { navigator.clipboard?.writeText(widgetUrl); toast(t(lang, "toast.urlCopied"), "success"); }} style={{
            background: color.surface, border: `1px solid ${alpha(color.positive, 0.33)}`, borderRadius: 10, padding: "10px 12px",
            fontSize: 10, fontFamily: moneyFont, color: color.positive, wordBreak: "break-all", cursor: "pointer", marginBottom: 10,
          }}>{widgetUrl}</div>
          <button onClick={() => { navigator.clipboard?.writeText(widgetUrl); toast(t(lang, "toast.urlCopied"), "success"); }} style={{
            width: "100%", padding: "10px", background: `${alpha(color.positive, 0.13)}`, border: `1px solid ${alpha(color.positive, 0.33)}`, borderRadius: 10,
            color: color.positive, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: displayFont, marginBottom: 8,
          }}>{t(lang, "settings.copyUrl")}</button>
        </div>
      ) : (
        <button onClick={handleCreateWidgetKey} disabled={widgetBusy} style={{
          width: "100%", padding: "12px", background: `${alpha(color.accent, 0.13)}`, border: `1px solid ${color.accent}`, borderRadius: 10,
          color: color.accent, fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: displayFont, marginBottom: 8, opacity: widgetBusy ? 0.6 : 1,
        }}>{widgetBusy ? t(lang, "settings.generatingKey") : t(lang, "settings.generateWidgetKey")}</button>
      )}
      <button onClick={handleRevokeWidgetKey} disabled={widgetBusy} style={{
        width: "100%", padding: "10px", background: "none", border: `1px solid ${alpha(color.negative, 0.2)}`, borderRadius: 10,
        color: `${alpha(color.negative, 0.6)}`, fontSize: 12, cursor: "pointer", fontFamily: displayFont,
      }}>{t(lang, "settings.revokeExistingKey")}</button>
      <div style={{ fontSize: 10, color: color.textMuted, marginTop: 8 }}>
        {t(lang, "settings.widgetRegenerateHint")}
      </div>
    </div>
  );

  // ─── Calendario ───
  if (screen === "calendario") return (
    <div style={{ padding: "20px 16px" }}>
      <SubHeader title={t(lang, "settings.row.calendario")} onBack={back} />
      <div style={{ fontSize: 12, color: color.textMuted, lineHeight: 1.5, marginBottom: 12 }}>
        {t(lang, "settings.calendarHint")}
      </div>
      {calendarUrl ? (
        <div>
          <div onClick={() => { navigator.clipboard?.writeText(calendarUrl); toast(t(lang, "toast.urlCopied"), "success"); }} style={{
            background: color.surface, border: `1px solid ${alpha(color.positive, 0.33)}`, borderRadius: 10, padding: "10px 12px",
            fontSize: 10, fontFamily: moneyFont, color: color.positive, wordBreak: "break-all", cursor: "pointer", marginBottom: 10,
          }}>{calendarUrl}</div>
          <button onClick={() => { navigator.clipboard?.writeText(calendarUrl); toast(t(lang, "toast.urlCopied"), "success"); }} style={{
            width: "100%", padding: "10px", background: `${alpha(color.positive, 0.13)}`, border: `1px solid ${alpha(color.positive, 0.33)}`, borderRadius: 10,
            color: color.positive, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: displayFont, marginBottom: 8,
          }}>{t(lang, "settings.copyUrl")}</button>
        </div>
      ) : (
        <button onClick={handleCreateCalendarKey} disabled={calendarBusy} style={{
          width: "100%", padding: "12px", background: `${alpha(color.accent, 0.13)}`, border: `1px solid ${color.accent}`, borderRadius: 10,
          color: color.accent, fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: displayFont, marginBottom: 8, opacity: calendarBusy ? 0.6 : 1,
        }}>{calendarBusy ? t(lang, "settings.generatingKey") : t(lang, "settings.generateCalendarKey")}</button>
      )}
      <button onClick={handleRevokeCalendarKey} disabled={calendarBusy} style={{
        width: "100%", padding: "10px", background: "none", border: `1px solid ${alpha(color.negative, 0.2)}`, borderRadius: 10,
        color: `${alpha(color.negative, 0.6)}`, fontSize: 12, cursor: "pointer", fontFamily: displayFont,
      }}>{t(lang, "settings.revokeExistingKey")}</button>
      <div style={{ fontSize: 10, color: color.textMuted, marginTop: 8 }}>
        {t(lang, "settings.calendarSubscribeHint")}
      </div>
    </div>
  );

  // ─── Backup e ripristino ───
  if (screen === "backup") return (
    <div style={{ padding: "20px 16px" }}>
      <SubHeader title={t(lang, "settings.row.backup")} onBack={back} />
      <BackupSection lang={lang} />
    </div>
  );

  // ─── Email di recupero ───
  if (screen === "email") return (
    <div style={{ padding: "20px 16px" }}>
      <SubHeader title={t(lang, "settings.row.email")} onBack={back} />
      {hasRecoveryEmail === null ? (
        <div style={{ fontSize: 12, color: color.textMuted }}>{t(lang, "common.loading")}</div>
      ) : hasRecoveryEmail === "error" ? (
        <>
          <div style={{ fontSize: 12, color: color.warn, marginBottom: 6 }}>{t(lang, "settings.recoveryEmailCheckFailed")}</div>
          {recoveryEmailErrDetail && (
            <div style={{ fontSize: 10, color: color.textMuted, fontFamily: moneyFont, fontVariantNumeric: "tabular-nums", marginBottom: 10, wordBreak: "break-word" }}>{recoveryEmailErrDetail}</div>
          )}
          <button onClick={loadRecoveryEmailStatus} style={{
            padding: "10px 14px", background: `${alpha(color.warn, 0.13)}`, border: `1px solid ${alpha(color.warn, 0.33)}`, borderRadius: 10,
            color: color.warn, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: displayFont,
          }}>{t(lang, "settings.retry")}</button>
        </>
      ) : hasRecoveryEmail && !editingRecoveryEmail ? (
        <>
          <div style={{ fontSize: 12, color: color.positive, marginBottom: 10 }}>{t(lang, "settings.recoveryEmailSetHint")}</div>
          <button onClick={() => setEditingRecoveryEmail(true)} style={{
            padding: "10px 14px", background: "none", border: `1px solid ${color.border}`, borderRadius: 10,
            color: color.textMuted, fontSize: 12, cursor: "pointer", fontFamily: displayFont,
          }}>{t(lang, "settings.changeEmail")}</button>
        </>
      ) : (
        <>
          <div style={{ fontSize: 12, color: color.textMuted, lineHeight: 1.5, marginBottom: 12 }}>
            {hasRecoveryEmail ? t(lang, "settings.enterNewRecoveryEmail") : t(lang, "settings.recoveryEmailMissingHint")}
          </div>
          <input type="email" inputMode="email" value={recoveryEmailInput} onChange={e => setRecoveryEmailInput(e.target.value)}
            placeholder="tuaemail@esempio.com" style={{
              width: "100%", boxSizing: "border-box", padding: "10px 12px", background: color.bg, border: `1px solid ${color.border}`,
              borderRadius: 10, color: color.textPrimary, fontSize: 14, fontFamily: displayFont, outline: "none", marginBottom: 10,
            }} />
          <div style={{ display: "flex", gap: 8 }}>
            {editingRecoveryEmail && (
              <button onClick={() => { setEditingRecoveryEmail(false); setRecoveryEmailInput(""); }} style={{
                padding: "10px 14px", background: "none", border: `1px solid ${color.border}`, borderRadius: 10, color: color.textMuted, fontSize: 13, cursor: "pointer",
              }}>{t(lang, "common.cancel")}</button>
            )}
            <button onClick={handleSaveRecoveryEmail} disabled={recoveryEmailBusy} style={{
              flex: 1, padding: "10px", background: recoveryEmailInput.trim() ? accentGradient : color.border,
              border: "none", borderRadius: 10, color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer",
              fontFamily: displayFont, opacity: recoveryEmailBusy ? 0.6 : 1,
            }}>{recoveryEmailBusy ? t(lang, "settings.savingEmail") : t(lang, "settings.saveEmail")}</button>
          </div>
        </>
      )}
    </div>
  );

  // ─── Valuta ───
  if (screen === "valuta") return (
    <div style={{ padding: "20px 16px" }}>
      <SubHeader title={t(lang, "settings.row.valuta")} onBack={back} />
      <div style={{ fontSize: 12, color: color.textMuted, marginBottom: 10, lineHeight: 1.5 }}>
        {t(lang, "settings.currencyHint")}
      </div>
      <select value={valutaBase} disabled={valutaBusy} onChange={e => handleValutaBaseChange(e.target.value)} style={{
        width: "100%", padding: "10px 12px", background: color.bg, border: `1px solid ${color.border}`, borderRadius: 10,
        color: color.textPrimary, fontSize: 14, fontWeight: 600, cursor: valutaBusy ? "default" : "pointer",
      }}>
        {valuteDisponibili.map(v => <option key={v} value={v}>{v}</option>)}
      </select>
    </div>
  );

  // ─── Lingua ───
  if (screen === "lingua") return (
    <div style={{ padding: "20px 16px" }}>
      <SubHeader title={t(lang, "settings.row.lingua")} onBack={back} />
      <select value={lang} onChange={e => onLangChange?.(e.target.value)} style={{
        width: "100%", padding: "10px 12px", background: color.bg, border: `1px solid ${color.border}`, borderRadius: 10,
        color: color.textPrimary, fontSize: 14, fontWeight: 600, cursor: "pointer",
      }}>
        {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
      </select>
    </div>
  );

  // ─── Transazioni ricorrenti ───
  if (screen === "ricorrenti") return (
    <div style={{ padding: "20px 16px" }}>
      <SubHeader title={t(lang, "settings.row.ricorrenti")} onBack={back} />
      <RecurringManagerSection
        transazioni={transazioni}
        categorie={categorie}
        onEdit={onEditTransazione}
        onDelete={onDeleteTransazione}
        lang={lang}
      />
    </div>
  );

  // ─── Elimina il gruppo (multi-step confirm, unchanged logic) ───
  return (
    <div style={{ padding: "20px 16px" }}>
      <SubHeader title={t(lang, "settings.dangerZone")} onBack={fase === "idle" ? back : () => setFase("idle")} />

      {fase === "confirm" && (
        <div>
          <div style={{ fontSize: 13, color: color.warn, marginBottom: 14, textAlign: "center", lineHeight: 1.5 }}>
            {t(lang, "settings.confirmDeleteWarningPrefix")} <strong style={{ color: color.textPrimary }}>{householdName}</strong>. {t(lang, "settings.confirmDeleteWarningSuffix")}
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button onClick={back} style={{
              flex: 1, padding: "12px", border: `1px solid ${color.border}`, borderRadius: 12,
              background: "transparent", color: color.textMuted, fontFamily: displayFont,
              fontSize: 14, fontWeight: 600, cursor: "pointer",
            }}>{t(lang, "common.cancel")}</button>
            <button onClick={() => setFase("pin")} style={{
              flex: 1, padding: "12px", border: "none", borderRadius: 12,
              background: `${alpha(color.negative, 0.13)}`, color: color.negative, fontFamily: displayFont,
              fontSize: 14, fontWeight: 700, cursor: "pointer",
            }}>{t(lang, "common.continue")}</button>
          </div>
        </div>
      )}

      {(fase === "pin" || fase === "deleting") && (
        <div>
          <div style={{ fontSize: 13, color: color.textSecondary, marginBottom: 10, textAlign: "center" }}>
            {t(lang, "settings.enterPinToConfirmDelete")}
          </div>
          <input
            type="password" inputMode="numeric" maxLength={8}
            value={pin} onChange={e => { setPin(e.target.value.replace(/\D/g, "")); setErrore(""); }}
            onKeyDown={e => e.key === "Enter" && eseguiElimina()}
            placeholder="••••"
            autoFocus
            style={{
              ...inputStyle, fontSize: 28, fontWeight: 800,
              fontFamily: moneyFont, fontVariantNumeric: "tabular-nums", textAlign: "center",
              letterSpacing: 10, marginBottom: 10,
              borderColor: errore ? color.negative : color.border,
            }}
          />
          {errore && <div style={{ color: color.negative, fontSize: 12, textAlign: "center", marginBottom: 10 }}>{errore}</div>}
          <div style={{ display: "flex", gap: 10 }}>
            <button onClick={() => { setFase("idle"); setPin(""); setErrore(""); back(); }} style={{
              flex: 1, padding: "12px", border: `1px solid ${color.border}`, borderRadius: 12,
              background: "transparent", color: color.textMuted, fontFamily: displayFont,
              fontSize: 14, fontWeight: 600, cursor: "pointer",
            }}>{t(lang, "common.cancel")}</button>
            <button onClick={eseguiElimina} disabled={pin.length < 4 || fase === "deleting"} style={{
              flex: 1, padding: "12px", border: "none", borderRadius: 12,
              background: pin.length >= 4 ? color.negative : color.border,
              color: pin.length >= 4 ? "#fff" : color.textMuted,
              fontFamily: displayFont, fontSize: 14, fontWeight: 700,
              cursor: pin.length >= 4 ? "pointer" : "default",
              opacity: fase === "deleting" ? 0.6 : 1,
            }}>
              {fase === "deleting" ? t(lang, "settings.deletingAccountShort") : t(lang, "common.delete")}
            </button>
          </div>
        </div>
      )}

      {fase === "done" && (
        <div style={{ textAlign: "center", padding: "10px 0" }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>🗑️</div>
          <div style={{ color: color.positive, fontWeight: 700 }}>Account eliminato</div>
        </div>
      )}
    </div>
  );
}
