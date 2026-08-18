import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { startTestServer, stopTestServer, getDb } from "./testUtils.js";

// Regression: reading pinResets.attempts, checking it against the 5-attempt
// cap, and incrementing it were three separate steps — concurrent requests
// could all read the same pre-increment value and all pass the check,
// letting a distributed attacker (not IP-bound, since forgotPinLimiter is
// IP-keyed) try far more than 5 codes. The fix folds the check into the
// $inc's filter so MongoDB enforces the cap atomically.

let app;
let householdId;
const EMAIL = "pin-reset-race@example.com";

beforeAll(async () => {
  app = await startTestServer();
  const reg = await request(app).post("/api/auth/register")
    .send({ nome: "PIN Reset Race Household", persone: ["Gabriele"], pin: "384726", email: EMAIL });
  expect(reg.status).toBe(201);
  householdId = reg.body.householdId;
}, 60000);

afterAll(async () => {
  await stopTestServer();
});

async function seedResetCode(code) {
  const db = getDb();
  const codeHash = await bcrypt.hash(code, 10);
  await db.collection("pinResets").deleteMany({ householdId });
  await db.collection("pinResets").insertOne({
    householdId, codeHash, attempts: 0,
    createdAt: new Date(), expiresAt: new Date(Date.now() + 15 * 60 * 1000),
  });
}

describe("POST /api/auth/forgot-pin/confirm — attempt cap under concurrency", () => {
  // forgotPinLimiter caps at 5 requests / 10min PER IP — exactly the
  // "not IP-bound" gap the original bug report calls out: a distributed
  // attacker spreads across IPs and never hits that limiter at all, so
  // the pinResets.attempts cap is the only thing left enforcing 5 tries.
  // Each request below carries a distinct X-Forwarded-For (the app trusts
  // one proxy hop) to simulate exactly that — 20 different "attackers"
  // hitting the same reset code concurrently.
  function fromIp(ip) {
    return request(app).post("/api/auth/forgot-pin/confirm").set("X-Forwarded-For", ip);
  }

  it("20 simultaneous wrong-code requests from 20 different IPs never let attempts exceed 5 in the database", async () => {
    await seedResetCode("111111");

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        fromIp(`10.0.1.${i}`).send({ email: EMAIL, code: "999999", newPin: "482913" }))
    );

    // Every response must be a rejection (wrong code, or capped out) —
    // never a 500 from a corrupted/half-updated document.
    for (const res of results) expect([400, 429]).toContain(res.status);

    const db = getDb();
    const doc = await db.collection("pinResets").findOne({ householdId });
    // The doc is never deleted on cap-exceeded (only on success or via TTL
    // expiry — see the comment in the endpoint), so its attempts field is
    // authoritative here: exactly 5, never more, regardless of how many
    // concurrent requests raced for a slot.
    expect(doc).toBeTruthy();
    expect(doc.attempts).toBe(5);

    const wrongCount = results.filter(r => r.status === 400 && r.body.error.code === "INVALID_RESET_CODE").length;
    const cappedCount = results.filter(r => r.status === 429 && r.body.error.code === "TOO_MANY_ATTEMPTS").length;
    // At most 5 requests ever got as far as an actual bcrypt comparison
    // (each reserving one of the 5 attempt slots); everything else was
    // turned away by the cap before comparing anything.
    expect(wrongCount).toBeLessThanOrEqual(5);
    expect(wrongCount + cappedCount).toBe(20);
  });

  it("the correct code still succeeds when tried within the attempt cap", async () => {
    await seedResetCode("246810");
    const res = await fromIp("10.0.2.1").send({ email: EMAIL, code: "246810", newPin: "175395" });
    expect(res.status).toBe(200);

    const db = getDb();
    const doc = await db.collection("pinResets").findOne({ householdId });
    expect(doc).toBeNull(); // consumed on success
  });

  it("a 6th attempt after 5 sequential wrong ones is rejected without even comparing", async () => {
    await seedResetCode("135791");
    for (let i = 0; i < 5; i++) {
      const res = await fromIp(`10.0.3.${i}`).send({ email: EMAIL, code: "000000", newPin: "864203" });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("INVALID_RESET_CODE");
    }
    const sixth = await fromIp("10.0.3.99").send({ email: EMAIL, code: "135791", newPin: "864203" }); // even the RIGHT code, now capped
    expect(sixth.status).toBe(429);
    expect(sixth.body.error.code).toBe("TOO_MANY_ATTEMPTS");
  });
});
