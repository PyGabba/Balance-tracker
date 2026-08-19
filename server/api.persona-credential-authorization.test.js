import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { startTestServer, stopTestServer } from "./testUtils.js";

// Regression tests for the DELETE /api/auth/persona-credential/:id
// authorization fix. Before this fix, the route had no role check and no
// proof-of-identity requirement at all — any household-PIN holder could
// remove ANY already-claimed persona's credential, then re-enroll it
// through the (intentionally) open bootstrap path on POST, bypassing
// POST's own currentPassword protection entirely. See
// personaCredentialAuthorized in server/index.js.

let app;

beforeAll(async () => {
  app = await startTestServer();
}, 60000);

afterAll(async () => {
  await stopTestServer();
});

async function loginAsPersona(agent, personaId, password) {
  const res = await agent.post("/api/auth/persona-login").send({ personaId, password });
  expect(res.status).toBe(200);
}

describe("persona-credential DELETE authorization", () => {
  let agentOwner, agentAdmin, agentMember, agentPinOnly;
  let ownerId, adminId, memberId;

  beforeAll(async () => {
    const reg = await request(app).post("/api/auth/register").send({
      nome: "Persona Credential Authorization Household",
      persone: [{ nome: "Owner" }, { nome: "Admin" }, { nome: "Member" }],
      pin: "603817",
    });
    expect(reg.status).toBe(201);
    [ownerId, adminId, memberId] = reg.body.persone.map(p => p.id);

    const setup = request.agent(app);
    await setup.post("/api/auth/login").send({ pin: "603817" });
    await setup.put(`/api/household/persone/${adminId}/ruolo`).send({ ruolo: "admin" });
    await setup.put(`/api/household/persone/${memberId}/ruolo`).send({ ruolo: "member" });
    for (const [id, pw] of [[ownerId, "owner-password-1"], [adminId, "admin-password-1"], [memberId, "member-password-1"]]) {
      const enroll = await setup.post("/api/auth/persona-credential").send({ personaId: id, newPassword: pw });
      expect(enroll.status).toBe(200);
    }

    agentOwner = request.agent(app);
    await agentOwner.post("/api/auth/login").send({ pin: "603817" });
    await loginAsPersona(agentOwner, ownerId, "owner-password-1");

    agentAdmin = request.agent(app);
    await agentAdmin.post("/api/auth/login").send({ pin: "603817" });
    await loginAsPersona(agentAdmin, adminId, "admin-password-1");

    agentMember = request.agent(app);
    await agentMember.post("/api/auth/login").send({ pin: "603817" });
    await loginAsPersona(agentMember, memberId, "member-password-1");

    agentPinOnly = request.agent(app);
    await agentPinOnly.post("/api/auth/login").send({ pin: "603817" }); // deliberately never does persona-login
  }, 30000);

  it("a plain PIN-only session cannot remove an already-claimed persona's credential with no proof at all — the core vulnerability", async () => {
    const del = await agentPinOnly.delete(`/api/auth/persona-credential/${memberId}`);
    expect(del.status).toBe(403);
    expect(del.body.error.code).toBe("INSUFFICIENT_ROLE");
  });

  it("...but the same PIN-only session CAN remove it if it proves identity with the correct current password", async () => {
    const del = await agentPinOnly.delete(`/api/auth/persona-credential/${memberId}`).send({ currentPassword: "member-password-1" });
    expect(del.status).toBe(200);
    expect(del.body.persone.find(p => p.id === memberId).hasCredential).toBe(false);

    // Restore it for the tests below.
    const reEnroll = await agentPinOnly.post("/api/auth/persona-credential").send({ personaId: memberId, newPassword: "member-password-1" });
    expect(reEnroll.status).toBe(200);
  });

  it("a member cannot remove another persona's credential — not self, not admin+, no proof offered", async () => {
    const del = await agentMember.delete(`/api/auth/persona-credential/${adminId}`);
    expect(del.status).toBe(403);
    expect(del.body.error.code).toBe("INSUFFICIENT_ROLE");
  });

  it("a member CAN remove their own credential (self-service, no proof needed beyond the session itself)", async () => {
    const del = await agentMember.delete(`/api/auth/persona-credential/${memberId}`);
    expect(del.status).toBe(200);
    expect(del.body.persone.find(p => p.id === memberId).hasCredential).toBe(false);
  });

  it("an admin CAN remove a member's credential by role alone, without knowing their password", async () => {
    // Re-enroll member's credential first (removed by the previous test).
    const enroll = await agentAdmin.post("/api/auth/persona-credential").send({ personaId: memberId, newPassword: "member-password-2" });
    expect(enroll.status).toBe(200);

    const del = await agentAdmin.delete(`/api/auth/persona-credential/${memberId}`);
    expect(del.status).toBe(200);
    expect(del.body.persone.find(p => p.id === memberId).hasCredential).toBe(false);
  });

  it("an admin CANNOT remove the owner's credential — privilege tier protection", async () => {
    const del = await agentAdmin.delete(`/api/auth/persona-credential/${ownerId}`);
    expect(del.status).toBe(403);
    expect(del.body.error.code).toBe("INSUFFICIENT_ROLE");
  });

  it("the owner CAN remove their own, or another admin's, credential", async () => {
    const own = await agentOwner.delete(`/api/auth/persona-credential/${ownerId}`);
    expect(own.status).toBe(200);
    // Restore for hygiene, in case test order ever changes.
    await agentOwner.post("/api/auth/persona-credential").send({ personaId: ownerId, newPassword: "owner-password-1" });

    const other = await agentOwner.delete(`/api/auth/persona-credential/${adminId}`);
    expect(other.status).toBe(200);
  });
});
