import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { randomUUID } from "crypto";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { logger, recordRequestMetric } from "./logger.js";
import {
  db, connectDB, verifyEmailSetup, generaRicorrentiDovute, svuotaCestinoScaduto,
  chiudiViaggiScaduti, RICORRENTI_CHECK_MS,
} from "./shared.js";

import adminRoutes from "./routes/admin.js";
import authRoutes from "./routes/auth.js";
import householdRoutes from "./routes/household.js";
import transactionsRoutes from "./routes/transactions.js";
import statsRoutes from "./routes/stats.js";
import categoriesRoutes from "./routes/categories.js";
import positionsRoutes from "./routes/positions.js";
import goalsRoutes from "./routes/goals.js";
import accountsRoutes from "./routes/accounts.js";
import backupRoutes from "./routes/backup.js";
import widgetRoutes from "./routes/widget.js";
import calendarRoutes from "./routes/calendar.js";
import tripsRoutes from "./routes/trips.js";


const app = express();
app.set("trust proxy", 1);
const PORT = process.env.PORT || 3001;

// ─── Security headers ───
// No CSP here on purpose — this app never serves the HTML document (every
// route is /api/* JSON, proxied to from the Vercel-hosted SPA). The real
// CSP is attached by Vercel to the actual document response (see the
// "headers" block in vercel.json at the repo root).
app.use(helmet({ contentSecurityPolicy: false }));

// ─── CORS: restrict to known origins ───
const ALLOWED_ORIGINS = [
  "https://balance-tracker-two.vercel.app",
  "http://localhost:5173",
  "http://localhost:4173",
  "capacitor://localhost",  // Capacitor iOS webview
  "http://localhost",       // Capacitor Android webview
];
// Allow any Vercel preview deploy for this project
const VERCEL_PREVIEW_RE = /^https:\/\/balance-tracker-[a-z0-9-]+-pygabba\.vercel\.app$/;
const CORS_OPTIONS = {
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin) || VERCEL_PREVIEW_RE.test(origin))
      return cb(null, true);
    cb(new Error(`CORS: origin not allowed: ${origin}`));
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  // MOD-004/MOD-003: the offline sync engine sends Idempotency-Key on
  // create requests — same-origin requests (the normal production path via
  // the Vercel proxy) never hit a CORS preflight at all, but any
  // cross-origin path (local dev on a different port, a future separately-
  // hosted client) needs it explicitly allow-listed or the preflight fails
  // and the header gets silently dropped.
  allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key"],
  credentials: true,
  optionsSuccessStatus: 200,
};
app.use(cors(CORS_OPTIONS));
app.options("*", cors(CORS_OPTIONS));
app.use(cookieParser());
app.use(express.json({ limit: "10mb" }));

// ─── Request ID + structured request logging (MOD-023) ───
// Every request gets a correlation id (echoed back as X-Request-Id so a
// person reporting an issue can hand it over, and included in every log
// line for that request) and a structured log entry with method/path/
// status/duration on completion — deliberately NOT the request body or
// query string, since that's exactly where PINs (login), capability
// tokens (widget/calendar — query string), and financial payloads
// (transaction writes) live. sanitizePathForLog additionally redacts the
// one case a token rides in the URL PATH itself rather than the query:
// trip share links.
function sanitizePathForLog(path) {
  return path.replace(/^(\/api\/trips\/shared)\/[^/]+/, "$1/[REDACTED]");
}
app.use((req, res, next) => {
  req.requestId = req.headers["x-request-id"] || randomUUID();
  res.setHeader("X-Request-Id", req.requestId);
  const start = Date.now();
  res.on("finish", () => {
    const durationMs = Date.now() - start;
    const path = sanitizePathForLog(req.path);
    recordRequestMetric(req.method, path, res.statusCode, durationMs);
    const level = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
    logger[level]("http_request", {
      requestId: req.requestId,
      method: req.method,
      path,
      status: res.statusCode,
      durationMs,
      householdId: req.householdId || undefined,
    });
  });
  next();
});


// ─── Route modules (one per domain, server/routes/) ───
app.use(adminRoutes);
app.use(authRoutes);
app.use(householdRoutes);
app.use(transactionsRoutes);
app.use(statsRoutes);
app.use(categoriesRoutes);
app.use(positionsRoutes);
app.use(goalsRoutes);
app.use(accountsRoutes);
app.use(backupRoutes);
app.use(widgetRoutes);
app.use(calendarRoutes);
app.use(tripsRoutes);

app.get("/api/health", (req, res) => res.json({ status: "ok", db: !!db }));

async function start() {
  try {
    await connectDB();
    app.listen(PORT, () => logger.info("server_listening", { port: PORT }));
    verifyEmailSetup().catch(() => {}); // diagnostico, non deve mai bloccare l'avvio
    import("./keep-alive.js").catch(() => {});
    generaRicorrentiDovute();
    setInterval(generaRicorrentiDovute, RICORRENTI_CHECK_MS);
    svuotaCestinoScaduto();
    setInterval(svuotaCestinoScaduto, RICORRENTI_CHECK_MS);
    chiudiViaggiScaduti();
    setInterval(chiudiViaggiScaduti, RICORRENTI_CHECK_MS);
  } catch (e) { logger.error("startup_failed", { error: e.message }); process.exit(1); }
}

// MOD-014: only bind a port / connect to the real database / start the
// background-job intervals when this file is run directly (`node index.js`
// or `node --watch index.js`, i.e. production and local dev) — not when
// it's imported by a test file. Tests import `app` and call `connectDB(uri)`
// themselves against a disposable mongodb-memory-server instance instead.
//
// Comparing realpath'd paths (not raw `import.meta.url` vs `process.argv[1]`
// strings) matters here: on systems where the invocation path runs through
// a symlink (e.g. macOS's /tmp -> /private/tmp), Node resolves
// import.meta.url through the symlink but leaves process.argv[1] as typed,
// so a naive string comparison silently mismatches and start() never runs.
let isMainModule = false;
try {
  isMainModule = !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
} catch { /* argv[1] not a real file (e.g. some REPL/loader contexts) — not the main module */ }
if (isMainModule) {
  start();
}

export { app };
export { connectDB, generaRicorrentiDovute, chiudiViaggiScaduti } from "./shared.js";
