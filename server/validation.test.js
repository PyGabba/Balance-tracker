import { describe, it, expect } from "vitest";
import {
  validateAmount,
  validateDateStr,
  validateType,
  validateSplits,
  computeValidSplits,
  validateTransactionInput,
  ValidationError,
} from "./validation.js";

const householdPersonIds = ["g", "l"];
const accountIds = new Set(["acc1", "acc2"]);

describe("validateAmount", () => {
  it("accepts a normal positive amount", () => {
    expect(validateAmount(12.5)).toBe(12.5);
  });
  it("accepts numeric strings", () => {
    expect(validateAmount("42")).toBe(42);
  });
  it("rounds to cents to avoid float noise", () => {
    expect(validateAmount(0.1 + 0.2)).toBe(0.3);
  });
  it("rejects zero", () => {
    expect(() => validateAmount(0)).toThrow(ValidationError);
  });
  it("rejects negative amounts", () => {
    expect(() => validateAmount(-5)).toThrow(ValidationError);
  });
  it("rejects NaN", () => {
    expect(() => validateAmount(NaN)).toThrow(ValidationError);
  });
  it("rejects Infinity", () => {
    expect(() => validateAmount(Infinity)).toThrow(ValidationError);
  });
  it("rejects malformed strings", () => {
    expect(() => validateAmount("abc")).toThrow(ValidationError);
  });
  it("rejects missing amount", () => {
    expect(() => validateAmount(undefined)).toThrow(ValidationError);
  });
});

describe("validateDateStr", () => {
  it("accepts a valid date", () => {
    expect(validateDateStr("2026-03-15")).toBe("2026-03-15");
  });
  it("rejects malformed strings", () => {
    expect(() => validateDateStr("15/03/2026")).toThrow(ValidationError);
  });
  it("rejects calendar-impossible dates", () => {
    expect(() => validateDateStr("2026-02-30")).toThrow(ValidationError);
  });
  it("rejects non-strings", () => {
    expect(() => validateDateStr(20260315)).toThrow(ValidationError);
  });
  it("rejects missing date", () => {
    expect(() => validateDateStr(undefined)).toThrow(ValidationError);
  });
});

describe("validateType", () => {
  it("accepts allow-listed types", () => {
    expect(validateType("uscita")).toBe("uscita");
    expect(validateType("entrata")).toBe("entrata");
    expect(validateType("saldo")).toBe("saldo");
    expect(validateType("trasferimento")).toBe("trasferimento");
  });
  it("rejects unknown types", () => {
    expect(() => validateType("bonifico")).toThrow(ValidationError);
  });
  it("rejects missing type", () => {
    expect(() => validateType(undefined)).toThrow(ValidationError);
  });
});

describe("validateSplits / computeValidSplits", () => {
  const ids = new Set(["g", "l"]);

  it("accepts a clean 50/50 split", () => {
    const out = validateSplits([{ personaId: "g", quota: 50 }, { personaId: "l", quota: 50 }], ids);
    expect(out).toEqual([{ personaId: "g", quota: 50 }, { personaId: "l", quota: 50 }]);
  });

  it("accepts 33.33/33.33/33.34 within tolerance", () => {
    const threeIds = new Set(["g", "l", "m"]);
    const out = validateSplits(
      [{ personaId: "g", quota: 33.33 }, { personaId: "l", quota: 33.33 }, { personaId: "m", quota: 33.34 }],
      threeIds
    );
    expect(out.reduce((s, x) => s + x.quota, 0)).toBeCloseTo(100);
  });

  it("rejects 40+40 instead of silently normalizing to 50/50", () => {
    expect(() => validateSplits([{ personaId: "g", quota: 40 }, { personaId: "l", quota: 40 }], ids))
      .toThrow(ValidationError);
  });

  it("rejects a participant outside the known set", () => {
    expect(() => validateSplits([{ personaId: "g", quota: 50 }, { personaId: "mallory", quota: 50 }], ids))
      .toThrow(ValidationError);
  });

  it("rejects a negative quota", () => {
    expect(() => validateSplits([{ personaId: "g", quota: -10 }, { personaId: "l", quota: 110 }], ids))
      .toThrow(ValidationError);
  });

  it("rejects a quota over 100", () => {
    expect(() => validateSplits([{ personaId: "g", quota: 150 }], new Set(["g"])))
      .toThrow(ValidationError);
  });

  it("rejects duplicate participants", () => {
    expect(() => validateSplits([{ personaId: "g", quota: 50 }, { personaId: "g", quota: 50 }], ids))
      .toThrow(ValidationError);
  });

  it("rejects an empty splits array", () => {
    expect(() => validateSplits([], ids)).toThrow(ValidationError);
  });

  it("passes null through unchanged (no splits on this transaction)", () => {
    expect(validateSplits(null, ids)).toBeNull();
  });

  it("computeValidSplits returns null instead of throwing on bad input", () => {
    expect(computeValidSplits([{ personaId: "g", quota: 40 }, { personaId: "l", quota: 40 }], ids)).toBeNull();
    expect(computeValidSplits([{ personaId: "g", quota: 50 }, { personaId: "l", quota: 50 }], ids)).toEqual([
      { personaId: "g", quota: 50 }, { personaId: "l", quota: 50 },
    ]);
  });
});

