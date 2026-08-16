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
});
