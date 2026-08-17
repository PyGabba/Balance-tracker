import { describe, it, expect } from "vitest";
import {
  validateAmount,
  validateDateStr,
  validateType,
  validateSplits,
  computeValidSplits,
  validateTransactionInput,
  buildTripExpense,
  encodeTransactionsCursor,
  decodeTransactionsCursor,
  decideIdempotencyClaim,
  isTripSettlementCandidate,
  settlementTransactionKey,
  isKnownParticipant,
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
    expect(doc).toEqual({ importo: 25, importoMinorUnits: 2500 }); // MOD-016 companion field
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

describe("buildTripExpense", () => {
  const trip = { partecipanti: [{ id: "g", nome: "Gabriele" }, { id: "l", nome: "Luca" }] };

  it("accepts a well-formed expense", () => {
    const exp = buildTripExpense({ pagatoDa: "g", importo: 42, data: "2026-03-01", descrizione: "Cena" }, trip);
    expect(exp.pagatoDa).toBe("g");
    expect(exp.importo).toBe(42);
    expect(exp.id).toBeTruthy();
  });

  it("rejects a payer who isn't a participant of THIS trip (household members and other trips' guests don't count)", () => {
    expect(() => buildTripExpense({ pagatoDa: "mallory", importo: 10 }, trip)).toThrow(ValidationError);
  });

  it("rejects splits referencing someone outside the trip", () => {
    expect(() => buildTripExpense({
      pagatoDa: "g", importo: 10, splits: [{ personaId: "g", quota: 50 }, { personaId: "mallory", quota: 50 }],
    }, trip)).toThrow(ValidationError);
  });

  it("rejects splits that don't sum to 100 instead of silently dropping them", () => {
    expect(() => buildTripExpense({
      pagatoDa: "g", importo: 10, splits: [{ personaId: "g", quota: 40 }, { personaId: "l", quota: 40 }],
    }, trip)).toThrow(ValidationError);
  });

  it("accepts a valid even split between trip participants", () => {
    const exp = buildTripExpense({
      pagatoDa: "g", importo: 10, splits: [{ personaId: "g", quota: 50 }, { personaId: "l", quota: 50 }],
    }, trip);
    expect(exp.splits).toHaveLength(2);
  });

  it("rejects a non-positive amount", () => {
    expect(() => buildTripExpense({ pagatoDa: "g", importo: 0 }, trip)).toThrow(ValidationError);
    expect(() => buildTripExpense({ pagatoDa: "g", importo: -5 }, trip)).toThrow(ValidationError);
  });

  it("falls back to today's date rather than rejecting on a missing/malformed date", () => {
    const exp = buildTripExpense({ pagatoDa: "g", importo: 10, data: "not-a-date" }, trip);
    expect(exp.data).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("has no cross-trip leakage: a participant valid on one trip is rejected on another", () => {
    const otherTrip = { partecipanti: [{ id: "m", nome: "Marco" }] };
    expect(() => buildTripExpense({ pagatoDa: "g", importo: 10 }, otherTrip)).toThrow(ValidationError);
  });
});

describe("transaction pagination cursor (MOD-006)", () => {
  const validId = "507f1f77bcf86cd799439011";

  it("round-trips a date + id", () => {
    const cursor = encodeTransactionsCursor("2026-03-01", validId);
    expect(decodeTransactionsCursor(cursor)).toEqual({ data: "2026-03-01", id: validId });
  });

  it("is opaque base64url, not the raw values", () => {
    const cursor = encodeTransactionsCursor("2026-03-01", validId);
    expect(cursor).not.toContain("2026-03-01");
    expect(cursor).not.toContain(validId);
  });

  it("rejects garbage input instead of throwing", () => {
    expect(decodeTransactionsCursor("not-a-real-cursor")).toBeNull();
    expect(decodeTransactionsCursor("")).toBeNull();
  });

  it("rejects a cursor with a malformed id", () => {
    const fake = Buffer.from(JSON.stringify({ d: "2026-03-01", i: "not-an-object-id" })).toString("base64url");
    expect(decodeTransactionsCursor(fake)).toBeNull();
  });

  it("rejects a cursor missing a field", () => {
    const fake = Buffer.from(JSON.stringify({ d: "2026-03-01" })).toString("base64url");
    expect(decodeTransactionsCursor(fake)).toBeNull();
  });

  it("produces a different cursor for different inputs (pages don't collide)", () => {
    const a = encodeTransactionsCursor("2026-03-01", validId);
    const b = encodeTransactionsCursor("2026-03-02", validId);
    expect(a).not.toBe(b);
  });
});

describe("decideIdempotencyClaim (MOD-004, hardened)", () => {
  const STALE_MS = 30000;

  it("claims when nothing exists (won the atomic insert, or raced past the read too)", () => {
    expect(decideIdempotencyClaim(null, 1000, STALE_MS)).toEqual({ action: "claim" });
  });

  it("replays a completed record instead of re-creating the entity", () => {
    const existing = { status: 201, body: { id: "tx1" }, createdAt: new Date(500) };
    expect(decideIdempotencyClaim(existing, 1000, STALE_MS)).toEqual({ action: "replay" });
  });

  it("waits on a pending record that's still fresh (genuinely in flight)", () => {
    const existing = { status: "pending", createdAt: new Date(1000) };
    const decision = decideIdempotencyClaim(existing, 1000 + STALE_MS - 1, STALE_MS);
    expect(decision.action).toBe("wait");
  });

  it("steals a pending record older than the staleness window (presumed crashed)", () => {
    const createdAt = new Date(1000);
    const existing = { status: "pending", createdAt };
    const decision = decideIdempotencyClaim(existing, 1000 + STALE_MS + 1, STALE_MS);
    expect(decision).toEqual({ action: "steal", createdAt });
  });

  it("treats the exact staleness boundary as stale (steals, not waits) — age >= staleMs", () => {
    const createdAt = new Date(1000);
    const existing = { status: "pending", createdAt };
    const decision = decideIdempotencyClaim(existing, 1000 + STALE_MS, STALE_MS);
    expect(decision).toEqual({ action: "steal", createdAt });
  });

  it("replays a non-201 completed status too (e.g. a stored validation rejection)", () => {
    const existing = { status: 400, body: { error: "bad" }, createdAt: new Date(500) };
    expect(decideIdempotencyClaim(existing, 1000, STALE_MS)).toEqual({ action: "replay" });
  });
});

// NOTE: these are a pure specification of chiudiViaggiScaduti's intended
// eligibility/key logic (server/index.js) — they do NOT exercise the
// actual MongoDB queries, the atomic findOneAndUpdate claim, or genuine
// concurrent access. Verifying the real database enforces this correctly
// under concurrency would need integration tests against a live MongoDB
// instance, which this test suite does not have. Treat these as a
// regression guard on the intended rule, not proof of the guarantee.
describe("isTripSettlementCandidate (MOD-008, hardened — spec only, see note above)", () => {
  const today = "2026-08-16";
  const nowMs = new Date("2026-08-16T12:00:00Z").getTime();
  const staleMs = 10 * 60 * 1000;

  it("is a candidate when newly due: open/unset status, unsettled, past end date", () => {
    expect(isTripSettlementCandidate({ settlementStatus: null, settled: false, endDate: "2026-08-01" }, { today, nowMs, staleMs })).toBe(true);
    expect(isTripSettlementCandidate({ settlementStatus: "open", settled: false, endDate: "2026-08-01" }, { today, nowMs, staleMs })).toBe(true);
  });

  it("is NOT a candidate when not yet past its end date", () => {
    expect(isTripSettlementCandidate({ settlementStatus: null, settled: false, endDate: "2026-08-20" }, { today, nowMs, staleMs })).toBe(false);
  });

  it("is NOT a candidate when already settled", () => {
    expect(isTripSettlementCandidate({ settlementStatus: "settled", settled: true, endDate: "2026-08-01" }, { today, nowMs, staleMs })).toBe(false);
  });

  it("is NOT a candidate when genuinely still settling (fresh)", () => {
    const settlingStartedAt = new Date(nowMs - 1000); // 1s ago — well within the stale window
    expect(isTripSettlementCandidate({ settlementStatus: "settling", settlingStartedAt }, { today, nowMs, staleMs })).toBe(false);
  });

  it("IS a candidate (resumable) when stuck settling past the stale window", () => {
    const settlingStartedAt = new Date(nowMs - staleMs - 1000); // just past the window
    expect(isTripSettlementCandidate({ settlementStatus: "settling", settlingStartedAt }, { today, nowMs, staleMs })).toBe(true);
  });

  it("is NOT a candidate with no endDate at all", () => {
    expect(isTripSettlementCandidate({ settlementStatus: null, settled: false, endDate: null }, { today, nowMs, staleMs })).toBe(false);
  });
});

describe("settlementTransactionKey", () => {
  it("is deterministic for the same trip and index", () => {
    expect(settlementTransactionKey("trip1", 0)).toBe(settlementTransactionKey("trip1", 0));
  });
  it("differs by index within the same trip", () => {
    expect(settlementTransactionKey("trip1", 0)).not.toBe(settlementTransactionKey("trip1", 1));
  });
  it("differs by trip for the same index", () => {
    expect(settlementTransactionKey("trip1", 0)).not.toBe(settlementTransactionKey("trip2", 0));
  });
});

describe("isKnownParticipant (MOD-009 — reused by both validateTransactionInput and buildTripExpense against their own respective participant sets)", () => {
  const ids = new Set(["g", "l"]);

  it("accepts a known id", () => {
    expect(isKnownParticipant("g", ids)).toBe(true);
  });
  it("rejects an unknown id", () => {
    expect(isKnownParticipant("mallory", ids)).toBe(false);
  });
  it("rejects malformed input even if it would otherwise coincidentally match", () => {
    expect(isKnownParticipant(null, ids)).toBe(false);
    expect(isKnownParticipant(undefined, ids)).toBe(false);
    expect(isKnownParticipant(123, ids)).toBe(false);
    expect(isKnownParticipant("", ids)).toBe(false);
  });
  it("rejects an id over the length bound even if somehow present in the set", () => {
    const longId = "x".repeat(51);
    const idsWithLong = new Set([longId]);
    expect(isKnownParticipant(longId, idsWithLong)).toBe(false);
  });
});
