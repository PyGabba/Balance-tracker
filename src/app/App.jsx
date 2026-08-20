import { useState, useEffect, useCallback, useRef } from "react";
import { App as CapApp } from "@capacitor/app";
import { fetchTransactions, addTransaction, deleteTransaction, updateTransaction, isAPIConnected, logout, isLoggedIn, getSession, getPersone, getHouseholdName, fetchPositions, addPosition, fetchManualPrices, wakeupServer, getCategorieUscita, fetchCategorie, saveCategorie, setAuthErrorHandler, fetchGoals, addGoal, updateGoal, deleteGoal, fetchAccounts, addAccount, updateAccount, deleteAccount, fetchHousehold, getActivePersonaId } from "../api.js";
import { PersonaSwitcher } from "../features/auth/PersonaSwitcher.jsx";
import { getLang, setLang, t, detectGuestLang } from "../lib/i18n.js";
import { toast, ToastHost } from "../components/Toast.jsx";
import { SyncStatusBadge } from "../components/SyncStatusBadge.jsx";
import { setImportiNascosti as setImportiNascostiFormat } from "../lib/format.js";
import { defaultCategorie, generaId } from "../lib/appHelpers.js";
import { AggiungiView } from "../features/transactions/AggiungiView.jsx";
import { findDueRecurring, buildRecurringOccurrence } from "../services/recurringService.js";
import { computeAutoContributions } from "../services/goalsService.js";
import { LoginScreen } from "../features/auth/LoginScreen.jsx";
import { ViaggiView } from "../features/trips/ViaggiView.jsx";
import { TripGuestView } from "../features/trips/TripGuestView.jsx";
import { PortfolioView } from "../features/portfolio/PortfolioView.jsx";
import { MonthBar } from "../components/ui/MonthBar.jsx";
import { PullToRefresh } from "../components/PullToRefresh.jsx";
import { StatsView } from "../features/statistics/StatsView.jsx";
import { ExportView } from "../features/settings/ExportView.jsx";
import { ImpostazioniView } from "../features/settings/ImpostazioniView.jsx";
import { TabBar } from "./TabBar.jsx";
import { HomeView } from "./HomeView.jsx";

// PERSONE is now dynamic — loaded from session after login
// Fallback for offline/localStorage mode
const DEFAULT_PERSONE = [
  { id: "persona1", nome: "Persona 1", emoji: "👤", colore: "#E84393" },
  { id: "persona2", nome: "Persona 2", emoji: "👤", colore: "#0984E3" },
];

