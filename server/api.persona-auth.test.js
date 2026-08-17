import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { startTestServer, stopTestServer, getDb } from "./testUtils.js";

// registerLimiter caps registrations at 5/hour per test-file app instance —
// this file deliberately reuses households across scenarios instead of
// registering a fresh one per test, staying well under that budget (3
// registrations total: the shared household below, one isolated household
// for the lockout/removal tests, one for the zero-enrollment guarantee).

let app;
let agent;
let persone; // [Gabriele, Laura, Ospite] — Ospite is deliberately never enrolled

beforeAll(async () => {
  app = await startTestServer();
  agent = request.agent(app);
  const reg = await agent
    .post("/api/auth/register")
    .send({ nome: "Test Household Persona Auth", persone: ["Gabriele", "Laura", "Ospite"], pin: "582917" });
  expect(reg.status).toBe(201);
  persone = reg.body.persone;
}, 60000);

afterAll(async () => {
  await stopTestServer();
});

describe("persona credential sanitization (MOD-025 Stage 1)", () => {
  it("register response never includes a passwordHash field, just hasCredential", () => {
    for (const p of persone) {
      expect(p.auth).toBeUndefined();
      expect(p.hasCredential).toBe(false);
    }
  });

  it("no server response ever includes raw auth/passwordHash after enrollment", async () => {
    const target = persone[0].id;
    const enroll = await agent.post("/api/auth/persona-credential").send({ personaId: target, newPassword: "correct-horse-battery" });
    expect(enroll.status).toBe(200);

    for (const res of await Promise.all([
      agent.get("/api/household"),
      agent.get("/api/backup"),
    ])) {
      const body = JSON.stringify(res.body);
      expect(body).not.toMatch(/passwordHash/i);
      const enrolled = (res.body.persone || res.body.household?.persone || []).find(p => p.id === target);
      if (enrolled) expect(enrolled.hasCredential).toBe(true);
    }
  });

  it("the raw passwordHash actually exists in the database (sanitization is response-only, not data loss)", async () => {
    const db = getDb();
    const household = await db.collection("households").findOne({ nome: "Test Household Persona Auth" });
    const target = household.persone.find(p => p.id === persone[0].id);
    expect(target.auth.method).toBe("password");
    expect(typeof target.auth.passwordHash).toBe("string");
    expect(target.auth.passwordHash).not.toBe("correct-horse-battery");
  });
});

describe("persona credential enrollment", () => {
  it("rejects a password under 8 characters", async () => {
    const res = await agent.post("/api/auth/persona-credential").send({ personaId: persone[1].id, newPassword: "short" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_PASSWORD");
  });

  it("rejects an unknown persona id", async () => {
    const res = await agent.post("/api/auth/persona-credential").send({ personaId: "nonexistent", newPassword: "correct-horse-battery" });
    expect(res.status).toBe(404);
  });

  it("first enrollment needs no current password; changing it afterward does", async () => {
    const target = persone[1].id;
    const first = await agent.post("/api/auth/persona-credential").send({ personaId: target, newPassword: "first-password-here" });
    expect(first.status).toBe(200);

    const wrongCurrent = await agent.post("/api/auth/persona-credential")
      .send({ personaId: target, newPassword: "second-password-here", currentPassword: "totally-wrong" });
    expect(wrongCurrent.status).toBe(401);
    expect(wrongCurrent.body.error.code).toBe("INVALID_CURRENT_PASSWORD");

    const rightCurrent = await agent.post("/api/auth/persona-credential")
      .send({ personaId: target, newPassword: "second-password-here", currentPassword: "first-password-here" });
    expect(rightCurrent.status).toBe(200);
  });
});

describe("persona login", () => {
  it("logs in as a persona with the right password, and the session now carries that identity", async () => {
    const target = persone[0].id; // enrolled "correct-horse-battery" above, never changed
    const res = await agent.post("/api/auth/persona-login").send({ personaId: target, password: "correct-horse-battery" });
    expect(res.status).toBe(200);
    expect(res.body.personaId).toBe(target);
  });

  it("rejects the wrong password", async () => {
    const res = await agent.post("/api/auth/persona-login").send({ personaId: persone[0].id, password: "wrong-password-here" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_PERSONA_PASSWORD");
  });

  it("rejects login for a persona with no credential enrolled", async () => {
    const res = await agent.post("/api/auth/persona-login").send({ personaId: persone[2].id, password: "anything-at-all" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("NO_PERSONA_CREDENTIAL");
  });
});

describe("persona login lockout + credential removal (isolated household)", () => {
  let agent2, personaId;

  beforeAll(async () => {
    const reg = await request(app).post("/api/auth/register")
      .send({ nome: "Persona Lockout Household", persone: ["Target"], pin: "927153" });
    agent2 = request.agent(app);
    await agent2.post("/api/auth/login").send({ pin: "927153" });
    personaId = reg.body.persone[0].id;
    await agent2.post("/api/auth/persona-credential").send({ personaId, newPassword: "the-real-password-1" });
  });

  it("locks out after repeated wrong passwords, independent of IP", async () => {
    for (let i = 0; i < 10; i++) {
      const res = await agent2.post("/api/auth/persona-login").send({ personaId, password: "wrong-every-time" });
      expect(res.status).toBe(401);
    }
    // The 11th attempt (10 recorded failures = locked) is rejected outright, without even checking the password.
    const locked = await agent2.post("/api/auth/persona-login").send({ personaId, password: "wrong-every-time" });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe("RATE_LIMITED");

    // Even the CORRECT password is rejected while locked.
    const correctWhileLocked = await agent2.post("/api/auth/persona-login").send({ personaId, password: "the-real-password-1" });
    expect(correctWhileLocked.status).toBe(429);
  }, 20000);

  it("un-enrolling clears the lockout along with the credential", async () => {
    const del = await agent2.delete(`/api/auth/persona-credential/${personaId}`);
    expect(del.status).toBe(200);
    expect(del.body.persone.find(p => p.id === personaId).hasCredential).toBe(false);

    // No longer locked, but also no longer has a credential to log in with.
    const loginAttempt = await agent2.post("/api/auth/persona-login").send({ personaId, password: "the-real-password-1" });
    expect(loginAttempt.status).toBe(400);
    expect(loginAttempt.body.error.code).toBe("NO_PERSONA_CREDENTIAL");
  });
});

describe("zero enforcement (MOD-025 Stage 1 guarantee)", () => {
  it("every existing endpoint still works exactly as before for a household with zero personas enrolled", async () => {
    const reg = await request(app).post("/api/auth/register")
      .send({ nome: "Untouched Household", persone: ["A", "B"], pin: "205917" });
    const agent3 = request.agent(app);
    await agent3.post("/api/auth/login").send({ pin: "205917" });

    const tx = await agent3.post("/api/transactions").send({ tipo: "uscita", importo: 10, data: "2026-08-01" });
    expect(tx.status).toBe(201);
    const household = await agent3.get("/api/household");
    expect(household.status).toBe(200);
    expect(household.body.persone.every(p => p.hasCredential === false)).toBe(true);
    expect(reg.status).toBe(201);
  });
});
