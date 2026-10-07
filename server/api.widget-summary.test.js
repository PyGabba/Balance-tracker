import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { startTestServer, stopTestServer } from "./testUtils.js";

// The widget summary's "vs last month" and "coming up" fields, which mirror
// the app dashboard (services/dashboardService.js).

let app, agent, key;
const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const now = new Date();
const thisMonthDay1 = iso(new Date(now.getFullYear(), now.getMonth(), 1));
const prevMonthDay1 = iso(new Date(now.getFullYear(), now.getMonth() - 1, 1));
const inDays = (n) => iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + n));

beforeAll(async () => {
  app = await startTestServer();
  agent = request.agent(app);
  const reg = await agent.post("/api/auth/register").send({ nome: "Widget Summary Household", persone: ["Gabriele"], pin: "552817" });
  expect(reg.status).toBe(201);
  key = (await agent.post("/api/widget-key")).body.key;
  expect(key).toBeTruthy();
}, 60000);

afterAll(async () => { await stopTestServer(); });

const post = (body) => agent.post("/api/transactions").send({ tipo: "uscita", categoria: "cibo", ...body });

describe("GET /api/widget — vs last month and coming up", () => {
  it("a household with no history: nothing to compare, nothing coming up", async () => {
    const res = await request(app).get(`/api/widget?key=${key}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ speseMese: 0, speseMesePrec: 0, deltaPct: null, inArrivo: [], inArrivoTotale: 0 });
  });

  it("compares this month with last month through the same day, and lists due recurring bills", async () => {
    expect((await post({ importo: 150, data: thisMonthDay1 })).status).toBe(201);
    // Last month, day 1 — always inside the "same period" window.
    expect((await post({ importo: 100, data: prevMonthDay1 })).status).toBe(201);
    // Soon, in a month after the same-period cut-off: day 31 may not exist,
    // so use the last day of last month only when today is already past it.
    expect((await post({
      importo: 800, categoria: "casa", descrizione: "Affitto", data: prevMonthDay1,
      ricorrenza: { frequenza: "mensile", prossimaData: inDays(3), variabile: false },
    })).status).toBe(201);
    expect((await post({
      importo: 10, descrizione: "Lontano", data: prevMonthDay1,
      ricorrenza: { frequenza: "mensile", prossimaData: inDays(45), variabile: false },
    })).status).toBe(201);

    const res = await request(app).get(`/api/widget?key=${key}`);
    expect(res.status).toBe(200);
    // This month: 150 (+ the 800 rent template's own first row is dated last month).
    expect(res.body.speseMese).toBe(150);
    // Last month, same period: the 100 expense + the 800 and 10 template rows (all dated day 1).
    expect(res.body.speseMesePrec).toBe(910);
    expect(res.body.deltaPct).toBe(Math.round(((150 - 910) / 910) * 100));
    expect(res.body.inArrivoTotale).toBe(1); // the 45-days-out one is beyond the 30-day horizon
    expect(res.body.inArrivo).toEqual([expect.objectContaining({ descrizione: "Affitto", categoria: "casa", days: 3, importo: 800, variabile: false })]);
    expect(typeof res.body.inArrivo[0].emoji).toBe("string");
  });

  it("income and settlements don't count as spending, trashed expenses don't count either", async () => {
    const before = (await request(app).get(`/api/widget?key=${key}`)).body.speseMese;
    await agent.post("/api/transactions").send({ tipo: "entrata", categoria: "entrata", importo: 999, data: thisMonthDay1 });
    const trashed = await post({ importo: 77, data: thisMonthDay1 });
    await agent.delete(`/api/transactions/${trashed.body.id}`);
    expect((await request(app).get(`/api/widget?key=${key}`)).body.speseMese).toBe(before);
  });
});
