import express from "express";
import rateLimit from "express-rate-limit";
import { getMetricsSnapshot } from "../logger.js";
import { sendError, blacklistCol } from "../shared.js";

const router = express.Router();


const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5, // #8: 5 attempts per 15 min — wrong secret = locked out fast
  standardHeaders: true, legacyHeaders: false,
  message: { error: { code: "RATE_LIMITED", message: "Troppi tentativi admin" } },
});


// ─── Admin middleware ───
function requireAdmin(req, res, next) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return sendError(res, 503, "ADMIN_NOT_CONFIGURED", "Admin non configurato (ADMIN_SECRET mancante)");
  if (req.headers["x-admin-secret"] !== secret) return sendError(res, 401, "ADMIN_UNAUTHORIZED", "Non autorizzato");
  next();
}

// ─── Admin blacklist routes ───
router.get("/api/admin/blacklist", adminLimiter, requireAdmin, async (req, res) => {
  try {
    const docs = await blacklistCol.find({}).sort({ addedAt: -1 }).toArray();
    res.json(docs.map(d => ({ key: d.key, reason: d.reason || "", addedAt: d.addedAt })));
  } catch (e) { sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

router.post("/api/admin/blacklist", adminLimiter, requireAdmin, async (req, res) => {
  try {
    const { key, reason } = req.body || {};
    if (!key || typeof key !== "string") return sendError(res, 400, "MISSING_FIELDS", "key obbligatorio (es. ip:1.2.3.4 o device:uuid)");
    await blacklistCol.updateOne(
      { key },
      { $set: { key, reason: reason || "", addedAt: new Date() } },
      { upsert: true }
    );
    res.status(201).json({ ok: true, key });
  } catch (e) { sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

router.delete("/api/admin/blacklist/:key(*)", adminLimiter, requireAdmin, async (req, res) => {
  try {
    const key = decodeURIComponent(req.params.key);
    const r = await blacklistCol.deleteOne({ key });
    if (r.deletedCount === 0) return sendError(res, 404, "NOT_FOUND", "Non trovato");
    res.json({ ok: true, key });
  } catch (e) { sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

// MOD-023: request counts/latency percentiles/error rates per route, plus
// background-job run/failure counts and a running sync-conflict tally —
// "background-job failures are detectable without reading raw server logs
// manually". Admin-gated like the blacklist routes above; in-memory only
// (resets on restart), which is a deliberate simplicity tradeoff over
// wiring in an external metrics service this project doesn't otherwise need.
router.get("/api/admin/metrics", adminLimiter, requireAdmin, (req, res) => {
  res.json(getMetricsSnapshot());
});

export default router;
