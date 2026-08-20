import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { startTestServer, stopTestServer } from "./testUtils.js";

// Regression tests for DELETE /api/household/persone/:id — removing a
// participant from an already-registered household.

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

describe("DELETE /api/household/persone/:id — unattributed session", () => {
  it("a plain household-PIN session (no persona-login) can remove a persona", async () => {
    const agent = request.agent(app);
    const reg = await agent.post("/api/auth/register")
      .send({ nome: "Remove Persona Household", persone: ["Gabriele", "Laura"], pin: "661239" });
    expect(reg.status).toBe(201);
    const lauraId = reg.body.persone[1].id;

    const del = await agent.delete(`/api/household/persone/${lauraId}`);
    expect(del.status).toBe(200);
    expect(del.body.persone).toHaveLength(1);
    expect(del.body.persone.find(p => p.id === lauraId)).toBeUndefined();
  });

  it("refuses to remove the last remaining persona", async () => {
    const agent = request.agent(app);
    await agent.post("/api/auth/register").send({ nome: "Solo Household", persone: ["Gabriele"], pin: "661240" });
    const soloId = (await agent.get("/api/household")).body.persone[0].id;

    const del = await agent.delete(`/api/household/persone/${soloId}`);
    expect(del.status).toBe(400);
    expect(del.body.error.code).toBe("LAST_PERSONA");
  });

  it("refuses to remove the last owner even with other persone present", async () => {
    const agent = request.agent(app);
    const reg = await agent.post("/api/auth/register")
      .send({ nome: "Last Owner Household", persone: ["Gabriele", "Laura"], pin: "661241" });
    const ownerId = reg.body.persone[0].id;

    const del = await agent.delete(`/api/household/persone/${ownerId}`);
    expect(del.status).toBe(400);
    expect(del.body.error.code).toBe("LAST_OWNER");
  });

  it("404s for an unknown persona id", async () => {
    const agent = request.agent(app);
    await agent.post("/api/auth/register").send({ nome: "Unknown Id Household", persone: ["Gabriele", "Laura"], pin: "661242" });
    const del = await agent.delete("/api/household/persone/nonexistent");
    expect(del.status).toBe(404);
  });
});

describe("DELETE /api/household/persone/:id — attributed sessions (MOD-025 Stage 2)", () => {
  let agentOwner, agentAdmin;
  let ownerId, adminId, memberId;

  beforeAll(async () => {
    const reg = await request(app).post("/api/auth/register").send({
      nome: "Remove Persona Role Household",
      persone: [{ nome: "Owner" }, { nome: "Admin" }, { nome: "Member" }],
      pin: "661243",
    });
    expect(reg.status).toBe(201);
    [ownerId, adminId, memberId] = reg.body.persone.map(p => p.id);

    const setup = request.agent(app);
    await setup.post("/api/auth/login").send({ pin: "661243" });
    await setup.put(`/api/household/persone/${adminId}/ruolo`).send({ ruolo: "admin" });
    await setup.put(`/api/household/persone/${memberId}/ruolo`).send({ ruolo: "member" });
    for (const [id, pw] of [[ownerId, "owner-password-1"], [adminId, "admin-password-1"]]) {
      const enroll = await setup.post("/api/auth/persona-credential").send({ personaId: id, newPassword: pw });
      expect(enroll.status).toBe(200);
    }

    agentOwner = request.agent(app);
    await agentOwner.post("/api/auth/login").send({ pin: "661243" });
    await loginAsPersona(agentOwner, ownerId, "owner-password-1");

    agentAdmin = request.agent(app);
    await agentAdmin.post("/api/auth/login").send({ pin: "661243" });
    await loginAsPersona(agentAdmin, adminId, "admin-password-1");
  }, 30000);

  it("an admin cannot remove a persona — owner-only", async () => {
    const del = await agentAdmin.delete(`/api/household/persone/${memberId}`);
    expect(del.status).toBe(403);
    expect(del.body.error.code).toBe("INSUFFICIENT_ROLE");
  });

  it("the owner cannot remove themselves via this endpoint", async () => {
    const del = await agentOwner.delete(`/api/household/persone/${ownerId}`);
    expect(del.status).toBe(400);
    expect(del.body.error.code).toBe("CANNOT_REMOVE_SELF");
  });

  it("the owner CAN remove the admin", async () => {
    const del = await agentOwner.delete(`/api/household/persone/${adminId}`);
    expect(del.status).toBe(200);
    expect(del.body.persone.find(p => p.id === adminId)).toBeUndefined();
  });

  it("removal revokes the removed persona's active sessions", async () => {
    // Re-enroll and log in as the member, then have the owner remove them.
    await agentOwner.post("/api/auth/persona-credential").send({ personaId: memberId, newPassword: "member-password-1" });
    const memberAgent = request.agent(app);
    await memberAgent.post("/api/auth/login").send({ pin: "661243" });
    await loginAsPersona(memberAgent, memberId, "member-password-1");

    const before = await memberAgent.get("/api/household");
    expect(before.status).toBe(200);

    const del = await agentOwner.delete(`/api/household/persone/${memberId}`);
    expect(del.status).toBe(200);

    const after = await memberAgent.get("/api/household");
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe("SESSION_EXPIRED");
  });
});
