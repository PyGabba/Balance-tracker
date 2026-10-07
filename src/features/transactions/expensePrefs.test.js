import { describe, it, expect } from "vitest";
import { sanitizeExpensePrefs, loadExpensePrefs, saveExpensePrefs, describeSplit } from "./expensePrefs.js";

const persone = [{ id: "g", nome: "Gabriele" }, { id: "l", nome: "Laura" }];
const memory = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), raw: m }; };

describe("sanitizeExpensePrefs", () => {
  it("keeps a valid payer and split", () => {
    const prefs = { pagatoDa: "l", splits: [{ personaId: "g", quota: 50 }, { personaId: "l", quota: 50 }] };
    expect(sanitizeExpensePrefs(prefs, persone)).toEqual(prefs);
  });
  it("drops a payer who left the household, keeps a still-valid split", () => {
    const r = sanitizeExpensePrefs({ pagatoDa: "x", splits: [{ personaId: "g", quota: 100 }] }, persone);
    expect(r.pagatoDa).toBeUndefined();
    expect(r.splits).toEqual([{ personaId: "g", quota: 100 }]);
  });
  it("drops splits naming unknown people, not summing to 100, or duplicated", () => {
    expect(sanitizeExpensePrefs({ splits: [{ personaId: "x", quota: 100 }] }, persone).splits).toBeUndefined();
    expect(sanitizeExpensePrefs({ splits: [{ personaId: "g", quota: 30 }, { personaId: "l", quota: 30 }] }, persone).splits).toBeUndefined();
    expect(sanitizeExpensePrefs({ splits: [{ personaId: "g", quota: 50 }, { personaId: "g", quota: 50 }] }, persone).splits).toBeUndefined();
  });
  it("tolerates garbage", () => {
    expect(sanitizeExpensePrefs(null, persone)).toEqual({});
    expect(sanitizeExpensePrefs("x", persone)).toEqual({});
    expect(sanitizeExpensePrefs({ splits: [{ personaId: "g", quota: "50" }] }, persone)).toEqual({});
  });
});

describe("load/save", () => {
  it("round-trips per household", () => {
    const st = memory();
    saveExpensePrefs("h1", { pagatoDa: "l", splits: [{ personaId: "g", quota: 40 }, { personaId: "l", quota: 60 }] }, persone, st);
    expect(loadExpensePrefs("h1", persone, st).pagatoDa).toBe("l");
    expect(loadExpensePrefs("h2", persone, st)).toEqual({});
  });
  it("doesn't remember a split that included a one-off guest, but remembers the payer", () => {
    const st = memory();
    saveExpensePrefs("h1", { pagatoDa: "g", splits: [{ personaId: "g", quota: 50 }, { personaId: "ospite", quota: 50 }], extraPersone: [{ id: "ospite" }] }, persone, st);
    expect(loadExpensePrefs("h1", persone, st)).toEqual({ pagatoDa: "g" });
  });
  it("survives corrupt storage and a missing household", () => {
    const st = memory(); st.setItem("finanza:lastExpense:h1", "{not json");
    expect(loadExpensePrefs("h1", persone, st)).toEqual({});
    expect(loadExpensePrefs(null, persone, st)).toEqual({});
  });
});

describe("describeSplit", () => {
  it("equal between everyone", () => {
    expect(describeSplit([{ personaId: "g", quota: 50 }, { personaId: "l", quota: 50 }], persone, "g", "en")).toBe("Split equally between everyone");
  });
  it("one participant: the payer pays all / only someone else", () => {
    expect(describeSplit([{ personaId: "g", quota: 100 }], persone, "g", "en")).toBe("Gabriele pays all");
    expect(describeSplit([{ personaId: "l", quota: 100 }], persone, "g", "en")).toBe("Only for Laura");
  });
  it("equal among a subset", () => {
    const three = [...persone, { id: "m", nome: "Marco" }];
    expect(describeSplit([{ personaId: "g", quota: 50 }, { personaId: "m", quota: 50 }], three, "g", "en")).toBe("Split between Gabriele, Marco");
  });
  it("uneven → percentages; ignores zero shares; empty → ''", () => {
    expect(describeSplit([{ personaId: "g", quota: 60 }, { personaId: "l", quota: 40 }], persone, "g", "en")).toBe("Gabriele 60% · Laura 40%");
    expect(describeSplit([{ personaId: "g", quota: 100 }, { personaId: "l", quota: 0 }], persone, "g", "en")).toBe("Gabriele pays all");
    expect(describeSplit([], persone, "g", "en")).toBe("");
  });
  it("three-way split (33.33/33.33/33.34) still counts as equal", () => {
    const three = [...persone, { id: "m", nome: "Marco" }];
    expect(describeSplit([{ personaId: "g", quota: 33.33 }, { personaId: "l", quota: 33.33 }, { personaId: "m", quota: 33.34 }], three, "g", "en")).toBe("Split equally between everyone");
  });
});
