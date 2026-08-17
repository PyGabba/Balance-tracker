import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { startTestServer, stopTestServer, getDb } from "./testUtils.js";

let app;
let agent;

beforeAll(async () => {
  app = await startTestServer();
  agent = request.agent(app);
  // Single registration for this file (registerLimiter: 5/hour).
  const reg = await agent
    .post("/api/auth/register")
    .send({ nome: "Test Household Capability", persone: ["Gabriele"], pin: "418293" });
  expect(reg.status).toBe(201);
}, 60000);

afterAll(async () => {
  await stopTestServer();
});

describe("trip share token expiry (MOD-011)", () => {
  it("a fresh share token works", async () => {
    const tripRes = await agent.post("/api/trips").send({ nome: "Weekend fuori" });
    expect(tripRes.status).toBe(200);
    const tripId = tripRes.body.id;

    const shareRes = await agent.post(`/api/trips/${tripId}/share`);
    expect(shareRes.status).toBe(200);
    const token = shareRes.body.token;

    const getRes = await request(app).get(`/api/trips/shared/${token}`);
    expect(getRes.status).toBe(200);
  });

  it("an expired share token is rejected exactly like a non-existent one", async () => {
    const tripRes = await agent.post("/api/trips").send({ nome: "Viaggio scaduto" });
    const tripId = tripRes.body.id;

    const shareRes = await agent.post(`/api/trips/${tripId}/share`);
    const token = shareRes.body.token;

    // Simulate the token having been issued more than TRIP_SHARE_TOKEN_TTL_DAYS
    // (30) ago, without waiting 30 real days.
    const db = getDb();
    await db.collection("trips").updateOne(
      { _id: (await db.collection("trips").findOne({ nome: "Viaggio scaduto" }))._id },
      { $set: { shareTokenCreatedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) } }
    );

    const getRes = await request(app).get(`/api/trips/shared/${token}`);
    expect(getRes.status).toBe(404);

    const joinRes = await request(app).post(`/api/trips/shared/${token}/join`).send({ nome: "Guest" });
    expect(joinRes.status).toBe(404);
  });

  it("a revoked share token is rejected exactly like an expired or non-existent one", async () => {
    const tripRes = await agent.post("/api/trips").send({ nome: "Viaggio revocato" });
    const tripId = tripRes.body.id;
    const shareRes = await agent.post(`/api/trips/${tripId}/share`);
    const token = shareRes.body.token;

    expect((await request(app).get(`/api/trips/shared/${token}`)).status).toBe(200);
    await agent.delete(`/api/trips/${tripId}/share`);
    expect((await request(app).get(`/api/trips/shared/${token}`)).status).toBe(404);
  });
});

describe("widget key lifecycle (MOD-011)", () => {
  it("issues a working key, and regenerating invalidates the previous one", async () => {
    const first = await agent.post("/api/widget-key");
    expect(first.status).toBe(200);
    const firstKey = first.body.key;
    expect(firstKey.length).toBeGreaterThanOrEqual(20);

    const okRes = await request(app).get(`/api/widget?key=${firstKey}`);
    expect(okRes.status).toBe(200);

    const second = await agent.post("/api/widget-key");
    const secondKey = second.body.key;
    expect(secondKey).not.toBe(firstKey);

    // Regenerating is an implicit revoke of the old key — only one active key per household.
    expect((await request(app).get(`/api/widget?key=${firstKey}`)).status).toBe(401);
    expect((await request(app).get(`/api/widget?key=${secondKey}`)).status).toBe(200);
  });

  it("a revoked widget key is rejected", async () => {
    const created = await agent.post("/api/widget-key");
    const key = created.body.key;
    expect((await request(app).get(`/api/widget?key=${key}`)).status).toBe(200);

    await agent.delete("/api/widget-key");
    expect((await request(app).get(`/api/widget?key=${key}`)).status).toBe(401);
  });

  it("rejects a missing or malformed key with the structured error shape", async () => {
    const missing = await request(app).get("/api/widget");
    expect(missing.status).toBe(401);
    expect(missing.body.error.code).toBe("MISSING_KEY");

    const invalid = await request(app).get("/api/widget?key=too-short");
    expect(invalid.status).toBe(401);
    expect(invalid.body.error.code).toBe("MISSING_KEY"); // still too short to even attempt a lookup

    const wrong = await request(app).get(`/api/widget?key=${"x".repeat(32)}`);
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe("INVALID_KEY");
  });

  it("never returns the raw transaction list — aggregate numbers only", async () => {
    await agent.post("/api/transactions").send({ tipo: "uscita", importo: 42, data: "2026-08-01" });
    const created = await agent.post("/api/widget-key");
    const res = await request(app).get(`/api/widget?key=${created.body.key}`);
    expect(res.status).toBe(200);
    expect(res.body.transactions).toBeUndefined();
    expect(res.body.transazioni).toBeUndefined();
  });
});

describe("calendar key + feed lifecycle (MOD-011)", () => {
  it("issues a working key serving a text/calendar feed, and revoking it invalidates access", async () => {
    const created = await agent.post("/api/calendar-key");
    expect(created.status).toBe(200);
    const key = created.body.key;

    const feedRes = await request(app).get(`/api/calendar.ics?key=${key}`);
    expect(feedRes.status).toBe(200);
    expect(feedRes.headers["content-type"]).toMatch(/text\/calendar/);
    expect(feedRes.text).toMatch(/BEGIN:VCALENDAR/);

    await agent.delete("/api/calendar-key");
    const afterRevoke = await request(app).get(`/api/calendar.ics?key=${key}`);
    expect(afterRevoke.status).toBe(401);
  });

  it("rejects a missing or invalid key with the structured error shape, not a bare text response", async () => {
    const missing = await request(app).get("/api/calendar.ics");
    expect(missing.status).toBe(401);
    expect(missing.body.error.code).toBe("MISSING_KEY");

    const invalid = await request(app).get(`/api/calendar.ics?key=${"x".repeat(32)}`);
    expect(invalid.status).toBe(401);
    expect(invalid.body.error.code).toBe("INVALID_KEY");
  });

  it("regenerating the calendar key invalidates the previous one", async () => {
    const first = await agent.post("/api/calendar-key");
    const second = await agent.post("/api/calendar-key");
    expect(second.body.key).not.toBe(first.body.key);
    expect((await request(app).get(`/api/calendar.ics?key=${first.body.key}`)).status).toBe(401);
    expect((await request(app).get(`/api/calendar.ics?key=${second.body.key}`)).status).toBe(200);
  });
});
