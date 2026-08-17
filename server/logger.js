// ─── Structured logging (MOD-023) ───
// Emits one JSON object per line instead of free-text console messages —
// the difference that actually matters for "a production failure can be
// traced without exposing secrets": a log aggregator (Render's log view,
// Datadog, CloudWatch, whatever) can filter/query structured fields
// (level, requestId, householdId, job) the way it never can with
// "Ricorrenti: generate 3 transazioni". Pure formatting/redaction logic
// only — no request/DB coupling — so it's unit-testable in isolation.

// Fields that must never appear in a log line, even if a caller
// accidentally passes them in context — defense in depth beyond "just
// don't log this". Matched case-insensitively against context keys.
const SENSITIVE_KEYS = new Set([
  "pin", "newpin", "oldpin", "password",
  "token", "jwt", "authorization", "cookie",
  "widgetkey", "calendarkey", "sharetoken", "idempotencykey",
  "key", "secret", "adminsecret",
]);

// Recursively redacts sensitive keys in a plain object/array (context
// passed to a log call is expected to be simple structured data, not
// arbitrary class instances — this intentionally doesn't try to walk
// Error objects, Buffers, etc., which shouldn't be passed as context
// directly anyway; pass err.message, not err).
export function redactSensitive(value, depth = 0) {
  if (depth > 5 || value == null) return value;
  if (Array.isArray(value)) return value.map(v => redactSensitive(v, depth + 1));
  if (typeof value !== "object") return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(k.toLowerCase())) { out[k] = "[REDACTED]"; continue; }
    out[k] = redactSensitive(v, depth + 1);
  }
  return out;
}

// Builds the JSON-serializable log entry (pure — no I/O), so the shape is
// unit-testable without capturing stdout.
export function buildLogEntry(level, msg, context = {}, now = () => new Date().toISOString()) {
  return { ts: now(), level, msg, ...redactSensitive(context) };
}

function emit(level, msg, context) {
  const entry = buildLogEntry(level, msg, context);
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  info: (msg, context) => emit("info", msg, context),
  warn: (msg, context) => emit("warn", msg, context),
  error: (msg, context) => emit("error", msg, context),
};

// ─── In-memory metrics (MOD-023) ───
// Deliberately simple: counters and a small latency sample buffer per
// route, reset on process restart. No external metrics service dependency
// — good enough for "detectable without reading raw server logs manually"
// via GET /api/admin/metrics, without taking on a Prometheus/StatsD
// integration this project doesn't otherwise need.
const MAX_LATENCY_SAMPLES = 200;
const state = {
  requests: { total: 0, byStatusClass: { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 } },
  routes: new Map(), // "METHOD path" -> { count, errorCount, latenciesMs: number[] }
  jobs: {}, // jobName -> { runs, failures, lastRunAt, lastFailureAt, lastError }
  syncConflicts: 0,
  startedAt: new Date().toISOString(),
};

function statusClass(status) {
  if (status >= 500) return "5xx";
  if (status >= 400) return "4xx";
  if (status >= 300) return "3xx";
  return "2xx";
}

export function recordRequestMetric(method, path, status, durationMs) {
  state.requests.total++;
  state.requests.byStatusClass[statusClass(status)]++;
  const key = `${method} ${path}`;
  if (!state.routes.has(key)) state.routes.set(key, { count: 0, errorCount: 0, latenciesMs: [] });
  const r = state.routes.get(key);
  r.count++;
  if (status >= 400) r.errorCount++;
  r.latenciesMs.push(durationMs);
  if (r.latenciesMs.length > MAX_LATENCY_SAMPLES) r.latenciesMs.shift();
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

export function recordJobRun(jobName, { failed = false, error = null } = {}) {
  if (!state.jobs[jobName]) state.jobs[jobName] = { runs: 0, failures: 0, lastRunAt: null, lastFailureAt: null, lastError: null };
  const j = state.jobs[jobName];
  j.runs++;
  j.lastRunAt = new Date().toISOString();
  if (failed) {
    j.failures++;
    j.lastFailureAt = j.lastRunAt;
    j.lastError = error ? String(error).slice(0, 500) : null;
  }
}

export function recordSyncConflict(count = 1) {
  state.syncConflicts += count;
}

// ─── Trip embedded-array instrumentation (MOD-019) ───
// Trip expenses are embedded in the trip document (server/index.js has the
// full reasoning). This is the "measure before you migrate" half of that
// decision: track the largest expense count and document size actually
// seen, in-memory, the same way the rest of this module's metrics work —
// so the migration threshold documented in docs/API.md can eventually be
// revised from real numbers instead of a one-time guess. Approximates BSON
// size with a JSON-string byte length (Buffer.byteLength) rather than
// pulling in a BSON-serialization dependency just for a metrics estimate —
// close enough for "is this trending toward a problem," not meant to be
// the exact number MongoDB would report.
const tripStats = {
  maxExpenseCount: 0,
  maxDocumentSizeBytes: 0,
  maxExpenseCountTripId: null,
  maxDocumentSizeTripId: null,
  tripsOverWarnThresholdSeen: 0,
  samples: 0,
};

export function estimateDocumentSizeBytes(doc) {
  return Buffer.byteLength(JSON.stringify(doc), "utf8");
}

export function recordTripEmbeddingStats(trip, { warnThreshold = 300 } = {}) {
  const count = (trip.expenses || []).length;
  const sizeBytes = estimateDocumentSizeBytes(trip);
  const tripId = trip._id ? String(trip._id) : trip.id;
  tripStats.samples++;
  if (count >= warnThreshold) tripStats.tripsOverWarnThresholdSeen++;
  if (count > tripStats.maxExpenseCount) {
    tripStats.maxExpenseCount = count;
    tripStats.maxExpenseCountTripId = tripId;
  }
  if (sizeBytes > tripStats.maxDocumentSizeBytes) {
    tripStats.maxDocumentSizeBytes = sizeBytes;
    tripStats.maxDocumentSizeTripId = tripId;
  }
}

export function getMetricsSnapshot() {
  const routes = {};
  for (const [key, r] of state.routes) {
    const sorted = [...r.latenciesMs].sort((a, b) => a - b);
    routes[key] = {
      count: r.count,
      errorCount: r.errorCount,
      errorRate: r.count > 0 ? Math.round((r.errorCount / r.count) * 1000) / 1000 : 0,
      latencyMsP50: percentile(sorted, 0.5),
      latencyMsP95: percentile(sorted, 0.95),
      latencyMsP99: percentile(sorted, 0.99),
    };
  }
  return {
    startedAt: state.startedAt,
    uptimeSeconds: Math.round(process.uptime()),
    requests: state.requests,
    routes,
    jobs: state.jobs,
    syncConflictsObserved: state.syncConflicts,
    tripEmbedding: { ...tripStats },
  };
}

// Test-only reset — exported so validation.test.js-style unit tests don't
// leak state between cases; never called from application code.
export function _resetMetricsForTests() {
  state.requests = { total: 0, byStatusClass: { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 } };
  state.routes = new Map();
  state.jobs = {};
  state.syncConflicts = 0;
  tripStats.maxExpenseCount = 0;
  tripStats.maxDocumentSizeBytes = 0;
  tripStats.maxExpenseCountTripId = null;
  tripStats.maxDocumentSizeTripId = null;
  tripStats.tripsOverWarnThresholdSeen = 0;
  tripStats.samples = 0;
}
