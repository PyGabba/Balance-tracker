import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { startTestServer, stopTestServer } from "./testUtils.js";

// Regression coverage for two trip-sharing invariants:
//   1. A share-link token proves "may access this trip", not "which
//      participant I am" — expense creation must derive pagatoDa from a
//      per-guest identity issued at join time, never from the request body.
//   2. `settled` is a financial invariant (settlement transactions actually
//      exist), not a plain client-writable field, and it's one-directional.

let app;
let agent;

beforeAll(async () => {
  app = await startTestServer();
  agent = request.agent(app);
  const reg = await agent
    .post("/api/auth/register")
    .send({ nome: "Trip Security Household", persone: ["Gabriele"], pin: "715392" });
  expect(reg.status).toBe(201);
}, 60000);

afterAll(async () => {
  await stopTestServer();
});

async function makeSharedTrip(nome) {
  const tripRes = await agent.post("/api/trips").send({ nome });
  expect(tripRes.status).toBe(200);
  const tripId = tripRes.body.id;
  const shareRes = await agent.post(`/api/trips/${tripId}/share`);
  expect(shareRes.status).toBe(200);
  return { tripId, token: shareRes.body.token };
}

describe("trip guest identity binding", () => {
  it("join issues a guestToken scoped to the joining participant", async () => {
    const { token } = await makeSharedTrip("Gita A");
    const join = await request(app).post(`/api/trips/shared/${token}/join`).send({ nome: "Bob" });
    expect(join.status).toBe(201);
    expect(join.body.id).toBe("bob");
    expect(typeof join.body.guestToken).toBe("string");
  });

  it("expense creation requires a guestToken, ignoring an unauthenticated request", async () => {
    const { token } = await makeSharedTrip("Gita B");
    await request(app).post(`/api/trips/shared/${token}/join`).send({ nome: "Bob" });

    const res = await request(app).post(`/api/trips/shared/${token}/expenses`).send({
      importo: 50, pagatoDa: "bob", data: "2026-08-01",
    });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("GUEST_IDENTITY_REQUIRED");
  });

  it("a guest cannot log an expense as another participant by putting their id in pagatoDa", async () => {
    const { token } = await makeSharedTrip("Gita C");
    const bobJoin = await request(app).post(`/api/trips/shared/${token}/join`).send({ nome: "Bob" });
    await request(app).post(`/api/trips/shared/${token}/join`).send({ nome: "Alice" });

    // Bob's own guestToken, but the body claims Alice paid.
    const res = await request(app).post(`/api/trips/shared/${token}/expenses`).send({
      importo: 50, pagatoDa: "alice", data: "2026-08-01", guestToken: bobJoin.body.guestToken,
    });
    expect(res.status).toBe(201);
    expect(res.body.pagatoDa).toBe("bob"); // server derived it from the token, not the body
  });

  it("rejects a guestToken issued for a different trip", async () => {
    const tripA = await makeSharedTrip("Gita D1");
    const tripB = await makeSharedTrip("Gita D2");
    const joinA = await request(app).post(`/api/trips/shared/${tripA.token}/join`).send({ nome: "Carol" });

    const res = await request(app).post(`/api/trips/shared/${tripB.token}/expenses`).send({
      importo: 20, pagatoDa: "carol", data: "2026-08-01", guestToken: joinA.body.guestToken,
    });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("GUEST_IDENTITY_REQUIRED");
  });

  it("rejoining under the same name reissues a valid guestToken for that same participant", async () => {
    const { token } = await makeSharedTrip("Gita E");
    const first = await request(app).post(`/api/trips/shared/${token}/join`).send({ nome: "Dana" });
    const again = await request(app).post(`/api/trips/shared/${token}/join`).send({ nome: "Dana" });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    expect(typeof again.body.guestToken).toBe("string");

    const res = await request(app).post(`/api/trips/shared/${token}/expenses`).send({
      importo: 15, data: "2026-08-01", guestToken: again.body.guestToken,
    });
    expect(res.status).toBe(201);
    expect(res.body.pagatoDa).toBe("dana");
  });
});

describe("settled is a server-owned invariant, not a plain field", () => {
  it("PUT /api/trips/:id ignores an attempt to set settled directly", async () => {
    const tripRes = await agent.post("/api/trips").send({ nome: "Gita F", partecipanti: [{ id: "a", nome: "A" }] });
    const tripId = tripRes.body.id;

    const put = await agent.put(`/api/trips/${tripId}`).send({ settled: true });
    // No recognized field was actually changed (settled is not one), so
    // this is the same "nothing to update" rejection as any empty PUT.
    expect(put.status).toBe(400);
    expect(put.body.error.code).toBe("NO_FIELDS_TO_UPDATE");

    const list = await agent.get("/api/trips");
    const trip = list.body.find(t => t.id === tripId);
    expect(trip.settled).toBe(false);
  });

  it("POST /api/trips/:id/settle computes settlements server-side and inserts real settlement transactions", async () => {
    const tripRes = await agent.post("/api/trips").send({
      nome: "Gita G",
      partecipanti: [{ id: "a", nome: "A" }, { id: "b", nome: "B" }],
    });
    const tripId = tripRes.body.id;
    await agent.post(`/api/trips/${tripId}/expenses`).send({
      importo: 100, pagatoDa: "a", data: "2026-08-01",
      splits: [{ personaId: "a", quota: 50 }, { personaId: "b", quota: 50 }],
    });

    const settle = await agent.post(`/api/trips/${tripId}/settle`);
    expect(settle.status).toBe(200);
    expect(settle.body.settlements).toEqual([{ da: "b", a: "a", importo: 50 }]);

    const list = await agent.get("/api/trips");
    const trip = list.body.find(t => t.id === tripId);
    expect(trip.settled).toBe(true);

    const txs = await agent.get("/api/transactions");
    const leg = txs.body.transactions.find(t => t.categoria === "saldo_viaggio" && t.pagatoDa === "b" && t.ricevutoDa === "a");
    expect(leg).toBeTruthy();
    expect(leg.importo).toBe(50);
  });

  it("settling an already-settled trip is rejected, not silently re-run", async () => {
    const tripRes = await agent.post("/api/trips").send({ nome: "Gita H", partecipanti: [{ id: "a", nome: "A" }] });
    const tripId = tripRes.body.id;
    const first = await agent.post(`/api/trips/${tripId}/settle`);
    expect(first.status).toBe(200);

    const second = await agent.post(`/api/trips/${tripId}/settle`);
    expect(second.status).toBe(400);
    expect(second.body.error.code).toBe("TRIP_SETTLED");
  });

  it("a settled trip can never be reopened — no field or endpoint sets settled back to false", async () => {
    const tripRes = await agent.post("/api/trips").send({ nome: "Gita I", partecipanti: [{ id: "a", nome: "A" }] });
    const tripId = tripRes.body.id;
    await agent.post(`/api/trips/${tripId}/settle`);

    const reopen = await agent.put(`/api/trips/${tripId}`).send({ settled: false });
    expect(reopen.status).toBe(400);
    expect(reopen.body.error.code).toBe("NO_FIELDS_TO_UPDATE");

    const list = await agent.get("/api/trips");
    const trip = list.body.find(t => t.id === tripId);
    expect(trip.settled).toBe(true);
  });
});
