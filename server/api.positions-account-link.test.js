import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { startTestServer, stopTestServer } from "./testUtils.js";

// A position bought/sold "from" a household account should move money the
// same way a real purchase would: a linked expense/income transaction that
// keeps the account's balance and the portfolio's value consistent, kept in
// sync as the position is edited and reversed when it's deleted.

let app;
let agent;
let contoId;
let otherContoId;

beforeAll(async () => {
  app = await startTestServer();
  agent = request.agent(app);
  const reg = await agent
    .post("/api/auth/register")
    .send({ nome: "Positions Account Link Household", persone: ["Gabriele"], pin: "482917" });
  expect(reg.status).toBe(201);

  const acc1 = await agent.post("/api/accounts").send({ nome: "Conto Principale", saldoIniziale: 1000 });
  expect(acc1.status).toBe(201);
  contoId = acc1.body.id;

  const acc2 = await agent.post("/api/accounts").send({ nome: "Conto Secondario", saldoIniziale: 500 });
  expect(acc2.status).toBe(201);
  otherContoId = acc2.body.id;
}, 60000);

afterAll(async () => {
  await stopTestServer();
});

async function transactionsForAccount(id) {
  const res = await agent.get(`/api/transactions?contoId=${id}`);
  expect(res.status).toBe(200);
  return res.body.transactions;
}

describe("POST /api/positions with contoId", () => {
  it("rejects an unknown contoId", async () => {
    const res = await agent.post("/api/positions").send({ ticker: "AAPL", quantita: 1, prezzoAcquisto: 100, contoId: "000000000000000000000000" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("UNKNOWN_ACCOUNT");
  });

  it("a buy creates a linked expense transaction against the chosen account", async () => {
    const res = await agent.post("/api/positions").send({
      ticker: "VWCE", quantita: 10, prezzoAcquisto: 95.5, dataAcquisto: "2026-01-15", contoId, tipo: "buy",
    });
    expect(res.status).toBe(201);
    expect(res.body.contoId).toBe(contoId);
    expect(res.body.linkedTransactionId).toBeTruthy();

    const txs = await transactionsForAccount(contoId);
    const linked = txs.find(t => t.id === res.body.linkedTransactionId);
    expect(linked).toBeTruthy();
    expect(linked.tipo).toBe("uscita");
    expect(linked.categoria).toBe("investimenti");
    expect(linked.importo).toBeCloseTo(955, 5);
    expect(linked.positionId).toBe(res.body.id);
  });

  it("a sell creates a linked income transaction instead", async () => {
    const res = await agent.post("/api/positions").send({
      ticker: "VWCE", quantita: 2, prezzoAcquisto: 100, dataAcquisto: "2026-02-01", contoId, tipo: "sell",
    });
    expect(res.status).toBe(201);

    const txs = await transactionsForAccount(contoId);
    const linked = txs.find(t => t.id === res.body.linkedTransactionId);
    expect(linked.tipo).toBe("entrata");
    expect(linked.importo).toBeCloseTo(200, 5);
  });

  it("no contoId means no linked transaction, same as before this feature", async () => {
    const res = await agent.post("/api/positions").send({ ticker: "EUNL", quantita: 1, prezzoAcquisto: 80 });
    expect(res.status).toBe(201);
    expect(res.body.contoId).toBe(null);
    expect(res.body.linkedTransactionId).toBeUndefined();
  });
});

describe("PUT /api/positions/:id keeps the linked transaction in sync", () => {
  let positionId;
  let linkedTransactionId;

  it("adding a contoId to a position that didn't have one creates the link", async () => {
    const create = await agent.post("/api/positions").send({ ticker: "SWDA", quantita: 5, prezzoAcquisto: 70, dataAcquisto: "2026-03-01" });
    expect(create.status).toBe(201);
    positionId = create.body.id;
    expect(create.body.linkedTransactionId).toBeUndefined();

    const put = await agent.put(`/api/positions/${positionId}`).send({ contoId });
    expect(put.status).toBe(200);

    const txs = await transactionsForAccount(contoId);
    const linked = txs.find(t => t.positionId === positionId);
    expect(linked).toBeTruthy();
    expect(linked.importo).toBeCloseTo(350, 5);
    linkedTransactionId = linked.id;
  });

  it("changing quantita/prezzoAcquisto updates the linked transaction's amount, not a new one", async () => {
    const put = await agent.put(`/api/positions/${positionId}`).send({ quantita: 10 });
    expect(put.status).toBe(200);

    const txs = await transactionsForAccount(contoId);
    const matching = txs.filter(t => t.positionId === positionId);
    expect(matching.length).toBe(1);
    expect(matching[0].id).toBe(linkedTransactionId);
    expect(matching[0].importo).toBeCloseTo(700, 5);
  });

  it("moving contoId to a different account moves the same transaction, not a copy", async () => {
    const put = await agent.put(`/api/positions/${positionId}`).send({ contoId: otherContoId });
    expect(put.status).toBe(200);

    const oldAccountTxs = await transactionsForAccount(contoId);
    expect(oldAccountTxs.find(t => t.positionId === positionId)).toBeUndefined();

    const newAccountTxs = await transactionsForAccount(otherContoId);
    const moved = newAccountTxs.find(t => t.positionId === positionId);
    expect(moved).toBeTruthy();
    expect(moved.id).toBe(linkedTransactionId);
  });

  it("clearing contoId removes the linked transaction entirely", async () => {
    const put = await agent.put(`/api/positions/${positionId}`).send({ contoId: null });
    expect(put.status).toBe(200);

    const txs = await transactionsForAccount(otherContoId);
    expect(txs.find(t => t.positionId === positionId)).toBeUndefined();
  });

  it("a pure rename (no linked-transaction fields touched) still works with no contoId involved", async () => {
    const put = await agent.put(`/api/positions/${positionId}`).send({ ticker: "SWDA2" });
    expect(put.status).toBe(200);
  });
});

describe("DELETE /api/positions/:id reverses the linked transaction", () => {
  it("deleting a position with a linked transaction removes both", async () => {
    const create = await agent.post("/api/positions").send({ ticker: "IUSQ", quantita: 3, prezzoAcquisto: 50, dataAcquisto: "2026-04-01", contoId });
    expect(create.status).toBe(201);
    const positionId = create.body.id;
    const linkedTransactionId = create.body.linkedTransactionId;
    expect(linkedTransactionId).toBeTruthy();

    const del = await agent.delete(`/api/positions/${positionId}`);
    expect(del.status).toBe(200);

    const txs = await transactionsForAccount(contoId);
    expect(txs.find(t => t.id === linkedTransactionId)).toBeUndefined();
  });

  it("deleting a position with no linked transaction still works as before", async () => {
    const create = await agent.post("/api/positions").send({ ticker: "NOACC", quantita: 1, prezzoAcquisto: 10 });
    expect(create.status).toBe(201);
    const del = await agent.delete(`/api/positions/${create.body.id}`);
    expect(del.status).toBe(200);
    expect(del.body.deleted).toBe(true);
  });
});
