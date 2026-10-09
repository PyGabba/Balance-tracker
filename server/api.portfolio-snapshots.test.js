import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { startTestServer, stopTestServer, getDb } from "./testUtils.js";

// Weekly portfolio snapshots: the real values the portfolio chart plots,
// saved the first time prices are refreshed each week (weeks start Sunday).

let app, agentA, agentB;
const iso = (d) => d.toISOString().slice(0, 10);
const utcDay = (offset = 0) => { const d = new Date(); d.setUTCHours(12, 0, 0, 0); d.setUTCDate(d.getUTCDate() + offset); return d; };
const sundayOnOrBefore = (d) => { const s = new Date(d); s.setUTCDate(s.getUTCDate() - s.getUTCDay()); return s; };

const thisSunday = sundayOnOrBefore(utcDay());
const lastSunday = sundayOnOrBefore(utcDay(-7));
const snapshot = (over = {}) => ({
  weekKey: iso(thisSunday), date: iso(utcDay()), valore: 2250, investito: 2000,
  holdings: [{ ticker: "VWCE", quantita: 10, prezzo: 120 }, { ticker: "AAPL", quantita: 5, prezzo: 210 }],
  ...over,
});

beforeAll(async () => {
  app = await startTestServer();
  agentA = request.agent(app);
  agentB = request.agent(app);
  expect((await agentA.post("/api/auth/register").send({ nome: "Snapshots A", persone: ["Gabriele"], pin: "731904" })).status).toBe(201);
  expect((await agentB.post("/api/auth/register").send({ nome: "Snapshots B", persone: ["Laura"], pin: "264813" })).status).toBe(201);
}, 60000);

afterAll(async () => { await stopTestServer(); });

describe("POST/GET /api/portfolio/snapshots", () => {
  it("starts empty", async () => {
    const res = await agentA.get("/api/portfolio/snapshots");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("the first save of a week creates the snapshot", async () => {
    const res = await agentA.post("/api/portfolio/snapshots").send(snapshot());
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ created: true, weekKey: iso(thisSunday) });
  });

  it("a second save in the same week is a no-op: the first one wins", async () => {
    const res = await agentA.post("/api/portfolio/snapshots").send(snapshot({ valore: 9999 }));
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(false);
    const list = (await agentA.get("/api/portfolio/snapshots")).body;
    expect(list).toHaveLength(1);
    expect(list[0].valore).toBe(2250);
  });

  it("another week adds a second point; the list is oldest first and exposes no internals", async () => {
    const date = iso(new Date(lastSunday.getTime() + 3 * 86400000)); // the Wednesday of last week
    const res = await agentA.post("/api/portfolio/snapshots").send(snapshot({ weekKey: iso(lastSunday), date, valore: 2100, investito: 2000 }));
    expect(res.status).toBe(201);
    const list = (await agentA.get("/api/portfolio/snapshots")).body;
    expect(list.map(s => s.weekKey)).toEqual([iso(lastSunday), iso(thisSunday)]);
    expect(list[0]).toEqual({
      weekKey: iso(lastSunday), date, valore: 2100, investito: 2000,
      holdings: expect.any(Array), createdAt: expect.any(String),
    });
    expect(list[0]).not.toHaveProperty("_id");
    expect(list[0]).not.toHaveProperty("householdId");
  });

  it("rejects a week that doesn't start on Sunday, a date outside the week, and bad amounts/holdings", async () => {
    const monday = iso(new Date(thisSunday.getTime() + 86400000));
    expect((await agentA.post("/api/portfolio/snapshots").send(snapshot({ weekKey: monday }))).body.error.code).toBe("INVALID_SNAPSHOT_WEEK");
    expect((await agentA.post("/api/portfolio/snapshots").send(snapshot({ date: iso(new Date(thisSunday.getTime() - 86400000)) }))).body.error.code).toBe("INVALID_SNAPSHOT_DATE");
    expect((await agentA.post("/api/portfolio/snapshots").send(snapshot({ valore: -1 }))).status).toBe(400);
    expect((await agentA.post("/api/portfolio/snapshots").send(snapshot({ holdings: [] }))).body.error.code).toBe("INVALID_SNAPSHOT_HOLDINGS");
    expect((await agentA.post("/api/portfolio/snapshots").send(snapshot({ holdings: [{ ticker: "X Y", quantita: 1, prezzo: 1 }] }))).status).toBe(400);
  });

  it("requires a login", async () => {
    expect((await request(app).get("/api/portfolio/snapshots")).status).toBe(401);
    expect((await request(app).post("/api/portfolio/snapshots").send(snapshot())).status).toBe(401);
  });

  it("households are isolated: B sees none of A's snapshots and can save the same week", async () => {
    expect((await agentB.get("/api/portfolio/snapshots")).body).toEqual([]);
    const res = await agentB.post("/api/portfolio/snapshots").send(snapshot({ valore: 500, investito: 400 }));
    expect(res.status).toBe(201);
    expect((await agentA.get("/api/portfolio/snapshots")).body.find(s => s.weekKey === iso(thisSunday)).valore).toBe(2250);
  });
});

describe("snapshots in backup / restore / delete", () => {
  it("a backup carries the snapshots and restoring them is additive (an existing week keeps its value)", async () => {
    const backup = (await agentA.get("/api/backup")).body;
    expect(backup.portfolioSnapshots.map(s => s.weekKey)).toEqual([iso(lastSunday), iso(thisSunday)]);
    const restored = await agentB.post("/api/backup/restore").send(backup);
    expect(restored.status).toBe(200);
    expect(restored.body.counts.portfolioSnapshots).toBe(1); // last week is new; this week B already had
    const list = (await agentB.get("/api/portfolio/snapshots")).body;
    expect(list.map(s => s.weekKey)).toEqual([iso(lastSunday), iso(thisSunday)]);
    expect(list.find(s => s.weekKey === iso(thisSunday)).valore).toBe(500); // B's own, not overwritten
  });

  it("deleting the household deletes its snapshots", async () => {
    const del = await agentB.delete("/api/auth/household").send({ pin: "264813" });
    expect(del.status).toBe(200);
    const left = await getDb().collection("portfolio_snapshots").find({ householdId: { $exists: true } }).toArray();
    expect(left.every(s => s.valore !== 500)).toBe(true);
    expect(await getDb().collection("portfolio_snapshots").countDocuments({ valore: 500 })).toBe(0);
  });
});
