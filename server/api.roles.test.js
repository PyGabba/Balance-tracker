import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { startTestServer, stopTestServer } from "./testUtils.js";

let app;
let agent;
let persone;

beforeAll(async () => {
  app = await startTestServer();
  agent = request.agent(app);
  const reg = await agent
    .post("/api/auth/register")
    .send({ nome: "Test Household Roles", persone: ["Gabriele", "Laura", "Ospite"], pin: "297145" });
  expect(reg.status).toBe(201);
  persone = reg.body.persone;
}, 60000);

afterAll(async () => {
  await stopTestServer();
});

describe("household member roles (MOD-025 foundation)", () => {
  it("the first registered persona defaults to owner, the rest to member", () => {
    expect(persone[0].ruolo).toBe("owner");
    expect(persone[1].ruolo).toBe("member");
    expect(persone[2].ruolo).toBe("member");
  });

  it("GET /api/household returns the roles", async () => {
    const res = await agent.get("/api/household");
    expect(res.status).toBe(200);
    expect(res.body.persone[0].ruolo).toBe("owner");
  });

  it("changes a persona's role", async () => {
    const target = persone[1].id;
    const res = await agent.put(`/api/household/persone/${target}/ruolo`).send({ ruolo: "admin" });
    expect(res.status).toBe(200);
    expect(res.body.persone.find(p => p.id === target).ruolo).toBe("admin");
  });

  it("rejects an unknown role", async () => {
    const res = await agent.put(`/api/household/persone/${persone[2].id}/ruolo`).send({ ruolo: "superadmin" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_ROLE");
  });

  it("404s on an unknown persona id", async () => {
    const res = await agent.put("/api/household/persone/nonexistent/ruolo").send({ ruolo: "admin" });
    expect(res.status).toBe(404);
  });

  it("refuses to demote the household's last owner", async () => {
    const res = await agent.put(`/api/household/persone/${persone[0].id}/ruolo`).send({ ruolo: "member" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("LAST_OWNER");
    const check = await agent.get("/api/household");
    expect(check.body.persone[0].ruolo).toBe("owner"); // unchanged
  });

  it("allows demoting an owner once a second owner exists", async () => {
    // Promote persona[2] to owner first, so there are two.
    const promote = await agent.put(`/api/household/persone/${persone[2].id}/ruolo`).send({ ruolo: "owner" });
    expect(promote.status).toBe(200);

    const demote = await agent.put(`/api/household/persone/${persone[0].id}/ruolo`).send({ ruolo: "guest" });
    expect(demote.status).toBe(200);
    expect(demote.body.persone.find(p => p.id === persone[0].id).ruolo).toBe("guest");
  });

  it("rejects an unauthenticated request", async () => {
    const res = await request(app).put(`/api/household/persone/${persone[0].id}/ruolo`).send({ ruolo: "admin" });
    expect(res.status).toBe(401);
  });
});
