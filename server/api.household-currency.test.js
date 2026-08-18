import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { startTestServer, stopTestServer } from "./testUtils.js";

// Regression coverage for the base-currency data-corruption bug: every
// financial amount (transactions, accounts, goals, trip expenses) is a bare
// number with no per-record currency marker — the household's valutaBase is
// the only thing that says what it means. Changing it after data exists
// would silently reinterpret old amounts as the new currency instead of
// converting them.

let app;
let agent;

beforeAll(async () => {
  app = await startTestServer();
  agent = request.agent(app);
  const reg = await agent
    .post("/api/auth/register")
    .send({ nome: "Currency Lock Household", persone: ["Gabriele"], pin: "638214" });
  expect(reg.status).toBe(201);
  await agent.post("/api/auth/login").send({ pin: "638214" });
}, 60000);

afterAll(async () => {
  await stopTestServer();
});

describe("PUT /api/household/valuta", () => {
  it("allows changing base currency while the household has no financial data yet", async () => {
    const res = await agent.put("/api/household/valuta").send({ valutaBase: "USD" });
    expect(res.status).toBe(200);
    expect(res.body.valutaBase).toBe("USD");
  });

  it("locks the currency once a transaction exists", async () => {
    const tx = await agent.post("/api/transactions").send({ tipo: "uscita", importo: 42, data: "2026-08-01" });
    expect(tx.status).toBe(201);

    const res = await agent.put("/api/household/valuta").send({ valutaBase: "JPY" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CURRENCY_LOCKED");

    // Unchanged in the database.
    const household = await agent.get("/api/household");
    expect(household.body.valutaBase).toBe("USD");
  });

  it("still allows a no-op 'change' to the same currency once locked", async () => {
    const res = await agent.put("/api/household/valuta").send({ valutaBase: "USD" });
    expect(res.status).toBe(200);
    expect(res.body.valutaBase).toBe("USD");
  });

  it("also locks on an account, a goal, or a trip expense alone (not just transactions)", async () => {
    const reg2 = await request(app).post("/api/auth/register")
      .send({ nome: "Currency Lock Household 2", persone: ["Laura"], pin: "298157" });
    const agent2 = request.agent(app);
    await agent2.post("/api/auth/login").send({ pin: "298157" });

    const acc = await agent2.post("/api/accounts").send({ nome: "Conto" });
    expect(acc.status).toBe(201);

    const res = await agent2.put("/api/household/valuta").send({ valutaBase: "GBP" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CURRENCY_LOCKED");
    expect(reg2.status).toBe(201);
  });
});
