import { describe, it, expect } from "vitest";
import { buildSettlementTransaction } from "./debtService.js";

const genId = () => "settle-id";
const debt = { da: "l", a: "g", importo: 50 };

describe("buildSettlementTransaction", () => {
  it("defaults to the full debt amount on empty input", () => {
    const tx = buildSettlementTransaction(debt, "", { generaId: genId, recipientName: "Gabriele" });
    expect(tx.importo).toBe(50);
  });

  it("defaults to the full debt amount on invalid input", () => {
    const tx = buildSettlementTransaction(debt, "abc", { generaId: genId, recipientName: "Gabriele" });
    expect(tx.importo).toBe(50);
  });

  it("defaults to the full debt amount on zero or negative input", () => {
    expect(buildSettlementTransaction(debt, "0", { generaId: genId, recipientName: "Gabriele" }).importo).toBe(50);
    expect(buildSettlementTransaction(debt, "-5", { generaId: genId, recipientName: "Gabriele" }).importo).toBe(50);
  });

  it("accepts a valid partial amount", () => {
    const tx = buildSettlementTransaction(debt, "20", { generaId: genId, recipientName: "Gabriele" });
    expect(tx.importo).toBe(20);
  });

  it("handles comma decimal input", () => {
    const tx = buildSettlementTransaction(debt, "20,5", { generaId: genId, recipientName: "Gabriele" });
    expect(tx.importo).toBe(20.5);
  });

  it("clamps an overpayment to the debt amount", () => {
    const tx = buildSettlementTransaction(debt, "999", { generaId: genId, recipientName: "Gabriele" });
    expect(tx.importo).toBe(50);
  });

  it("builds a saldo transaction with the right participants", () => {
    const tx = buildSettlementTransaction(debt, "50", { generaId: genId, recipientName: "Gabriele" });
    expect(tx).toMatchObject({ id: "settle-id", tipo: "saldo", pagatoDa: "l", ricevutoDa: "g", descrizione: "Saldo debito → Gabriele" });
  });
});
