import { describe, it, expect } from "vitest";
import { equalQuotas, splitsTotalOk } from "./appHelpers.js";

describe("equalQuotas", () => {
  it("always sums to exactly 100", () => {
    for (let n = 1; n <= 20; n++) {
      const quotas = equalQuotas(n);
      expect(quotas.length).toBe(n);
      const total = quotas.reduce((s, q) => s + q, 0);
      expect(Math.round(total * 100) / 100).toBe(100);
    }
  });

  it("divides evenly when it can (8 people -> 12.5 each)", () => {
    expect(equalQuotas(8)).toEqual([12.5, 12.5, 12.5, 12.5, 12.5, 12.5, 12.5, 12.5]);
  });

  it("keeps every share within a cent of 100/n instead of dumping the whole remainder on one person (7 people)", () => {
    const quotas = equalQuotas(7);
    expect(quotas).toEqual([14.29, 14.29, 14.29, 14.29, 14.29, 14.29, 14.26]);
    expect(Math.max(...quotas) - Math.min(...quotas)).toBeLessThanOrEqual(0.05);
  });

  it("handles n=1 and n=0", () => {
    expect(equalQuotas(1)).toEqual([100]);
    expect(equalQuotas(0)).toEqual([]);
  });
});

describe("splitsTotalOk", () => {
  it("accepts equalQuotas output for any participant count", () => {
    for (let n = 1; n <= 20; n++) {
      const splits = equalQuotas(n).map((quota, i) => ({ personaId: `p${i}`, quota }));
      expect(splitsTotalOk(splits)).toBe(true);
    }
  });

  it("rejects a split that doesn't sum to 100", () => {
    expect(splitsTotalOk([{ personaId: "a", quota: 40 }, { personaId: "b", quota: 40 }])).toBe(false);
  });

  it("treats an empty/missing split as fine (unset)", () => {
    expect(splitsTotalOk([])).toBe(true);
    expect(splitsTotalOk(null)).toBe(true);
  });
});
