import express from "express";
import rateLimit from "express-rate-limit";
import { randomBytes } from "crypto";
import {
  sendError, requireHousehold, requireRole, writeLimiter, householdsCol,
  auditCol, transactionsCol, hashCapabilityToken, findByCapabilityToken,
} from "../shared.js";

const router = express.Router();


// ─── Calendar sync: read-only .ics feed of recurring transactions ───
// Same capability-URL pattern as the widget key. Google Calendar, Apple
// Calendar and Outlook all support "subscribe by URL" natively, so one
// endpoint covers every calendar app without any OAuth/provider integration.
router.post("/api/calendar-key", writeLimiter, requireHousehold, requireRole("admin"), async (req, res) => {
  try {
    const key = randomBytes(24).toString("base64url");
    await householdsCol.updateOne({ householdId: req.householdId }, { $set: { calendarKeyHash: hashCapabilityToken(key), calendarKeyCreatedAt: new Date() }, $unset: { calendarKey: "" } });
    await auditCol.insertOne({ householdId: req.householdId, action: "calendar_key_created", at: new Date() });
    res.json({ key });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

router.delete("/api/calendar-key", writeLimiter, requireHousehold, requireRole("admin"), async (req, res) => {
  try {
    await householdsCol.updateOne({ householdId: req.householdId }, { $unset: { calendarKey: "", calendarKeyHash: "", calendarKeyCreatedAt: "" } });
    await auditCol.insertOne({ householdId: req.householdId, action: "calendar_key_revoked", at: new Date() });
    res.json({ ok: true });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

function icsEscape(s) {
  return String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}
const RRULE_BY_FREQUENZA = {
  settimanale: "FREQ=WEEKLY",
  mensile: "FREQ=MONTHLY",
  trimestrale: "FREQ=MONTHLY;INTERVAL=3",
  annuale: "FREQ=YEARLY",
};
const calendarLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, message: { error: { code: "RATE_LIMITED", message: "Troppe richieste, riprova tra un minuto" } } });
router.get("/api/calendar.ics", calendarLimiter, async (req, res) => {
  try {
    const key = req.query.key;
    if (!key || typeof key !== "string" || key.length < 20) return sendError(res, 401, "MISSING_KEY", "Chiave mancante");
    const household = await findByCapabilityToken(householdsCol, "calendarKey", key);
    if (!household) return sendError(res, 401, "INVALID_KEY", "Chiave non valida");
    const hid = household.householdId;

    const templates = await transactionsCol.find({
      householdId: hid, deletedAt: null, "ricorrenza.frequenza": { $exists: true },
    }).toArray();

    const catById = {};
    for (const c of (household.categorieUscita || [])) catById[c.id] = c.nome;

    const now = new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Finanza Tracker//Recurring Transactions//IT",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      `X-WR-CALNAME:${icsEscape(household.nome)} — Spese ricorrenti`,
      "X-PUBLISHED-TTL:PT12H",
      "REFRESH-INTERVAL;VALUE=DURATION:PT12H",
    ];
    for (const t of templates) {
      const rrule = RRULE_BY_FREQUENZA[t.ricorrenza.frequenza];
      if (!rrule || !/^\d{4}-\d{2}-\d{2}$/.test(t.ricorrenza.prossimaData)) continue;
      const dtstart = t.ricorrenza.prossimaData.replace(/-/g, "");
      const catNome = catById[t.categoria] || t.categoria || "";
      const summary = `${t.tipo === "entrata" ? "💰" : "💸"} ${t.descrizione || catNome} — €${Number(t.importo).toFixed(2)}`;
      lines.push(
        "BEGIN:VEVENT",
        `UID:${t._id.toString()}@finanza-tracker`,
        `DTSTAMP:${now}`,
        `DTSTART;VALUE=DATE:${dtstart}`,
        `RRULE:${rrule}`,
        `SUMMARY:${icsEscape(summary)}`,
        `DESCRIPTION:${icsEscape(t.ricorrenza.variabile ? "Importo variabile — verificare ad ogni rinnovo" : "")}`,
        "END:VEVENT",
      );
    }
    lines.push("END:VCALENDAR");

    res.set("Content-Type", "text/calendar; charset=utf-8");
    res.set("Content-Disposition", 'inline; filename="finanza-ricorrenti.ics"');
    res.send(lines.join("\r\n"));
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

export default router;
