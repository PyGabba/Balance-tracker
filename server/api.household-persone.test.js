import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { startTestServer, stopTestServer } from "./testUtils.js";

// Regression tests for POST /api/household/persone — adding a new
// participant to an already-registered household.

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

describe("POST /api/household/persone — unattributed session", () => {
  it("a plain household-PIN session (no persona-login) can add a new persona", async () => {
    const agent = request.agent(app);
    const reg = await agent.post("/api/auth/register")
      .send({ nome: "Add Persona Household", persone: ["Gabriele"], pin: "551239" });
    expect(reg.status).toBe(201);

    const add = await agent.post("/api/household/persone").send({ nome: "Laura" });
    expect(add.status).toBe(201);
    const added = add.body.persone.find(p => p.nome === "Laura");
    expect(added).toBeTruthy();
    expect(added.ruolo).toBe("member");
    expect(added.hasCredential).toBe(false);
    expect(add.body.persone).toHaveLength(2);
  });

  it("rejects a missing name", async () => {
    const agent = request.agent(app);
    await agent.post("/api/auth/register").send({ nome: "Missing Name Household", persone: ["Gabriele"], pin: "551240" });
    const add = await agent.post("/api/household/persone").send({});
    expect(add.status).toBe(400);
    expect(add.body.error.code).toBe("MISSING_FIELDS");
  });

  it("disambiguates the generated id when a name collides with an existing persona", async () => {
    const agent = request.agent(app);
    await agent.post("/api/auth/register").send({ nome: "Collision Household", persone: ["Mario"], pin: "551241" });
    const firstId = (await agent.get("/api/household")).body.persone[0].id;

    const add = await agent.post("/api/household/persone").send({ nome: "Mario" });
    expect(add.status).toBe(201);
    const ids = add.body.persone.map(p => p.id);
    expect(ids.filter(id => id === firstId || id.startsWith(`${firstId}-`))).toHaveLength(2);
    expect(new Set(ids).size).toBe(2); // both ids unique
  });
});

describe("POST /api/household/persone — attributed sessions (MOD-025 Stage 2)", () => {
  let agentAdmin, agentMember;
  let adminId, memberId;

  beforeAll(async () => {
    const reg = await request(app).post("/api/auth/register").send({
      nome: "Add Persona Role Household",
      persone: [{ nome: "Owner" }, { nome: "Admin" }, { nome: "Member" }],
      pin: "551242",
    });
    expect(reg.status).toBe(201);
    const [ownerId, adm, mem] = reg.body.persone.map(p => p.id);
    adminId = adm; memberId = mem;

    const setup = request.agent(app);
    await setup.post("/api/auth/login").send({ pin: "551242" });
    await setup.put(`/api/household/persone/${adminId}/ruolo`).send({ ruolo: "admin" });
    await setup.put(`/api/household/persone/${memberId}/ruolo`).send({ ruolo: "member" });
    for (const [id, pw] of [[adminId, "admin-password-1"], [memberId, "member-password-1"]]) {
      const enroll = await setup.post("/api/auth/persona-credential").send({ personaId: id, newPassword: pw });
      expect(enroll.status).toBe(200);
    }

    agentAdmin = request.agent(app);
    await agentAdmin.post("/api/auth/login").send({ pin: "551242" });
    await loginAsPersona(agentAdmin, adminId, "admin-password-1");

    agentMember = request.agent(app);
    await agentMember.post("/api/auth/login").send({ pin: "551242" });
    await loginAsPersona(agentMember, memberId, "member-password-1");
  }, 30000);

  it("a member cannot add a new persona", async () => {
    const add = await agentMember.post("/api/household/persone").send({ nome: "Newcomer" });
    expect(add.status).toBe(403);
    expect(add.body.error.code).toBe("INSUFFICIENT_ROLE");
  });

  it("an admin CAN add a new persona, always at the default role", async () => {
    const add = await agentAdmin.post("/api/household/persone").send({ nome: "Newcomer", ruolo: "owner" });
    expect(add.status).toBe(201);
    const added = add.body.persone.find(p => p.nome === "Newcomer");
    expect(added.ruolo).toBe("member"); // ruolo in the body is ignored — can't self-elevate via this endpoint
  });
});
