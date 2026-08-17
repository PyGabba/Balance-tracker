// ─── Debt-settlement domain logic (MOD-013) ───
// The matrix calculation itself is lib/finance.js (already pure); this
// module adds the settlement-transaction builder used when a user records
// a payment against a debt, so the amount-clamping rule is testable
// without rendering the DebtSummary component.

export { calcolaDebitiMatrix as computeDebtMatrix } from "../lib/finance.js";

import { roundAmount } from "../lib/money.js";

// rawAmountInput is whatever the user typed (string, possibly comma
// decimal, possibly empty/invalid) — falls back to the full debt amount,
// and is always clamped to it (can't "overpay" a recorded debt).
export function buildSettlementTransaction(debt, rawAmountInput, { generaId, recipientName }) {
  const parsed = parseFloat(String(rawAmountInput).replace(",", "."));
  const amount = Number.isNaN(parsed) || parsed <= 0 ? debt.importo : Math.min(parsed, debt.importo);
  return {
    id: generaId(),
    tipo: "saldo",
    importo: roundAmount(amount),
    descrizione: `Saldo debito → ${recipientName}`,
    data: new Date().toISOString().slice(0, 10),
    pagatoDa: debt.da,
    ricevutoDa: debt.a,
  };
}
