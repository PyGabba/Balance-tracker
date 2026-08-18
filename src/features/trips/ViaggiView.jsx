import { useState, useEffect } from "react";
import { fetchTripCategories, saveTripCategories, fetchTrips, addTrip, deleteTrip, addTripExpense, deleteTripExpense, settleTrip, createTripShareLink, revokeTripShareLink } from "../../api.js";
import { calcolaSettleViaggio } from "../../lib/finance.js";
import { t } from "../../lib/i18n.js";
import { formattaValuta } from "../../lib/format.js";
import { toast } from "../../components/Toast.jsx";
import { inputStyle } from "../../components/ui/styles.js";
import { TripExpenseForm } from "./TripExpenseForm.jsx";

export function ViaggiView({ persone, valutaBase = "EUR", lang = "it" }) {
  const [trips, setTrips] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [selectedTrip, setSelectedTrip] = useState(null);
  const defaultTripCats = [
    { id: "trasporto", emoji: "✈️", nome: t(lang, "tripcat.trasporto"), colore: "#74B9FF" },
    { id: "alloggio", emoji: "🏨", nome: t(lang, "tripcat.alloggio"), colore: "#A29BFE" },
    { id: "cibo", emoji: "🍝", nome: t(lang, "cat.cibo"), colore: "#55EFC4" },
    { id: "attivita", emoji: "🎡", nome: t(lang, "tripcat.attivita"), colore: "#FDCB6E" },
    { id: "shopping", emoji: "🛍️", nome: t(lang, "cat.shopping"), colore: "#FF7675" },
    { id: "altro", emoji: "📦", nome: t(lang, "cat.altro"), colore: "#A8A8A8" },
  ];
  // Categorie sincronizzate sulla casa; localStorage resta come cache/fallback offline
  const [tripCats, setTripCats] = useState(() => {
    try {
      const saved = localStorage.getItem("tripCategories");
      return saved ? JSON.parse(saved) : defaultTripCats;
    } catch { return defaultTripCats; }
  });

  useEffect(() => {
    (async () => {
      const remote = await fetchTripCategories();
      if (remote && remote.length > 0) {
        setTripCats(remote);
        try { localStorage.setItem("tripCategories", JSON.stringify(remote)); } catch {}
      } else {
        // Migrazione one-shot: il server non ha ancora nulla, spingiamo le locali
        try {
          const saved = localStorage.getItem("tripCategories");
          if (saved) await saveTripCategories(JSON.parse(saved));
        } catch {}
      }
    })();
  }, []);

  const [nome, setNome] = useState("");
  const [descrizione, setDescrizione] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [partecipanti, setPartecipanti] = useState([]);
  const [newPersonName, setNewPersonName] = useState("");

  const [settlingTrip, setSettlingTrip] = useState(null);
  const [settleFrom, setSettleFrom] = useState("");
  const [settleTo, setSettleTo] = useState("");
  const [settleAmount, setSettleAmount] = useState("");
  const [expandedExpenses, setExpandedExpenses] = useState({});

  function toggleExpenses(tripId) {
    setExpandedExpenses(prev => ({ ...prev, [tripId]: !prev[tripId] }));
  }

  const [shareBusyId, setShareBusyId] = useState(null);

  async function handleShareTrip(tripId) {
    setShareBusyId(tripId);
    try {
      const token = await createTripShareLink(tripId);
      setTrips(prev => prev.map(t => t.id === tripId ? { ...t, shareToken: token } : t));
      const url = `${window.location.origin}${window.location.pathname}?viaggio=${token}`;
      await navigator.clipboard?.writeText(url).catch(() => {});
      toast(t(lang, "viaggi.linkCopied"), "success");
    } catch (e) { toast(`${t(lang, "toast.errorPrefix")} ${e.message}`, "error"); }
    setShareBusyId(null);
  }

  async function handleRevokeShare(tripId) {
    if (!confirm(t(lang, "viaggi.confirmRevoke"))) return;
    setShareBusyId(tripId);
    try {
      await revokeTripShareLink(tripId);
      setTrips(prev => prev.map(t => t.id === tripId ? { ...t, shareToken: undefined } : t));
      toast(t(lang, "viaggi.linkRevoked"), "success");
    } catch (e) { toast(`${t(lang, "toast.errorPrefix")} ${e.message}`, "error"); }
    setShareBusyId(null);
  }

  function handleCopyShareLink(token) {
    const url = `${window.location.origin}${window.location.pathname}?viaggio=${token}`;
    navigator.clipboard?.writeText(url);
    toast(t(lang, "viaggi.linkCopiedShort"), "success");
  }

  const [showCatManager, setShowCatManager] = useState(false);
  const [editingCatId, setEditingCatId] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [showNewCat, setShowNewCat] = useState(false);
  const [newCat, setNewCat] = useState({ emoji: "📦", nome: "", colore: "#A8A8A8" });

  useEffect(() => { loadTrips(); }, []);

  async function saveTripCats(cats) {
    setTripCats(cats);
    try { localStorage.setItem("tripCategories", JSON.stringify(cats)); } catch {}
    const ok = await saveTripCategories(cats);
    if (!ok) toast(t(lang, "toast.categoriesLocalOnly"), "error");
  }

  async function loadTrips() {
    try { setTrips(await fetchTrips()); } catch (e) { console.error(e); }
    setLoading(false);
  }

  async function handleAddTrip() {
    if (!nome.trim()) return;
    const allPars = [...persone.map(p => ({ id: p.id, nome: p.nome, emoji: p.emoji, colore: p.colore })), ...partecipanti];
    const trip = await addTrip({ nome: nome.trim(), descrizione: descrizione.trim(), startDate, endDate, partecipanti: allPars });
    setTrips([trip, ...trips]);
    setNome(""); setDescrizione(""); setStartDate(""); setEndDate(""); setPartecipanti([]); setShowAdd(false);
  }

  async function handleDeleteTrip(id) {
    if (!confirm(t(lang, "viaggi.confirmDeleteTrip"))) return;
    try {
      await deleteTrip(id);
      setTrips(trips.filter(t => t.id !== id));
    } catch (e) {
      toast(`${t(lang, "toast.errorDeletePrefix")} ${e.message}`, "error");
    }
  }

  async function handleAddExpense(tripId, expense) {
    try {
      const exp = await addTripExpense(tripId, expense);
      setTrips(trips.map(t => t.id === tripId ? { ...t, expenses: [...t.expenses, exp] } : t));
    } catch (e) {
      toast(`${t(lang, "toast.errorSavePrefix")} ${e.message}`, "error");
    }
  }

  async function handleDeleteExpense(tripId, expId) {
    try {
      await deleteTripExpense(tripId, expId);
      setTrips(trips.map(t => t.id === tripId ? { ...t, expenses: t.expenses.filter(e => e.id !== expId) } : t));
    } catch (e) {
      toast(`${t(lang, "toast.errorDeletePrefix")} ${e.message}`, "error");
    }
  }

  const [settlingId, setSettlingId] = useState(null);

  async function handleMarkSettled(trip, settlements) {
    const nameOf = (id) => (trip.partecipanti || []).find(p => p.id === id)?.nome || id;
    const riepilogo = settlements.map(s => `${nameOf(s.da)} → ${nameOf(s.a)}: ${formattaValuta(s.importo)}`).join("\n");
    if (!confirm(`${t(lang, "viaggi.confirmSettlePrefix")} "${trip.nome}" ${t(lang, "viaggi.confirmSettleSuffix")}\n${riepilogo}`)) return;
    setSettlingId(trip.id);
    try {
      // Server computes and inserts the settlement transactions itself
      // (never trusts client-side numbers) and only then marks the trip
      // settled — see POST /api/trips/:id/settle.
      await settleTrip(trip.id);
      setTrips(trips.map(t => t.id === trip.id ? { ...t, settled: true } : t));
    } catch (e) {
      toast(`${t(lang, "toast.errorSavePrefix")} ${e.message}`, "error");
    }
    setSettlingId(null);
  }

  function addGuest() {
    if (!newPersonName.trim()) return;
    const colors = ["#E17055", "#74B9FF", "#55EFC4", "#FDCB6E", "#A29BFE", "#FF7675", "#00CEC9"];
    const p = { id: newPersonName.trim().toLowerCase().replace(/\s+/g, "_"), nome: newPersonName.trim(), emoji: "👤", colore: colors[partecipanti.length % colors.length] };
    setPartecipanti([...partecipanti, p]);
    setNewPersonName("");
  }

  function handleSaveTripCat(id) {
    const updated = tripCats.map(c => c.id === id ? { ...c, ...editForm } : c);
    saveTripCats(updated);
    setEditingCatId(null);
  }
  function handleDeleteTripCat(id) {
    const updated = tripCats.filter(c => c.id !== id);
    saveTripCats(updated);
  }
  function handleAddTripCat() {
    if (!newCat.nome.trim()) return;
    const newId = newCat.nome.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "") + "_" + Date.now().toString(36);
    const without = tripCats.filter(c => c.id !== "altro");
    const altro = tripCats.find(c => c.id === "altro");
    const updated = [...without, { ...newCat, id: newId }, ...(altro ? [altro] : [])];
    saveTripCats(updated);
    setShowNewCat(false);
    setNewCat({ emoji: "📦", nome: "", colore: "#A8A8A8" });
  }

  const calculateSettle = (trip) => calcolaSettleViaggio(trip, valutaBase);

  const allColors = ["#E17055", "#74B9FF", "#55EFC4", "#FDCB6E", "#A29BFE", "#FF7675", "#00CEC9", "#FAB1A0"];
  const tripColors = {};

  if (loading) return <div style={{ padding: 40, textAlign: "center", color: "#888" }}>{t(lang, "viaggi.loading")}</div>;

  return (
    <div style={{ padding: "20px 16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div style={{ fontSize: 22, fontWeight: 800, color: "#eee" }}>{t(lang, "viaggi.title")}</div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => setShowCatManager(!showCatManager)} style={{ background: "none", border: "none", cursor: "pointer", color: showCatManager ? "#6C5CE7" : "#888", fontSize: 16, padding: "4px 8px" }}>⚙</button>
          <button onClick={() => setShowAdd(!showAdd)} style={{ background: showAdd ? "#6C5CE722" : "none", border: showAdd ? "1px solid #6C5CE7" : "1px solid #252538", borderRadius: 10, cursor: "pointer", color: showAdd ? "#6C5CE7" : "#888", fontSize: 18, padding: "4px 12px" }}>{showAdd ? "✕" : "+"}</button>
        </div>
      </div>

      {showCatManager && (
        <div style={{ background: "#1a1a28", borderRadius: 16, padding: 16, marginBottom: 20, border: "2px solid #6C5CE7" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#eee", marginBottom: 14 }}>{t(lang, "viaggi.categories")}</div>
          {tripCats.map(c => (
            <div key={c.id}>
              {editingCatId === c.id ? (
                <div style={{ padding: "10px 0", borderBottom: "1px solid #252538" }}>
                  <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
                    <input value={editForm.emoji || c.emoji} onChange={e => setEditForm(f => ({ ...f, emoji: e.target.value }))}
                      style={{ ...inputStyle, width: 52, textAlign: "center", fontSize: 18, padding: "8px 4px" }} />
                    <input value={editForm.nome || c.nome} onChange={e => setEditForm(f => ({ ...f, nome: e.target.value }))}
                      placeholder={t(lang, "viaggi.categoryNamePlaceholder")} style={{ ...inputStyle, flex: 1, padding: "8px 10px" }} />
                    <input type="color" value={editForm.colore || c.colore} onChange={e => setEditForm(f => ({ ...f, colore: e.target.value }))}
                      style={{ width: 36, height: 36, border: "none", background: "none", cursor: "pointer", padding: 2 }} />
                  </div>
                  <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                    <button onClick={() => setEditingCatId(null)} style={{ padding: "6px 12px", background: "transparent", border: "1px solid #444", borderRadius: 8, color: "#888", fontSize: 12, cursor: "pointer" }}>{t(lang, "common.cancel")}</button>
                    <button onClick={() => handleSaveTripCat(c.id)} style={{ padding: "6px 12px", background: "#6C5CE7", border: "none", borderRadius: 8, color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>{t(lang, "common.save")}</button>
                  </div>
                </div>
              ) : (
                <div style={{ display: "flex", alignItems: "center", padding: "10px 0", borderBottom: "1px solid #252538" }}>
                  <span style={{ fontSize: 16, marginRight: 8 }}>{c.emoji}</span>
                  <span style={{ flex: 1, color: "#ccc", fontSize: 14 }}>{c.nome}</span>
                  <div style={{ width: 16, height: 16, borderRadius: 4, background: c.colore, marginRight: 8 }} />
                  <button onClick={() => { setEditingCatId(c.id); setEditForm(c); }} style={{ background: "none", border: "none", color: "#666", cursor: "pointer", fontSize: 14, padding: "4px 8px" }}>✏</button>
                  <button onClick={() => handleDeleteTripCat(c.id)} style={{ background: "none", border: "none", color: "#FF6B6B", cursor: "pointer", fontSize: 14, padding: "4px 8px" }}>×</button>
                </div>
              )}
            </div>
          ))}
          {showNewCat ? (
            <div style={{ padding: "10px 0" }}>
              <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
                <input value={newCat.emoji} onChange={e => setNewCat(c => ({ ...c, emoji: e.target.value }))}
                  style={{ ...inputStyle, width: 52, textAlign: "center", fontSize: 18, padding: "8px 4px" }} />
                <input value={newCat.nome} onChange={e => setNewCat(c => ({ ...c, nome: e.target.value }))}
                  placeholder={t(lang, "viaggi.newCategoryPlaceholder")} style={{ ...inputStyle, flex: 1, padding: "8px 10px" }} />
                <input type="color" value={newCat.colore} onChange={e => setNewCat(c => ({ ...c, colore: e.target.value }))}
                  style={{ width: 36, height: 36, border: "none", background: "none", cursor: "pointer", padding: 2 }} />
              </div>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button onClick={() => setShowNewCat(false)} style={{ padding: "6px 12px", background: "transparent", border: "1px solid #444", borderRadius: 8, color: "#888", fontSize: 12, cursor: "pointer" }}>{t(lang, "common.cancel")}</button>
                <button onClick={handleAddTripCat} style={{ padding: "6px 12px", background: "#6C5CE7", border: "none", borderRadius: 8, color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>{t(lang, "common.add")}</button>
              </div>
            </div>
          ) : (
            <button onClick={() => setShowNewCat(true)} style={{ marginTop: 12, width: "100%", padding: "10px", background: "transparent", border: "1px dashed #333", borderRadius: 10, color: "#666", fontSize: 13, cursor: "pointer" }}>{t(lang, "settings.newCategory")}</button>
          )}
        </div>
      )}

      {showAdd && (
        <div style={{ background: "#1a1a28", borderRadius: 16, padding: 16, marginBottom: 20, border: "2px solid #6C5CE7" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#eee", marginBottom: 12, fontFamily: "'DM Sans',sans-serif" }}>{t(lang, "viaggi.newTrip")}</div>
          <input type="text" value={nome} onChange={e => setNome(e.target.value)} placeholder={t(lang, "viaggi.tripNamePlaceholder")} style={{ ...inputStyle, marginBottom: 10 }} />
          <input type="text" value={descrizione} onChange={e => setDescrizione(e.target.value)} placeholder={t(lang, "viaggi.descriptionPlaceholder")} style={{ ...inputStyle, marginBottom: 10 }} />
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} placeholder={t(lang, "viaggi.from")} style={{ ...inputStyle, flex: 1 }} />
            <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} placeholder={t(lang, "viaggi.to")} style={{ ...inputStyle, flex: 1 }} />
          </div>
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 11, color: "#888", marginBottom: 6 }}>{t(lang, "viaggi.extraParticipantsPrefix")} {persone.length} {t(lang, "viaggi.extraParticipantsSuffix")}</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {[...persone.map(p => ({ ...p, isMembro: true })), ...partecipanti].map(p => (
                <div key={p.id} style={{ padding: "6px 10px", borderRadius: 10, background: p.colore + "22", border: `1px solid ${p.colore}55`, color: p.colore, fontSize: 12, fontFamily: "'DM Sans',sans-serif" }}>
                  {p.emoji} {p.nome}
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <input type="text" value={newPersonName} onChange={e => setNewPersonName(e.target.value)} placeholder={t(lang, "viaggi.guestNamePlaceholder")} onKeyDown={e => e.key === "Enter" && addGuest()} style={{ ...inputStyle, flex: 1 }} />
              <button onClick={addGuest} style={{ padding: "8px 14px", background: "#6C5CE7", border: "none", borderRadius: 10, color: "#fff", fontSize: 12, fontWeight: 700, fontFamily: "'DM Sans',sans-serif" }}>{t(lang, "common.add")}</button>
            </div>
          </div>
          <button onClick={handleAddTrip} disabled={!nome.trim()} style={{ width: "100%", padding: "12px", background: nome.trim() ? "#6C5CE7" : "#252538", border: "none", borderRadius: 12, color: "#fff", fontSize: 14, fontWeight: 700, fontFamily: "'DM Sans',sans-serif", cursor: nome.trim() ? "pointer" : "default" }}>{t(lang, "viaggi.createTrip")}</button>
        </div>
      )}

      {trips.length === 0 ? (
        <div style={{ color: "#555", textAlign: "center", padding: 40 }}>{t(lang, "viaggi.noTrips")}<br/>{t(lang, "viaggi.tapToCreate")}</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {trips.map(trip => {
            const allP = trip.partecipanti || [];
            tripColors[trip.id] = tripColors[trip.id] || {};
            allP.forEach((p, i) => { tripColors[trip.id][p.id] = allColors[i % allColors.length]; });
            const nameOf = (id) => allP.find(p => p.id === id)?.nome || id;
            const total = trip.expenses?.reduce((s, e) => s + e.importo, 0) || 0;
            const settlements = calculateSettle(trip);
            const isSettling = settlingTrip === trip.id;

            return (
              <div key={trip.id} style={{ background: "#1a1a28", borderRadius: 16, padding: 16, border: "1px solid #252538" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 16, fontWeight: 700, color: "#eee", fontFamily: "'DM Sans',sans-serif" }}>
                      {trip.nome}
                      {trip.settled && <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, color: "#55EFC4", background: "#55EFC422", border: "1px solid #55EFC455", borderRadius: 6, padding: "2px 8px", verticalAlign: "middle" }}>{trip.autoSettled ? t(lang, "viaggi.autoSettled") : t(lang, "viaggi.settled")}</span>}
                    </div>
                    <div style={{ fontSize: 12, color: "#666", fontFamily: "'DM Sans',sans-serif" }}>{trip.descrizione}</div>
                    <div style={{ fontSize: 11, color: "#555", marginTop: 4, fontFamily: "'DM Sans',sans-serif" }}>
                      {trip.startDate && trip.endDate ? `${trip.startDate} → ${trip.endDate}` : trip.startDate || trip.endDate || ""}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
                    {!trip.settled && (
                      trip.shareToken ? (
                        <button onClick={() => handleCopyShareLink(trip.shareToken)} title={t(lang, "viaggi.copyInviteLink")} style={{ background: "#6C5CE722", border: "1px solid #6C5CE7", borderRadius: 8, color: "#a78bfa", cursor: "pointer", fontSize: 11, fontWeight: 700, padding: "6px 8px" }}>🔗</button>
                      ) : (
                        <button onClick={() => handleShareTrip(trip.id)} disabled={shareBusyId === trip.id} title={t(lang, "viaggi.inviteSomeone")} style={{ background: "none", border: "1px solid #252538", borderRadius: 8, color: "#888", cursor: shareBusyId === trip.id ? "default" : "pointer", fontSize: 11, fontWeight: 700, padding: "6px 8px" }}>🔗</button>
                      )
                    )}
                    <button onClick={() => handleDeleteTrip(trip.id)} style={{ background: "none", border: "none", color: "#FF6B6B", cursor: "pointer", fontSize: 18 }}>×</button>
                  </div>
                </div>

                {trip.shareToken && !trip.settled && (
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "#111119", border: "1px solid #252538", borderRadius: 10, padding: "8px 10px", marginBottom: 10 }}>
                    <span style={{ fontSize: 11, color: "#888", fontFamily: "'DM Sans',sans-serif" }}>{t(lang, "viaggi.inviteActive")}</span>
                    <button onClick={() => handleRevokeShare(trip.id)} disabled={shareBusyId === trip.id} style={{ background: "none", border: "none", color: "#FF6B6B", fontSize: 11, fontWeight: 700, cursor: shareBusyId === trip.id ? "default" : "pointer", fontFamily: "'DM Sans',sans-serif" }}>{t(lang, "viaggi.revoke")}</button>
                  </div>
                )}

                <div style={{ marginBottom: 10 }}>
                  <span style={{ fontSize: 14, fontWeight: 700, fontFamily: "'Space Mono',monospace", color: "#a78bfa" }}>{formattaValuta(total)}</span>
                  <span style={{ fontSize: 11, color: "#666", marginLeft: 6, fontFamily: "'DM Sans',sans-serif" }}>({trip.expenses?.length || 0} {t(lang, "viaggi.expenses")})</span>
                </div>

                {!trip.settled && settlements.length > 0 && (
                  <div style={{ background: "#111119", borderRadius: 12, padding: 12, marginBottom: 10 }}>
                    <div style={{ fontSize: 11, color: "#888", marginBottom: 8, fontFamily: "'DM Sans',sans-serif" }}>{t(lang, "viaggi.toSettle")}</div>
                    {settlements.map((s, i) => (
                      <div key={i} style={{ fontSize: 12, marginBottom: 4, fontFamily: "'DM Sans',sans-serif" }}>
                        <span style={{ color: tripColors[trip.id][s.da] }}>{nameOf(s.da)}</span> → <span style={{ color: tripColors[trip.id][s.a] }}>{nameOf(s.a)}</span>: <span style={{ fontFamily: "'Space Mono',monospace" }}>{formattaValuta(s.importo)}</span>
                      </div>
                    ))}
                    <button onClick={() => handleMarkSettled(trip, settlements)} disabled={settlingId === trip.id}
                      style={{ width: "100%", marginTop: 8, padding: "10px", background: settlingId === trip.id ? "#252538" : "#55EFC422", border: "1px solid #55EFC455", borderRadius: 10, color: "#55EFC4", fontSize: 12, fontWeight: 700, fontFamily: "'DM Sans',sans-serif", cursor: settlingId === trip.id ? "default" : "pointer" }}>
                      {settlingId === trip.id ? t(lang, "viaggi.saving") : t(lang, "viaggi.markSettled")}
                    </button>
                  </div>
                )}

                {trip.expenses && trip.expenses.length > 0 && (
                  <div style={{ marginBottom: 10 }}>
                    <button onClick={() => toggleExpenses(trip.id)} style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", background: "#111119", border: "1px solid #252538", borderRadius: 10, padding: "10px 12px", cursor: "pointer", marginBottom: expandedExpenses[trip.id] ? 6 : 0 }}>
                      <span style={{ fontSize: 12, color: "#888", fontFamily: "'DM Sans',sans-serif" }}>{t(lang, "viaggi.expenses")} ({trip.expenses.length})</span>
                      <span style={{ fontSize: 11, color: "#6C5CE7", transform: expandedExpenses[trip.id] ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.2s ease", display: "inline-block" }}>▼</span>
                    </button>
                    {expandedExpenses[trip.id] && trip.expenses.map((e, i) => (
                      <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid #252538", fontFamily: "'DM Sans',sans-serif" }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 13, color: "#ccc" }}>{e.descrizione || t(lang, "viaggi.expenseFallback")}</div>
                          <div style={{ fontSize: 11, color: "#666" }}>{e.categoria} · {e.pagatoDa}</div>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <div style={{ fontSize: 13, fontFamily: "'Space Mono',monospace", color: "#a78bfa" }}>{formattaValuta(e.importo)}</div>
                          {!trip.settled && <button onClick={() => handleDeleteExpense(trip.id, e.id)} style={{ background: "none", border: "none", color: "#FF6B6B", cursor: "pointer", fontSize: 14 }}>×</button>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {!trip.settled && <TripExpenseForm trip={trip} onAdd={exp => handleAddExpense(trip.id, exp)} categorie={tripCats} lang={lang} />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
