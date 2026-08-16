import { describe, it, expect, beforeEach } from "vitest";
import {
  redactSensitive, buildLogEntry, recordRequestMetric, recordJobRun,
  recordSyncConflict, getMetricsSnapshot, _resetMetricsForTests,
} from "./logger.js";

describe("redactSensitive", () => {
  it("passes through a context with no sensitive fields", () => {
    expect(redactSensitive({ householdId: "h1", status: 200 })).toEqual({ householdId: "h1", status: 200 });
  });

  it("redacts a top-level sensitive field", () => {
    expect(redactSensitive({ pin: "1234" })).toEqual({ pin: "[REDACTED]" });
  });

  it("redacts case-insensitively", () => {
    expect(redactSensitive({ PIN: "1234", Token: "abc", WidgetKey: "xyz" })).toEqual({
      PIN: "[REDACTED]", Token: "[REDACTED]", WidgetKey: "[REDACTED]",
    });
  });

  it("redacts nested sensitive fields", () => {
    expect(redactSensitive({ req: { body: { pin: "1234", nome: "Casa" } } })).toEqual({
      req: { body: { pin: "[REDACTED]", nome: "Casa" } },
    });
  });

  it("redacts sensitive fields inside arrays of objects", () => {
    expect(redactSensitive({ items: [{ token: "abc" }, { nome: "ok" }] })).toEqual({
      items: [{ token: "[REDACTED]" }, { nome: "ok" }],
    });
  });

  it("leaves non-sensitive nested data untouched", () => {
    const ctx = { householdId: "h1", meta: { count: 3, tags: ["a", "b"] } };
    expect(redactSensitive(ctx)).toEqual(ctx);
  });

  it("does not blow the stack on deeply nested input — depth-limited", () => {
    let deep = { pin: "1234" };
    for (let i = 0; i < 20; i++) deep = { nested: deep };
    expect(() => redactSensitive(deep)).not.toThrow();
  });

  it("passes through primitives and null unchanged", () => {
    expect(redactSensitive(null)).toBeNull();
    expect(redactSensitive(undefined)).toBeUndefined();
    expect(redactSensitive("plain string")).toBe("plain string");
    expect(redactSensitive(42)).toBe(42);
  });
});

describe("buildLogEntry", () => {
  it("includes timestamp, level, message, and redacted context", () => {
    const entry = buildLogEntry("info", "test message", { pin: "1234", ok: true }, () => "2026-08-16T00:00:00.000Z");
    expect(entry).toEqual({ ts: "2026-08-16T00:00:00.000Z", level: "info", msg: "test message", pin: "[REDACTED]", ok: true });
  });

  it("is JSON-serializable (no circular refs, no functions leaking through)", () => {
    const entry = buildLogEntry("error", "boom", { requestId: "abc" }, () => "2026-08-16T00:00:00.000Z");
    expect(() => JSON.stringify(entry)).not.toThrow();
  });
});

describe("metrics — requests", () => {
  beforeEach(() => _resetMetricsForTests());

  it("counts requests by status class", () => {
    recordRequestMetric("GET", "/api/transactions", 200, 10);
    recordRequestMetric("POST", "/api/transactions", 400, 5);
    recordRequestMetric("GET", "/api/transactions", 500, 20);
    const snap = getMetricsSnapshot();
    expect(snap.requests.total).toBe(3);
    expect(snap.requests.byStatusClass).toEqual({ "2xx": 1, "3xx": 0, "4xx": 1, "5xx": 1 });
  });

  it("tracks per-route count, error count, and error rate", () => {
    recordRequestMetric("GET", "/api/goals", 200, 10);
    recordRequestMetric("GET", "/api/goals", 200, 10);
    recordRequestMetric("GET", "/api/goals", 500, 10);
    const snap = getMetricsSnapshot();
    const route = snap.routes["GET /api/goals"];
    expect(route.count).toBe(3);
    expect(route.errorCount).toBe(1);
    expect(route.errorRate).toBeCloseTo(0.333, 2);
  });

  it("computes latency percentiles per route", () => {
    for (const ms of [10, 20, 30, 40, 100]) recordRequestMetric("GET", "/api/x", 200, ms);
    const route = getMetricsSnapshot().routes["GET /api/x"];
    expect(route.latencyMsP50).toBeGreaterThanOrEqual(20);
    expect(route.latencyMsP99).toBe(100);
  });

  it("caps the latency sample buffer instead of growing unbounded", () => {
    for (let i = 0; i < 500; i++) recordRequestMetric("GET", "/api/busy", 200, i);
    // Internal cap is 200 samples — snapshot shouldn't choke or misbehave
    // regardless, and percentiles should still be sane (drawn from the
    // most recent samples).
    const route = getMetricsSnapshot().routes["GET /api/busy"];
    expect(route.count).toBe(500); // count is a running total, not sample-limited
    expect(route.latencyMsP99).toBeLessThanOrEqual(499);
  });

  it("keeps separate stats per distinct method+path", () => {
    recordRequestMetric("GET", "/api/accounts", 200, 5);
    recordRequestMetric("POST", "/api/accounts", 201, 5);
    const snap = getMetricsSnapshot();
    expect(snap.routes["GET /api/accounts"].count).toBe(1);
    expect(snap.routes["POST /api/accounts"].count).toBe(1);
  });
});

describe("metrics — background jobs", () => {
  beforeEach(() => _resetMetricsForTests());

  it("tracks successful runs", () => {
    recordJobRun("recurring");
    recordJobRun("recurring");
    const snap = getMetricsSnapshot();
    expect(snap.jobs.recurring.runs).toBe(2);
    expect(snap.jobs.recurring.failures).toBe(0);
  });

  it("tracks failures with the error message, truncated", () => {
    recordJobRun("tripSettlement", { failed: true, error: new Error("insert failed") });
    const snap = getMetricsSnapshot();
    expect(snap.jobs.tripSettlement.runs).toBe(1);
    expect(snap.jobs.tripSettlement.failures).toBe(1);
    expect(snap.jobs.tripSettlement.lastError).toMatch(/insert failed/);
  });

  it("keeps separate stats per distinct job name", () => {
    recordJobRun("recurring");
    recordJobRun("tripSettlement", { failed: true, error: "x" });
    const snap = getMetricsSnapshot();
    expect(snap.jobs.recurring.failures).toBe(0);
    expect(snap.jobs.tripSettlement.failures).toBe(1);
  });
});

describe("metrics — sync conflicts", () => {
  beforeEach(() => _resetMetricsForTests());

  it("accumulates a running count", () => {
    recordSyncConflict();
    recordSyncConflict(3);
    expect(getMetricsSnapshot().syncConflictsObserved).toBe(4);
  });
});

describe("getMetricsSnapshot", () => {
  beforeEach(() => _resetMetricsForTests());

  it("is JSON-serializable end to end", () => {
    recordRequestMetric("GET", "/api/x", 200, 5);
    recordJobRun("recurring");
    recordSyncConflict();
    expect(() => JSON.stringify(getMetricsSnapshot())).not.toThrow();
  });

  it("includes process uptime and a start timestamp", () => {
    const snap = getMetricsSnapshot();
    expect(typeof snap.uptimeSeconds).toBe("number");
    expect(typeof snap.startedAt).toBe("string");
  });
});
