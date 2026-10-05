import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { startTestServer, stopTestServer } from "./testUtils.js";

// Regression: PUT /api/positions/prices used to delete EVERY manual price
// for the household first, then re-insert only whatever ticker(s) were in
// that one request's body. A save for one ticker — from a stale client
// snapshot (its initial GET still in flight or failed), or from a second
// household member on another device editing a different ticker — silently
// wiped out every other ticker's manual price, with no error anywhere.
// It's now a pure incremental upsert: a PUT only ever touches the
// ticker(s) it names. Clearing one ticker's override is a dedicated DELETE
// instead of "omit it from the next PUT".

let app;
let agent;

beforeAll(async () => {
  app = await startTestServer();
  agent = request.agent(app);
  const reg = await agent
    .post("/api/auth/register")
    .send({ nome: "Manual Prices Household", persone: ["Gabriele"], pin: "604831" });
  expect(reg.status).toBe(201);
}, 60000);

afterAll(async () => {
  await stopTestServer();
});

async function getManualPrices() {
  const res = await agent.get("/api/positions/prices");
  expect(res.status).toBe(200);
  return res.body.manualPrices;
}

describe("PUT /api/positions/prices", () => {
  it("setting a price for one ticker does not touch an already-saved price for another ticker", async () => {
    const first = await agent.put("/api/positions/prices").send({ manualPrices: { AAPL: 150 } });
    expect(first.status).toBe(200);

    // Simulates a second, independent save (another device, or a client
    // whose local snapshot never had AAPL in it) — only mentions VWCE.
    const second = await agent.put("/api/positions/prices").send({ manualPrices: { VWCE: 95.5 } });
    expect(second.status).toBe(200);

    const prices = await getManualPrices();
    expect(prices.AAPL).toBe(150);
    expect(prices.VWCE).toBe(95.5);
  });

  it("updates an existing ticker's price in place without affecting others", async () => {
    const update = await agent.put("/api/positions/prices").send({ manualPrices: { AAPL: 160 } });
    expect(update.status).toBe(200);

    const prices = await getManualPrices();
    expect(prices.AAPL).toBe(160);
    expect(prices.VWCE).toBe(95.5); // untouched by an update to a different ticker
  });

  it("can set several tickers in one request without affecting previously-saved ones", async () => {
    const res = await agent.put("/api/positions/prices").send({ manualPrices: { MSFT: 300, GOOG: 140 } });
    expect(res.status).toBe(200);

    const prices = await getManualPrices();
    expect(prices.MSFT).toBe(300);
    expect(prices.GOOG).toBe(140);
    expect(prices.AAPL).toBe(160);
    expect(prices.VWCE).toBe(95.5);
  });

  // Each ticker is upserted independently now (no transaction wrapping the
  // batch — see server/routes/positions.js) — a malformed entry elsewhere
  // in the same request must not stop a valid one in that request from
  // being saved.
  it("applies the valid ticker in a batch even when another entry in the same request is invalid", async () => {
    const res = await agent.put("/api/positions/prices").send({ manualPrices: { TSLA: 220, BAD: -5 } });
    expect(res.status).toBe(200);

    const prices = await getManualPrices();
    expect(prices.TSLA).toBe(220);
    expect(prices.BAD).toBeUndefined(); // negative price, skipped
  });
});

describe("DELETE /api/positions/prices/:ticker", () => {
  it("removes only the targeted ticker's manual price", async () => {
    const del = await agent.delete("/api/positions/prices/MSFT");
    expect(del.status).toBe(200);

    const prices = await getManualPrices();
    expect(prices.MSFT).toBeUndefined();
    // Everything else stays exactly as it was.
    expect(prices.GOOG).toBe(140);
    expect(prices.AAPL).toBe(160);
    expect(prices.VWCE).toBe(95.5);
  });

  it("is a no-op (still 200) when the ticker has no manual price set", async () => {
    const del = await agent.delete("/api/positions/prices/NOPE");
    expect(del.status).toBe(200);
  });

  it("rejects a malformed ticker", async () => {
    const del = await agent.delete("/api/positions/prices/not%20a%20ticker!!");
    expect(del.status).toBe(400);
  });
});
