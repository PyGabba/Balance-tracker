import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { startTestServer, stopTestServer } from "./testUtils.js";

// Regression: positions and goals used bare parseFloat() with no
// Number.isFinite/enum discipline (unlike the transaction validator), so
// "abc" (→ NaN), "Infinity", or an unrecognized tipo/contributionType could
// reach storage and contaminate every portfolio/goal aggregate downstream.

let app;
let agent;

beforeAll(async () => {
  app = await startTestServer();
  agent = request.agent(app);
  const reg = await agent
    .post("/api/auth/register")
    .send({ nome: "Positions Goals Validation Household", persone: ["Gabriele"], pin: "593814" });
  expect(reg.status).toBe(201);
}, 60000);

afterAll(async () => {
  await stopTestServer();
});

describe("POST /api/positions", () => {
  it("rejects a non-numeric quantita", async () => {
    const res = await agent.post("/api/positions").send({ ticker: "AAPL", quantita: "abc", prezzoAcquisto: 100 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_FIELD");
  });

  it("rejects Infinity as prezzoAcquisto", async () => {
    const res = await agent.post("/api/positions").send({ ticker: "AAPL", quantita: 1, prezzoAcquisto: "Infinity" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_FIELD");
  });

  it("rejects zero or negative quantita", async () => {
    const zero = await agent.post("/api/positions").send({ ticker: "AAPL", quantita: 0, prezzoAcquisto: 100 });
    expect(zero.status).toBe(400);
    const neg = await agent.post("/api/positions").send({ ticker: "AAPL", quantita: -5, prezzoAcquisto: 100 });
    expect(neg.status).toBe(400);
  });

  it("rejects an unrecognized tipo", async () => {
    const res = await agent.post("/api/positions").send({ ticker: "AAPL", quantita: 1, prezzoAcquisto: 100, tipo: "banana" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_FIELD");
  });

  it("accepts a valid position and preserves a high-precision price unrounded", async () => {
    const res = await agent.post("/api/positions").send({ ticker: "BTC", quantita: 0.00012345, prezzoAcquisto: 43210.987654, tipo: "buy" });
    expect(res.status).toBe(201);
    expect(res.body.quantita).toBe(0.00012345);
    expect(res.body.prezzoAcquisto).toBe(43210.987654); // not rounded to 2dp
  });
});

describe("POST /api/goals", () => {
  it("rejects a non-numeric targetAmount", async () => {
    const res = await agent.post("/api/goals").send({ nome: "Vacanza", targetAmount: "abc" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_FIELD");
  });

  it("rejects Infinity as targetAmount", async () => {
    const res = await agent.post("/api/goals").send({ nome: "Vacanza", targetAmount: "Infinity" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_FIELD");
  });

  it("rejects a negative currentAmount", async () => {
    const res = await agent.post("/api/goals").send({ nome: "Vacanza", targetAmount: 1000, currentAmount: -1 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_FIELD");
  });

  it("accepts currentAmount of exactly zero (a goal that hasn't started)", async () => {
    const res = await agent.post("/api/goals").send({ nome: "Vacanza", targetAmount: 1000, currentAmount: 0 });
    expect(res.status).toBe(201);
    expect(res.body.currentAmount).toBe(0);
  });

  it("rejects an unrecognized contributionType", async () => {
    const res = await agent.post("/api/goals").send({ nome: "Vacanza", targetAmount: 1000, contributionType: "bogus" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_FIELD");
  });

  it("PUT rejects NaN/Infinity on update the same way create does", async () => {
    const create = await agent.post("/api/goals").send({ nome: "Auto nuova", targetAmount: 5000 });
    expect(create.status).toBe(201);
    const goalId = create.body.id;

    const nan = await agent.put(`/api/goals/${goalId}`).send({ targetAmount: "not-a-number" });
    expect(nan.status).toBe(400);
    expect(nan.body.error.code).toBe("INVALID_FIELD");

    const inf = await agent.put(`/api/goals/${goalId}`).send({ currentAmount: "Infinity" });
    expect(inf.status).toBe(400);
    expect(inf.body.error.code).toBe("INVALID_FIELD");
  });
});