// ─── Main App ───
export default function FinanzaApp() {
  const [authed, setAuthed] = useState(isLoggedIn() && !getSession()?.requiresPinChange);
  // MOD-025 Stage 1 UI: which persona (if any) this session has logged in
  // as on top of the household PIN — purely a display convenience, the
  // server's JWT is the only real source of truth for this.
  const [activePersonaId, setActivePersonaId] = useState(getActivePersonaId());
  const urlParams = new URLSearchParams(window.location.search);
  // Reload (including pull-to-refresh, which is a real window.location.reload())
  // used to always drop back to "home" — a full reload remounts everything,
  // and useState's initial value only ever ran once, on the FIRST-ever
  // mount. Persisting the last tab in sessionStorage (cleared when the tab
  // itself closes, so a fresh app open still starts at home) lets init read
  // it back. An explicit Shortcuts deep link (?action=add) still wins.
  const LAST_TAB_KEY = "finanza-last-tab";
  const VALID_TABS = ["home", "aggiungi", "portfolio", "viaggi", "stats", "export", "impostazioni"];
  const [tab, setTabState] = useState(() => {
    if (urlParams.get("action") === "add") return "aggiungi";
    const saved = sessionStorage.getItem(LAST_TAB_KEY);
    return VALID_TABS.includes(saved) ? saved : "home";
  });
  const setTab = (next) => {
    setTabState(next);
    try { sessionStorage.setItem(LAST_TAB_KEY, next); } catch {}
  };
  const [initialTipo, setInitialTipo] = useState(urlParams.get("tipo") || "uscita");
  const [initialImporto, setInitialImporto] = useState(urlParams.get("importo") || "");
  const [initialDescrizione, setInitialDescrizione] = useState(urlParams.get("descrizione") || "");
  const [initialCategoria, setInitialCategoria] = useState(urlParams.get("categoria") || "");
  const [initialPagatoDa, setInitialPagatoDa] = useState(urlParams.get("pagatoDa") || "");
  const [shortcutKey, setShortcutKey] = useState(0);
  const [transazioni, setTransazioni] = useState([]);
  const [goals, setGoals] = useState([]);
  const [positions, setPositions] = useState([]);
  const [meseOffset, setMeseOffset] = useState(0);
  const [categorieUscita, setCategorieUscita] = useState(() => getCategorieUscita() || defaultCategorie(getLang()).filter(c => c.id !== "entrata"));
  const [valutaBase, setValutaBase] = useState("EUR");
  const [lang, setLangState] = useState(getLang());
  function handleLangChange(l) { setLang(l); setLangState(l); }

  useEffect(() => { fetchHousehold().then(h => setValutaBase(h.valutaBase || "EUR")).catch(() => {}); }, []);

  // Warm up Render server on app open (fire and forget)
  useEffect(() => { wakeupServer(); }, []);

  // Any 401/403 from the server forces re-auth — catches PIN_CHANGE_REQUIRED state mismatch
  // (old cached session bypasses frontend check but server still enforces it)
  useEffect(() => {
    setAuthErrorHandler(() => setAuthed(false));
    return () => setAuthErrorHandler(null);
  }, []);

  // Shared deep-link handler — used by both URL params and webapp:// scheme.
  // Shortcut: webapp://?action=add&tipo=uscita&importo=12.50&descrizione=Merchant&categoria=cibo&pagatoDa=Gabriele
  const applyDeepLink = useCallback((queryString) => {
    const p = new URLSearchParams(queryString);
    if (p.get("action") !== "add") return false;
    setInitialTipo(p.get("tipo") || "uscita");
    setInitialImporto(p.get("importo") || "");
    setInitialDescrizione(p.get("descrizione") || "");
    setInitialCategoria(p.get("categoria") || "");
    setInitialPagatoDa(p.get("pagatoDa") || "");
    setShortcutKey(k => k + 1);
    setTab("aggiungi");
    return true;
  }, []);

  // webapp:// scheme — fires when Capacitor app is opened via custom URL scheme.
  useEffect(() => {
    let listener;
    CapApp.addListener("appUrlOpen", (event) => {
      const qs = event.url.includes("?") ? event.url.split("?")[1] : "";
      applyDeepLink(qs);
    }).then(l => { listener = l; }).catch(() => {});
    return () => { listener?.remove(); };
  }, [applyDeepLink]);

  // https:// URL params — works on web/PWA and on fresh Capacitor load.
  useEffect(() => {
    function checkUrlParams() {
      const qs = window.location.search.slice(1);
      if (!qs) return;
      if (applyDeepLink(qs)) window.history.replaceState({}, "", window.location.pathname);
    }
    checkUrlParams();
    const handleVisibility = () => { if (document.visibilityState === "visible") checkUrlParams(); };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [applyDeepLink]);

  const persone = getPersone().length > 0 ? getPersone() : DEFAULT_PERSONE;
  const householdName = getHouseholdName();

  // ─── Auto-generate due recurring transactions ───
  // Which templates are due and what their next occurrence looks like is
  // decided by services/recurringService.js (pure, tested in isolation);
  // this callback only owns persistence (addTransaction/updateTransaction)
  // and merging the result into UI state.
  const generaRicorrenti = useCallback(async (txList) => {
    const dovute = findDueRecurring(txList);
    if (dovute.length === 0) return;
    const nuove = [];
    for (const t of dovute) {
      const { nuovaTx, updatedRicorrenza } = buildRecurringOccurrence(t, generaId);
      try {
        const saved = await addTransaction(nuovaTx);
        nuove.push(saved);
        // Advance the template's prossimaData so it doesn't fire again this period
        await updateTransaction(t.id, { ricorrenza: updatedRicorrenza });
        setTransazioni(prev => prev.map(tx => tx.id === t.id ? { ...tx, ricorrenza: updatedRicorrenza } : tx));
      } catch (e) { console.error("Ricorrente error:", e); }
    }
    if (nuove.length > 0) {
      setTransazioni(prev => [...prev, ...nuove]);
    }
  }, []);

  const loadAll = useCallback(async () => {
    try {
      const localData = await fetchTransactions((serverData) => {
        setTransazioni(serverData);
        // generaRicorrenti already ran on localData below; skip here to avoid race duplicates
      });
      setTransazioni(localData);
      generaRicorrenti(localData);
    } catch (err) {
      if (err.message === "Sessione scaduta") { setAuthed(false); return; }
      console.error("Load error:", err);
    }
  }, [generaRicorrenti]);

  const loadPositions = useCallback(async () => {
    try {
      const data = await fetchPositions();
      setPositions(data);
    } catch (e) { console.error("loadPositions:", e); }
  }, []);

  const loadGoals = useCallback(async () => {
    try {
      const data = await fetchGoals();
      setGoals(data || []);
    } catch (e) { console.error("loadGoals:", e); }
  }, []);

  const handleAddGoal = async (goal) => {
    const saved = await addGoal(goal);
    setGoals(prev => [...prev, saved]);
  };

  const handleUpdateGoal = async (id, updates) => {
    await updateGoal(id, updates);
    setGoals(prev => prev.map(g => g.id === id ? { ...g, ...updates } : g));
  };

  const handleDeleteGoal = async (id) => {
    await deleteGoal(id);
    setGoals(prev => prev.filter(g => g.id !== id));
  };

  const [nascondiImporti, setNascondiImporti] = useState(() => {
    try { return localStorage.getItem("nascondiImporti") === "1"; } catch { return false; }
  });
  setImportiNascostiFormat(nascondiImporti); // sync module flag on every render
  const toggleNascondiImporti = () => {
    setNascondiImporti(v => {
      try { localStorage.setItem("nascondiImporti", v ? "0" : "1"); } catch {}
      return !v;
    });
  };

  const [rootManualPrices, setRootManualPrices] = useState({});
  const loadRootManualPrices = useCallback(async () => {
    try { setRootManualPrices(await fetchManualPrices() || {}); } catch (e) { console.error("loadManualPrices:", e); }
  }, []);

  const [conti, setConti] = useState([]);
  const loadConti = useCallback(async () => {
    try {
      const data = await fetchAccounts();
      setConti(data || []);
    } catch (e) { console.error("loadConti:", e); }
  }, []);

  const handleAddConto = async (conto) => {
    const saved = await addAccount(conto);
    setConti(prev => [...prev, saved]);
  };

  const handleUpdateConto = async (id, updates) => {
    await updateAccount(id, updates);
    setConti(prev => prev.map(c => c.id === id ? { ...c, ...updates } : c));
  };

  const handleDeleteConto = async (id) => {
    await deleteAccount(id);
    setConti(prev => prev.filter(c => c.id !== id));
    // Detach locally too, mirroring the server behaviour
    setTransazioni(prev => prev.map(t => t.contoId === id ? { ...t, contoId: null } : t));
    setGoals(prev => prev.map(g => g.contoId === id ? { ...g, contoId: null } : g));
  };

  const loadCategorie = useCallback(async () => {
    const defaults = defaultCategorie(lang).filter(c => c.id !== "entrata");
    try {
      const cats = await fetchCategorie();
      setCategorieUscita(cats || defaults);
    } catch (e) { console.error("loadCategorie:", e); setCategorieUscita(defaults); }
  }, [lang]);

  useEffect(() => { if (authed) { loadAll(); loadPositions(); loadCategorie(); loadGoals(); loadConti(); loadRootManualPrices(); } }, [authed, loadAll, loadPositions, loadCategorie, loadGoals, loadConti, loadRootManualPrices]);
  // Keep the Patrimonio card fresh: re-read manual prices when returning to home
  useEffect(() => { if (authed && tab === "home") loadRootManualPrices(); }, [tab, authed, loadRootManualPrices]);

  function handleLogin() {
    setAuthed(true);
    setActivePersonaId(getActivePersonaId()); // password login sets this in api.js's session, but the useState above only read it once at mount
    loadAll();
    loadPositions();
    loadCategorie();
  }
  function handleLogout() {
    logout();
    setAuthed(false);
    setActivePersonaId(null);
    setTransazioni([]);
    setPositions([]);
    setCategorieUscita(defaultCategorie(lang).filter(c => c.id !== "entrata"));
    setTab("home");
  }

  async function aggiungiTransazione(t) {
    try {
      const saved = await addTransaction(t);
      setTransazioni(prev => [...prev, saved]);
      
      // Auto-apply goal contributions on entrata — which goals qualify and by
      // how much is decided by services/goalsService.js (pure, tested in
      // isolation); this block only persists and merges into UI state.
      for (const { goalId, newAmount } of computeAutoContributions(goals, t)) {
        await updateGoal(goalId, { currentAmount: newAmount });
        setGoals(prev => prev.map(goal => goal.id === goalId ? { ...goal, currentAmount: newAmount } : goal));
      }
      
      setTab("home");
    } catch (err) {
      // Server-rejected writes (bad splits, unknown account/participant,
      // exchange-rate unavailable, etc.) used to be swallowed silently here
      // and the transaction quietly saved to local storage instead — the
      // user had no idea it failed. Now surfaced like every other error in
      // the app (see api.js: ApiRequestError vs. genuine network failure).
      console.error("Add error:", err);
      toast(`${t(lang, "toast.errorSavePrefix")} ${err.message}`, "error");
    }
  }

  // Same but without setTab — used by bulk import
  async function aggiungiTransazioneSilente(t) {
    const saved = await addTransaction(t);
    setTransazioni(prev => [...prev, saved]);
    return saved;
  }

  async function aggiungiSaldo(t) {
    try {
      const saved = await addTransaction(t);
      setTransazioni(prev => [...prev, saved]);
    } catch (err) {
      console.error("Saldo error:", err);
      toast(`${t(lang, "toast.errorSavePrefix")} ${err.message}`, "error");
    }
  }

  async function aggiungiPositioneSilente(pos) {
    const saved = await addPosition(pos);
    setPositions(prev => [...prev, saved]);
    return saved;
  }

  async function eliminaTransazione(id) {
    try {
      await deleteTransaction(id);
      setTransazioni(prev => prev.filter(t => t.id !== id));
    } catch (err) {
      console.error("Delete error:", err);
      toast(`${t(lang, "toast.errorDeletePrefix")} ${err.message}`, "error");
    }
  }

  async function modificaTransazione(id, updates) {
    try {
      const updated = await updateTransaction(id, updates);
      setTransazioni(prev => prev.map(t => t.id === id ? { ...t, ...updated } : t));
    } catch (err) {
      console.error("Update error:", err);
      toast(`${t(lang, "toast.errorSavePrefix")} ${err.message}`, "error");
    }
  }

  const viaggioToken = new URLSearchParams(window.location.search).get("viaggio");
  if (viaggioToken) return <TripGuestView token={viaggioToken} />;

  if (!authed) return <LoginScreen onLogin={handleLogin} />;

  const showMonthBar = tab === "home" || tab === "stats";

  return (
    <div style={{ maxWidth: 430, margin: "0 auto", height: "100dvh", background: "#111119", color: "#eee", fontFamily: "'DM Sans', sans-serif", display: "flex", flexDirection: "column", overflow: "hidden", position: "relative" }}>
      <ToastHost />
      {/* Fixed header */}
      <div style={{ padding: "calc(18px + env(safe-area-inset-top, 0px)) 16px 8px", display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: showMonthBar ? "none" : "1px solid #1e1e2e", background: "#111119", flexShrink: 0 }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: -0.5 }}><span style={{ background: "linear-gradient(135deg, #6C5CE7, #a855f7)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>Finanza</span></div>
          <div style={{ fontSize: 10, color: "#555", letterSpacing: 1 }}>{householdName || t(lang, "header.tracker")}</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <SyncStatusBadge lang={lang} />
          <PersonaSwitcher persone={persone} activePersonaId={activePersonaId} onSwitched={setActivePersonaId} lang={lang} />
          <button onClick={toggleNascondiImporti} title={nascondiImporti ? t(lang, "header.showAmounts") : t(lang, "header.hideAmounts")} style={{
            background: nascondiImporti ? "#6C5CE722" : "none", border: nascondiImporti ? "1px solid #6C5CE7" : "1px solid #252538",
            borderRadius: 8, cursor: "pointer", color: nascondiImporti ? "#a78bfa" : "#888",
            fontSize: 14, padding: "4px 8px", display: "flex", alignItems: "center",
          }}>{nascondiImporti ? "🙈" : "👁"}</button>
          <button onClick={() => setTab("impostazioni")} title={t(lang, "header.settings")} style={{
            background: "none", border: "1px solid #252538", borderRadius: 8, cursor: "pointer",
            color: "#888", fontSize: 14, padding: "4px 8px", display: "flex", alignItems: "center",
          }}>⚙</button>
          <button onClick={handleLogout} title={t(lang, "header.logout")} style={{
            background: "none", border: "1px solid #252538", borderRadius: 8, cursor: "pointer",
            color: "#888", fontSize: 12, padding: "4px 8px", display: "flex", alignItems: "center",
            fontFamily: "'DM Sans',sans-serif",
          }}>{t(lang, "header.logout")}</button>
          <div style={{ width: 7, height: 7, borderRadius: "50%", background: isAPIConnected() ? "#4ECDC4" : "#F0A500" }} title={isAPIConnected() ? "MongoDB" : "offline"} />
        </div>
      </div>
      {/* Fixed month selector bar — only for Home and Stats */}
      {showMonthBar && (
        <MonthBar meseOffset={meseOffset} setMeseOffset={setMeseOffset} />
      )}
      {/* Scrollable content — pulling down past the top reloads, replacing
          the old explicit reload button (MOD: pull-to-refresh) */}
      <PullToRefresh onRefresh={() => window.location.reload()} style={{ flex: 1, paddingBottom: "calc(48px + env(safe-area-inset-bottom, 0px))" }}>
        {tab === "home" && <HomeView transazioni={transazioni} onDelete={eliminaTransazione} onEdit={modificaTransazione} onSettle={aggiungiSaldo} persone={persone} meseOffset={meseOffset} categorie={categorieUscita} goals={goals} onAddGoal={handleAddGoal} onUpdateGoal={handleUpdateGoal} onDeleteGoal={handleDeleteGoal} conti={conti} onAddConto={handleAddConto} onUpdateConto={handleUpdateConto} onDeleteConto={handleDeleteConto} positions={positions} manualPrices={rootManualPrices} valutaBase={valutaBase} lang={lang} />}
        {tab === "aggiungi" && <AggiungiView key={shortcutKey} onAggiungi={aggiungiTransazione} persone={persone} transazioni={transazioni} categorie={categorieUscita} initialTipo={initialTipo} initialImporto={initialImporto} initialDescrizione={initialDescrizione} initialCategoria={initialCategoria} initialPagatoDa={initialPagatoDa} conti={conti} valutaBase={valutaBase} lang={lang} />}
        {tab === "stats" && <StatsView transazioni={transazioni} persone={persone} meseOffset={meseOffset} categorie={categorieUscita} goals={goals} valutaBase={valutaBase} activePersonaId={activePersonaId} lang={lang} />}
        {tab === "export" && <ExportView transazioni={transazioni} persone={persone} positions={positions} conti={conti} onImport={aggiungiTransazioneSilente} onImportComplete={loadAll} onImportPosition={aggiungiPositioneSilente} onImportPositionComplete={loadPositions} lang={lang} />}
        {tab === "portfolio" && <PortfolioView lang={lang} />}
        {tab === "viaggi" && <ViaggiView persone={persone} valutaBase={valutaBase} lang={lang} />}
        {tab === "impostazioni" && (
          <ImpostazioniView
            householdName={householdName}
            householdId={getSession()?.householdId}
            persone={persone}
            activePersonaId={activePersonaId}
            onDeleted={() => { logout(); setAuthed(false); setTransazioni([]); setTab("home"); }}
            categorie={categorieUscita}
            onCategorieChange={(cats) => { setCategorieUscita(cats); saveCategorie(cats); }}
            onRestoreTransazione={(tx) => setTransazioni(prev => [...prev, tx])}
            valutaBase={valutaBase}
            onValutaBaseChange={setValutaBase}
            lang={lang}
            onLangChange={handleLangChange}
          />
        )}
      </PullToRefresh>
      <TabBar tab={tab} setTab={setTab} householdId={getSession()?.householdId} lang={lang} />
    </div>
  );
}
