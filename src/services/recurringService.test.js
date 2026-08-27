import { describe, it, expect } from "vitest";
import { findDueRecurring, buildRecurringOccurrence, listRecurringTemplates, skipNextOccurrence } from "./recurringService.js";

describe("findDueRecurring", () => {
  it("selects only templates due on or before today", () => {
    const tx = [
      { id: "a", ricorrenza: { frequenza: "mensile", prossimaData: "2026-08-01" } },
      { id: "b", ricorrenza: { frequenza: "mensile", prossimaData: "2026-09-01" } },
      { id: "c" },
    ];
    expect(findDueRecurring(tx, "2026-08-17").map(t => t.id)).toEqual(["a"]);
  });

  it("ignores templates missing frequenza or prossimaData", () => {
    const tx = [{ id: "a", ricorrenza: { frequenza: "mensile" } }, { id: "b", ricorrenza: { prossimaData: "2026-08-01" } }];
    expect(findDueRecurring(tx, "2026-08-17")).toEqual([]);
  });
});

describe("buildRecurringOccurrence", () => {
  const genId = () => "new-id";

  it("builds a plain occurrence transaction without a ricorrenza field", () => {
    const template = { id: "tpl", tipo: "uscita", importo: 10, ricorrenza: { frequenza: "mensile", prossimaData: "2026-08-01" } };
    const { nuovaTx } = buildRecurringOccurrence(template, genId);
    expect(nuovaTx.id).toBe("new-id");
    expect(nuovaTx.data).toBe("2026-08-01");
    expect(nuovaTx.ricorrenza).toBeUndefined();
  });

  it("advances the template's prossimaData by the frequency", () => {
    const template = { id: "tpl", ricorrenza: { frequenza: "mensile", prossimaData: "2026-08-01" } };
    const { updatedRicorrenza } = buildRecurringOccurrence(template, genId);
    expect(updatedRicorrenza).toEqual({ frequenza: "mensile", prossimaData: "2026-09-01", variabile: undefined });
  });

  it("marks the occurrence daVerificare when the template is variabile", () => {
    const template = { id: "tpl", ricorrenza: { frequenza: "settimanale", prossimaData: "2026-08-01", variabile: true } };
    const { nuovaTx } = buildRecurringOccurrence(template, genId);
    expect(nuovaTx.daVerificare).toBe(true);
  });

  it("strips _id so the occurrence isn't mistaken for an existing server doc", () => {
    const template = { id: "tpl", _id: "mongo-id", ricorrenza: { frequenza: "mensile", prossimaData: "2026-08-01" } };
    const { nuovaTx } = buildRecurringOccurrence(template, genId);
    expect(nuovaTx._id).toBeUndefined();
  });
});

describe("listRecurringTemplates", () => {
  it("keeps only live templates, sorted by soonest next occurrence", () => {
    const tx = [
      { id: "a", ricorrenza: { frequenza: "mensile", prossimaData: "2026-09-01" } },
      { id: "b", ricorrenza: { frequenza: "mensile", prossimaData: "2026-08-01" } },
      { id: "c" }, // not a template
      { id: "d", ricorrenza: { frequenza: "mensile" } }, // missing prossimaData
    ];
    expect(listRecurringTemplates(tx).map(t => t.id)).toEqual(["b", "a"]);
  });

  it("returns an empty array when there are no templates", () => {
    expect(listRecurringTemplates([{ id: "a" }])).toEqual([]);
  });
});

describe("skipNextOccurrence", () => {
  it("advances prossimaData by one frequency step, keeping other fields", () => {
    const template = { id: "tpl", ricorrenza: { frequenza: "mensile", prossimaData: "2026-08-01", variabile: true } };
    expect(skipNextOccurrence(template)).toEqual({ frequenza: "mensile", prossimaData: "2026-09-01", variabile: true });
  });

  it("works across year boundaries for annual frequency", () => {
    const template = { id: "tpl", ricorrenza: { frequenza: "annuale", prossimaData: "2026-12-25" } };
    expect(skipNextOccurrence(template)).toEqual({ frequenza: "annuale", prossimaData: "2027-12-25" });
  });
});
