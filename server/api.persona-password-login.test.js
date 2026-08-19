import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { startTestServer, stopTestServer, getDb } from "./testUtils.js";

// Standalone email+password login (no household PIN first) — the login
// page's "password" tab. A persona only becomes reachable this way once a
// credential email is set (POST /api/auth/persona-credential with an
// `email` field); it's the only thing that identifies which
// household/persona a bare password belongs to.

let app;
let agent;
let personaId;
const EMAIL = "pw-login-test@example.com";

beforeAll(async () => {
  app = await startTestServer();
  agent = request.agent(app);
  const reg = await agent.post("/api/auth/register")
    .send({ nome: "Password Login Household", persone: ["Gabriele", "Laura"], pin: "482913" });
  expect(reg.status).toBe(201);
  personaId = reg.body.persone[0].id;
  await agent.post("/api/auth/login").send({ pin: "482913" });
  const enroll = await agent.post("/api/auth/persona-credential")
    .send({ personaId, newPassword: "correct-horse-battery", email: EMAIL });
  expect(enroll.status).toBe(200);
  expect(enroll.body.persone.find(p => p.id === personaId).credentialEmail).toBe(EMAIL);
}, 60000);

afterAll(async () => {
  await stopTestServer();
});

describe("POST /api/auth/persona-login-password", () => {
  it("logs in with just email + password, no PIN session needed at all", async () => {
    const res = await request(app).post("/api/auth/persona-login-password")
      .send({ email: EMAIL, password: "correct-horse-battery" });
    expect(res.status).toBe(200);
    expect(res.body.personaId).toBe(personaId);
    expect(res.body.persone).toBeTruthy();
    expect(res.headers["set-cookie"]).toBeTruthy();
  });

  it("the issued session actually works for authenticated requests", async () => {
    const login = await request(app).post("/api/auth/persona-login-password")
      .send({ email: EMAIL, password: "correct-horse-battery" });
    const cookie = login.headers["set-cookie"];
    const household = await request(app).get("/api/household").set("Cookie", cookie);
    expect(household.status).toBe(200);
  });

  it("rejects the wrong password with the same error as an unknown email (no enumeration)", async () => {
    const wrongPassword = await request(app).post("/api/auth/persona-login-password")
      .send({ email: EMAIL, password: "totally-wrong-password" });
    const unknownEmail = await request(app).post("/api/auth/persona-login-password")
      .send({ email: "nobody-has-this-email@example.com", password: "totally-wrong-password" });
    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body.error.code).toBe(unknownEmail.body.error.code);
    expect(wrongPassword.body.error.message).toBe(unknownEmail.body.error.message);
  });

  it("fails closed (not a 500) for an email nobody has enrolled at all", async () => {
    const res = await request(app).post("/api/auth/persona-login-password")
      .send({ email: "nobody-enrolled-this@example.com", password: "anything-at-all" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_CREDENTIALS");
  });

  it("locks out after repeated wrong attempts, keyed by email (survives IP rotation)", async () => {
    // A dedicated household/email, isolated from EMAIL used by every other
    // test in this file — locking that one out here would break the later
    // "still works with the new password" test with a stale 10-minute lock.
    const reg = await request(app).post("/api/auth/register")
      .send({ nome: "Password Login Lockout Household", persone: ["Target"], pin: "294817" });
    const setupAgent = request.agent(app);
    await setupAgent.post("/api/auth/login").send({ pin: "294817" });
    const lockoutEmail = "pw-login-lockout@example.com";
    await setupAgent.post("/api/auth/persona-credential")
      .send({ personaId: reg.body.persone[0].id, newPassword: "the-real-password-1", email: lockoutEmail });

    for (let i = 0; i < 10; i++) {
      const res = await request(app).post("/api/auth/persona-login-password")
        .send({ email: lockoutEmail, password: "wrong-every-time" });
      expect(res.status).toBe(401);
    }
    const locked = await request(app).post("/api/auth/persona-login-password")
      .send({ email: lockoutEmail, password: "wrong-every-time" });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe("RATE_LIMITED");

    // Even the correct password is rejected while locked.
    const correctWhileLocked = await request(app).post("/api/auth/persona-login-password")
      .send({ email: lockoutEmail, password: "the-real-password-1" });
    expect(correctWhileLocked.status).toBe(429);
  }, 20000);
});

describe("credential email uniqueness", () => {
  it("rejects enrolling the same email on a second persona (globally unique, not just per household)", async () => {
    const reg2 = await request(app).post("/api/auth/register")
      .send({ nome: "Password Login Household 2", persone: ["Marco"], pin: "715294" });
    const agent2 = request.agent(app);
    await agent2.post("/api/auth/login").send({ pin: "715294" });
    const res = await agent2.post("/api/auth/persona-credential")
      .send({ personaId: reg2.body.persone[0].id, newPassword: "another-password-1", email: EMAIL });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("EMAIL_ALREADY_IN_USE");
  });

  it("omitting email on a later password change preserves the previously set email", async () => {
    const change = await agent.post("/api/auth/persona-credential")
      .send({ personaId, newPassword: "second-password-here", currentPassword: "correct-horse-battery" });
    expect(change.status).toBe(200);
    expect(change.body.persone.find(p => p.id === personaId).credentialEmail).toBe(EMAIL);

    // And the standalone login still works with the NEW password.
    const login = await request(app).post("/api/auth/persona-login-password")
      .send({ email: EMAIL, password: "second-password-here" });
    expect(login.status).toBe(200);
  });
});

describe("removing the credential also revokes standalone-login access", () => {
  it("a password-login session dies the moment the credential is removed", async () => {
    const reg3 = await request(app).post("/api/auth/register")
      .send({ nome: "Password Login Household 3", persone: ["Sara"], pin: "639271" });
    const householdAgent = request.agent(app);
    await householdAgent.post("/api/auth/login").send({ pin: "639271" });
    const sara = reg3.body.persone[0].id;
    await householdAgent.post("/api/auth/persona-credential")
      .send({ personaId: sara, newPassword: "sara-password-1", email: "sara-pw-login@example.com" });

    const login = await request(app).post("/api/auth/persona-login-password")
      .send({ email: "sara-pw-login@example.com", password: "sara-password-1" });
    expect(login.status).toBe(200);
    const cookie = login.headers["set-cookie"];

    // Removing an already-claimed credential now requires proof of
    // identity — self, admin+, or (as here, on a plain PIN session)
    // knowing the current password — instead of the bare household PIN
    // being enough on its own.
    await householdAgent.delete(`/api/auth/persona-credential/${sara}`).send({ currentPassword: "sara-password-1" });

    const after = await request(app).get("/api/household").set("Cookie", cookie);
    expect(after.status).toBe(401);
  });
});
