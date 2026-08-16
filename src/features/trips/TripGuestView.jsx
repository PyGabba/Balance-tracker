import { useState, useEffect } from "react";
import { fetchSharedTrip, joinSharedTrip } from "../../api.js";
import { calcolaSettleViaggio } from "../../lib/finance.js";
import { t, detectGuestLang } from "../../lib/i18n.js";
import { formattaValuta } from "../../lib/format.js";
import { toast, ToastHost } from "../../components/Toast.jsx";
import { inputStyle } from "../../components/ui/styles.js";
import { GuestExpenseForm } from "./GuestExpenseForm.jsx";
import { guestTripDefaultCategorie } from "./helpers.js";

export function TripGuestView({ token }) {
  const [lang] = useState(() => detectGuestLang());
  const [trip, setTrip] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [me, setMe] = useState(null); // { id, nome } — this guest's identity, remembered locally per token
  const [nomeInput, setNomeInput] = useState("");
  const [joining, setJoining] = useState(false);

  const lsKey = `guest-trip-identity-${token}`;

  async function load() {
    setLoading(true);
    try {
      const data = await fetchSharedTrip(token);
      setTrip(data);
      try {
        const saved = JSON.parse(localStorage.getItem(lsKey) || "null");
        if (saved && (data.partecipanti || []).some(p => p.id === saved.id)) setMe(saved);
      } catch {}
    } catch (e) {
      setError(e.message || t(lang, "guest.invalidLink"));
    }
    setLoading(false);
  }

  useEffect(() => { load(); }, [token]);

  async function handleJoin() {
    if (!nomeInput.trim()) return;
    setJoining(true);
    try {
      const p = await joinSharedTrip(token, nomeInput.trim());
      setMe(p);
      try { localStorage.setItem(lsKey, JSON.stringify(p)); } catch {}
      await load();
    } catch (e) { toast(`${t(lang, "toast.errorPrefix")} ${e.message}`, "error"); }
    setJoining(false);
  }

  if (loading) return <div style={{ padding: 40, textAlign: "center", color: "#666" }}>{t(lang, "viaggi.loading")}</div>;
  if (error || !trip) return (
    <div style={{ padding: 40, textAlign: "center", color: "#FF6B6B" }}>
      {error || t(lang, "guest.invalidLink")}
    </div>
  );

  const nameOf = (id) => (trip.partecipanti || []).find(p => p.id === id)?.nome || id;
  const total = trip.expenses?.reduce((s, e) => s + e.importo, 0) || 0;
  const settlements = calcolaSettleViaggio(trip);

  return (
    <div style={{ maxWidth: 430, margin: "0 auto", minHeight: "100dvh", background: "#111119", color: "#eee", fontFamily: "'DM Sans', sans-serif", padding: "24px 16px" }}>
      <ToastHost />
      <div style={{ fontSize: 11, color: "#6C5CE7", letterSpacing: 1, textTransform: "uppercase", marginBottom: 4 }}>{t(lang, "guest.invitedTo")}</div>
      <div style={{ fontSize: 24, fontWeight: 800, marginBottom: 4 }}>{trip.nome}</div>
      {trip.descrizione && <div style={{ fontSize: 13, color: "#888", marginBottom: 4 }}>{trip.descrizione}</div>}
      <div style={{ fontSize: 12, color: "#555", marginBottom: 20 }}>
        {trip.startDate && trip.endDate ? `${trip.startDate} → ${trip.endDate}` : trip.startDate || trip.endDate || ""}
        {trip.settled && <span style={{ marginLeft: 8, color: "#55EFC4", fontWeight: 700 }}>{t(lang, "guest.closed")}</span>}
      </div>

      {!me && !trip.settled && (
        <div style={{ background: "#1a1a28", borderRadius: 16, padding: 16, border: "1px solid #252538", marginBottom: 20 }}>
          <div style={{ fontSize: 13, color: "#ccc", marginBottom: 10 }}>{t(lang, "guest.whatsYourName")}</div>
          <input type="text" value={nomeInput} onChange={e => setNomeInput(e.target.value)} onKeyDown={e => e.key === "Enter" && handleJoin()}
            placeholder={t(lang, "guest.yourName")} autoFocus style={{ ...inputStyle, marginBottom: 10 }} />
          <button onClick={handleJoin} disabled={!nomeInput.trim() || joining} style={{
            width: "100%", padding: "12px", border: "none", borderRadius: 12,
            background: nomeInput.trim() ? "#6C5CE7" : "#252538", color: "#fff",
            fontSize: 14, fontWeight: 700, cursor: nomeInput.trim() ? "pointer" : "default",
          }}>{joining ? "..." : t(lang, "guest.joinTrip")}</button>
        </div>
      )}

      {!me && trip.settled && (
        <div style={{ fontSize: 12, color: "#666", marginBottom: 20 }}>{t(lang, "guest.tripClosedReadonly")}</div>
      )}

      {me && (
        <div style={{ fontSize: 12, color: "#666", marginBottom: 16 }}>{t(lang, "guest.participatingAs")} <strong style={{ color: "#a78bfa" }}>{me.nome}</strong></div>
      )}

      <div style={{ marginBottom: 16 }}>
        <span style={{ fontSize: 16, fontWeight: 700, fontFamily: "'Space Mono',monospace", color: "#a78bfa" }}>{formattaValuta(total)}</span>
        <span style={{ fontSize: 12, color: "#666", marginLeft: 6 }}>{t(lang, "guest.total")} · {trip.expenses?.length || 0} {t(lang, "viaggi.expenses")}</span>
      </div>

      {settlements.length > 0 && (
        <div style={{ background: "#1a1a28", borderRadius: 14, padding: 14, marginBottom: 16, border: "1px solid #252538" }}>
          <div style={{ fontSize: 11, color: "#888", marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>{trip.settled ? t(lang, "guest.settledLikeThis") : t(lang, "viaggi.toSettle")}</div>
          {settlements.map((s, i) => (
            <div key={i} style={{ fontSize: 13, marginBottom: 4 }}>
              {nameOf(s.da)} → {nameOf(s.a)}: <span style={{ fontFamily: "'Space Mono',monospace" }}>{formattaValuta(s.importo)}</span>
            </div>
          ))}
        </div>
      )}

      {trip.expenses && trip.expenses.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, color: "#888", marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>{t(lang, "guest.expenses")}</div>
          {trip.expenses.map((e, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid #252538" }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, color: "#ccc" }}>{e.descrizione || t(lang, "viaggi.expenseFallback")}</div>
                <div style={{ fontSize: 11, color: "#666" }}>{e.categoria} · {nameOf(e.pagatoDa)}</div>
              </div>
              <div style={{ fontSize: 13, fontFamily: "'Space Mono',monospace", color: "#a78bfa" }}>{formattaValuta(e.importo)}</div>
            </div>
          ))}
        </div>
      )}

      {me && !trip.settled && (
        <GuestExpenseForm trip={trip} me={me} token={token} categorie={guestTripDefaultCategorie(lang)} onAdded={load} lang={lang} />
      )}
    </div>
  );
}
