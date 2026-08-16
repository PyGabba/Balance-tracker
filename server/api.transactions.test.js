import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import request from "supertest";
import { startTestServer, stopTestServer } from "./testUtils.js";
import { calcolaSaldiConti } from "../src/lib/finance.js";

let app;
let agent;
let householdPersone;

beforeAll(async () => {
  app = await startTestServer();
  agent = request.agent(app);

  // Only ONE registration in this whole file (registerLimiter caps at
  // 5/hour) — every test below shares this household and creates its own
  // accounts/transactions to stay isolated from other tests.
  // Explicit distinct emails on every register() call in this file — see the
  // "email: null sparse index collision" bug documented in api.auth.test.js;
  // without one, the second household registered below (cross-household
  // authorization test) would fail with a spurious 409.
  const reg = await agent
    .post("/api/auth/register")
    .send({ nome: "Test Household Tx", persone: ["Gabriele", "Laura"], pin: "739284", email: "tx-test-1@example.com" });
  expect(reg.status).toBe(201);
  householdPersone = reg.body.persone; // [{id:'gabriele',...}, {id:'laura',...}]

  // Explicit login too, matching the "register -> login -> ..." scenario
  // literally, even though register itself already sets a session cookie.
  const login = await agent.post("/api/auth/login").send({ pin: "739284" });
  expect(login.status).toBe(200);
}, 60000);

afterAll(async () => {
  await stopTestServer();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const gabrieleId = () => householdPersone.find(p => p.nome === "Gabriele").id;
const lauraId = () => householdPersone.find(p => p.nome === "Laura").id;

describe("critical scenario: create account -> create transaction -> calculate balance", () => {
  it("computes the right balance after an expense", async () => {
    const accRes = await agent.post("/api/accounts").send({ nome: "Conto Corrente", saldoIniziale: 100 });
    expect(accRes.status).toBe(201);
    const accountId = accRes.body.id;

    const txRes = await agent.post("/api/transactions").send({
      tipo: "uscita", importo: 30, data: "2026-03-01",
      pagatoDa: gabrieleId(), contoId: accountId,
      splits: [{ personaId: gabrieleId(), quota: 50 }, { personaId: lauraId(), quota: 50 }],
      categoria: "cibo", descrizione: "Spesa",
    });
    expect(txRes.status).toBe(201);

    const txListRes = await agent.get("/api/transactions").query({ contoId: accountId });
    expect(txListRes.status).toBe(200);

    const saldi = calcolaSaldiConti(
      [{ id: accountId, saldoIniziale: 100 }],
      txListRes.body.transactions
    );
    expect(saldi[accountId]).toBe(70);
  });
});

describe("idempotency (MOD-004)", () => {
  it("the same Idempotency-Key sent twice creates exactly one transaction", async () => {
    const key = "idem-test-key-1";
    const payload = { tipo: "uscita", importo: 15, data: "2026-03-02", categoria: "altro", descrizione: "Idempotent" };

    const first = await agent.post("/api/transactions").set("Idempotency-Key", key).send(payload);
    expect(first.status).toBe(201);
    const second = await agent.post("/api/transactions").set("Idempotency-Key", key).send(payload);
    expect(second.status).toBe(201);
    expect(second.body.id).toBe(first.body.id); // replayed, not a new entity

    const all = await agent.get("/api/transactions").query({ categoria: "altro" });
    const matching = all.body.transactions.filter(t => t.descrizione === "Idempotent");
    expect(matching).toHaveLength(1);
  });
});

describe("participant/account validation", () => {
  it("rejects a transaction referencing an unknown participant", async () => {
    const res = await agent.post("/api/transactions").send({
      tipo: "uscita", importo: 10, data: "2026-03-01", pagatoDa: "mallory",
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("UNKNOWN_PARTICIPANT");
  });

  it("rejects a transaction referencing an unknown account", async () => {
    const res = await agent.post("/api/transactions").send({
      tipo: "uscita", importo: 10, data: "2026-03-01", contoId: "000000000000000000000000",
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("UNKNOWN_ACCOUNT");
  });

  it("rejects a transfer between an unknown account and a real one", async () => {
    const accRes = await agent.post("/api/accounts").send({ nome: "Conto Trasferimenti", saldoIniziale: 0 });
    const res = await agent.post("/api/transactions").send({
      tipo: "trasferimento", importo: 10, data: "2026-03-01",
      contoDa: accRes.body.id, contoA: "000000000000000000000000",
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("UNKNOWN_ACCOUNT");
  });
});

describe("amount validation", () => {
  it.each([
    ["zero", 0],
    ["negative", -5],
    ["NaN", "NaN"],
    ["Infinity", "Infinity"],
  ])("rejects a %s amount", async (_label, importo) => {
    const res = await agent.post("/api/transactions").send({ tipo: "uscita", importo, data: "2026-03-01" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_AMOUNT");
  });
});

describe("split validation", () => {
  it("rejects an invalid split total (40+40)", async () => {
    const res = await agent.post("/api/transactions").send({
      tipo: "uscita", importo: 10, data: "2026-03-01", pagatoDa: gabrieleId(),
      splits: [{ personaId: gabrieleId(), quota: 40 }, { personaId: lauraId(), quota: 40 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("SPLIT_TOTAL_NOT_100");
  });

  it("accepts a valid 50/50 split total", async () => {
    const res = await agent.post("/api/transactions").send({
      tipo: "uscita", importo: 10, data: "2026-03-01", pagatoDa: gabrieleId(),
      splits: [{ personaId: gabrieleId(), quota: 50 }, { personaId: lauraId(), quota: 50 }],
    });
    expect(res.status).toBe(201);
  });

  it("accepts a 33.33/33.33/33.34 split within tolerance (extra guest participant)", async () => {
    const res = await agent.post("/api/transactions").send({
      tipo: "uscita", importo: 30, data: "2026-03-01", pagatoDa: gabrieleId(),
      extraPersone: [{ id: "ospite", nome: "Ospite" }],
      splits: [
        { personaId: gabrieleId(), quota: 33.33 },
        { personaId: lauraId(), quota: 33.33 },
        { personaId: "ospite", quota: 33.34 },
      ],
    });
    expect(res.status).toBe(201);
  });
});

describe("currency conversion (MOD-005)", () => {
  it("returns a conversion-unavailable error, not a silent 1:1, when the rate provider is unreachable and there's no cache", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    const res = await agent.post("/api/transactions").send({
      tipo: "uscita", importo: 10, data: "2026-03-01", valuta: "XYZ",
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("EXCHANGE_RATE_UNAVAILABLE");
  });
});

describe("cross-household authorization (MOD-009)", () => {
  it("cannot reference another household's account by guessing its id", async () => {
    const otherAgent = request.agent(app);
    const other = await otherAgent
      .post("/api/auth/register")
      .send({ nome: "Other Household Tx", persone: ["Marco"], pin: "601827", email: "tx-test-2@example.com" });
    expect(other.status).toBe(201);
    const otherAccount = await otherAgent.post("/api/accounts").send({ nome: "Loro Conto", saldoIniziale: 500 });
    expect(otherAccount.status).toBe(201);

    // Household under test tries to spend against the OTHER household's real account id.
    const res = await agent.post("/api/transactions").send({
      tipo: "uscita", importo: 10, data: "2026-03-01", contoId: otherAccount.body.id,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("UNKNOWN_ACCOUNT");
  });
});