describe("validateTransactionInput — full (POST) validation", () => {
  const base = { householdPersonIds, accountIds };

  it("accepts a well-formed expense", () => {
    const doc = validateTransactionInput({
      tipo: "uscita", importo: 42, data: "2026-03-01",
      pagatoDa: "g", splits: [{ personaId: "g", quota: 50 }, { personaId: "l", quota: 50 }],
      categoria: "cibo", descrizione: "Spesa",
    }, base);
    expect(doc.tipo).toBe("uscita");
    expect(doc.importo).toBe(42);
    expect(doc.pagatoDa).toBe("g");
    expect(doc.splits).toHaveLength(2);
  });

  it("rejects a participant outside the household in pagatoDa", () => {
    expect(() => validateTransactionInput({
      tipo: "uscita", importo: 10, data: "2026-03-01", pagatoDa: "mallory",
    }, base)).toThrow(ValidationError);
  });

  it("rejects an account outside the household", () => {
    expect(() => validateTransactionInput({
      tipo: "uscita", importo: 10, data: "2026-03-01", contoId: "not-mine",
    }, base)).toThrow(ValidationError);
  });

  it("accepts a transfer between two known accounts", () => {
    const doc = validateTransactionInput({
      tipo: "trasferimento", importo: 10, data: "2026-03-01", contoDa: "acc1", contoA: "acc2",
    }, base);
    expect(doc.contoDa).toBe("acc1");
    expect(doc.contoA).toBe("acc2");
  });

  it("rejects a transfer with the same source and destination account", () => {
    expect(() => validateTransactionInput({
      tipo: "trasferimento", importo: 10, data: "2026-03-01", contoDa: "acc1", contoA: "acc1",
    }, base)).toThrow(ValidationError);
  });

  it("rejects a transfer missing an account", () => {
    expect(() => validateTransactionInput({
      tipo: "trasferimento", importo: 10, data: "2026-03-01", contoDa: "acc1",
    }, base)).toThrow(ValidationError);
  });

  it("allows an ad-hoc extraPersone participant declared on the same request", () => {
    const doc = validateTransactionInput({
      tipo: "uscita", importo: 30, data: "2026-03-01", pagatoDa: "g",
      extraPersone: [{ id: "ospite", nome: "Ospite" }],
      splits: [{ personaId: "g", quota: 50 }, { personaId: "ospite", quota: 50 }],
    }, base);
    expect(doc.splits.find(s => s.personaId === "ospite")).toBeTruthy();
  });

  it("rejects malformed amounts (NaN/Infinity/negative/zero)", () => {
    for (const bad of [NaN, Infinity, -5, 0, "not-a-number"]) {
      expect(() => validateTransactionInput({ tipo: "uscita", importo: bad, data: "2026-03-01" }, base))
        .toThrow(ValidationError);
    }
  });

  it("rejects an invalid date", () => {
    expect(() => validateTransactionInput({ tipo: "uscita", importo: 10, data: "not-a-date" }, base))
      .toThrow(ValidationError);
  });

  it("rejects an invalid type", () => {
    expect(() => validateTransactionInput({ tipo: "bonifico", importo: 10, data: "2026-03-01" }, base))
      .toThrow(ValidationError);
  });
});

describe("validateTransactionInput — partial (PUT) validation", () => {
  const base = { householdPersonIds, accountIds };
  const existing = {
    tipo: "uscita", importo: 20, data: "2026-01-01", categoria: "cibo",
    pagatoDa: "g", splits: [{ personaId: "g", quota: 100 }],
    contoDa: null, contoA: null,
  };

  it("only returns fields present in the request body", () => {
    const doc = validateTransactionInput({ importo: 25 }, { ...base, partial: true, existing });
    expect(doc).toEqual({ importo: 25 });
  });

  it("still enforces amount validation on a partial update", () => {
    expect(() => validateTransactionInput({ importo: -1 }, { ...base, partial: true, existing }))
      .toThrow(ValidationError);
  });

  it("validates transfer accounts against the existing type when tipo isn't in the patch", () => {
    const transferExisting = { ...existing, tipo: "trasferimento", contoDa: "acc1", contoA: "acc2" };
    expect(() => validateTransactionInput({ contoDa: "acc2" }, { ...base, partial: true, existing: transferExisting }))
      .toThrow(ValidationError); // would make contoDa === contoA === "acc2"
  });

  it("resolves extraPersone participants from the existing doc when not in the patch", () => {
    const existingWithGuest = { ...existing, extraPersone: [{ id: "ospite", nome: "Ospite" }] };
    const doc = validateTransactionInput(
      { splits: [{ personaId: "g", quota: 50 }, { personaId: "ospite", quota: 50 }] },
      { ...base, partial: true, existing: existingWithGuest }
    );
    expect(doc.splits.find(s => s.personaId === "ospite")).toBeTruthy();
  });
});
