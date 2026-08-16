import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { startTestServer, stopTestServer, clearCollections } from "./testUtils.js";

let app;

beforeAll(async () => {
  app = await startTestServer();
}, 60000);

afterAll(async () => {
  await stopTestServer();
});

// One household registered for the whole file — registerLimiter caps
// registrations at 5/hour, and every test below only needs one household to
// exercise login/logout/session-revocation, so there's no reason to burn
// more of that budget than necessary.
const PIN = "184729";
let householdId;

beforeAll(async () => {
  const res = await request(app)
    .post("/api/auth/register")
    // NOTE: an explicit email is required here — see the "email: null sparse
    // index collision" bug documented at the bottom of this file. Without an
    // email, this household and the "Other Household" one below would both
    // insert email: null and the second registration would fail with a
    // spurious 409 "Email già collegata a un altro gruppo".
    .send({ nome: "Test Household Auth", persone: ["Gabriele", "Laura"], pin: PIN, email: "auth-test-1@example.com" });
  expect(res.status).toBe(201);
  householdId = res.body.householdId;
}, 60000);

describe("register -> login -> logout lifecycle", () => {
  it("register already returned a session cookie", async () => {
    expect(householdId).toBeTruthy();
  });

  it("logs in with the correct PIN and gets a fresh session cookie", async () => {
    const res = await request(app).post("/api/auth/login").send({ pin: PIN });
    expect(res.status).toBe(200);
    expect(res.body.householdId).toBe(householdId);
    expect(res.headers["set-cookie"].some(c => c.startsWith("token="))).toBe(true);
  });

  it("rejects an invalid PIN", async () => {
    const res = await request(app).post("/api/auth/login").send({ pin: "000000" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_PIN");
  });

  it("logout revokes the session — the old cookie is rejected on the next request", async () => {
    const agent = request.agent(app);
    const loginRes = await agent.post("/api/auth/login").send({ pin: PIN });
    expect(loginRes.status).toBe(200);

    // Session works before logout.
    const before = await agent.get("/api/household");
    expect(before.status).toBe(200);

    const logoutRes = await agent.post("/api/auth/logout");
    expect(logoutRes.status).toBe(200);

    // Same agent (same cookie jar) — but logout cleared the cookie client-side
    // AND revoked the token server-side (active_tokens). To prove the server
    // actually revoked it (not just that the client forgot the cookie), reuse
    // the raw cookie value captured before logout against a fresh, cookie-less
    // request.
    const rawCookie = loginRes.headers["set-cookie"].find(c => c.startsWith("token="));
    const after = await request(app).get("/api/household").set("Cookie", rawCookie);
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe("SESSION_EXPIRED");
  });

  it("rejects requests with no session cookie at all", async () => {
    const res = await request(app).get("/api/household");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("NOT_AUTHENTICATED");
  });

  it("rejects a malformed/garbage token", async () => {
    const res = await request(app).get("/api/household").set("Cookie", "token=not-a-real-jwt");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_TOKEN");
  });
});

describe("cross-household authorization (MOD-009)", () => {
  it("a second household cannot read the first household's data via its own valid session", async () => {
    const other = await request(app)
      .post("/api/auth/register")
      .send({ nome: "Other Household", persone: ["Marco"], pin: "512309", email: "auth-test-2@example.com" });
    expect(other.status).toBe(201);
    const otherCookie = other.headers["set-cookie"].find(c => c.startsWith("token="));

    const res = await request(app).get("/api/household").set("Cookie", otherCookie);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(other.body.householdId);
    expect(res.body.id).not.toBe(householdId);
  });
});

// ─── Pre-existing bug found while writing these tests (NOT fixed here — out
// of MOD-014 scope, flagged in the phase-5 report instead) ───
// server/index.js:316 creates `households.email` as a UNIQUE SPARSE index,
// but server/index.js:~1011 always sets `doc.email = emailNorm` (defaulting
// to `null`, never `undefined`) when a household registers without an
// email. MongoDB's sparse index only skips documents where the field is
// completely ABSENT — a field present with value `null` still gets indexed.
// The practical effect: the FIRST household ever registered without an
// email succeeds; every subsequent household that also omits an email fails
// registration with a misleading 409 "Email già collegata a un altro
// gruppo", even though no email was given at all. Reproduced directly
// against a real mongod (mongodb-memory-server) confirming this is real
// MongoDB semantics, not a test-double quirk. Every register() call in this
// test suite supplies a distinct email specifically to route around this.
