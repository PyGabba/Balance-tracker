import { describe, it, expect } from "vitest";
import { app } from "./index.js";

// Regression: PUT /api/positions/:id was registered BEFORE
// PUT /api/positions/prices in server/routes/positions.js. Express matches
// routes for a given method in registration order, and ":id" matches ANY
// single path segment — including the literal string "prices" — so every
// PUT to /api/positions/prices was being swallowed by the :id handler,
// which rejected it with 400 INVALID_ID (since "prices" isn't a valid
// MongoDB ObjectId) before the real handler ever ran. This bug predates
// this test and this whole server/routes/ split — it was already present
// in the original single-file server/index.js, just never hit until
// someone actually tried the manual-price-save feature.
//
// Doesn't need a live MongoDB (no startTestServer()/mongodb-memory-server)
// — it only inspects Express's registered route stack, which is built at
// import time regardless of whether connectDB() ever runs. That's
// deliberate: every other server/*.test.js file in this repo is blocked
// from running in a sandboxed environment where the mongodb-memory-server
// binary download is network-policy-blocked (see CLAUDE.md) — this one
// isn't, and it's exactly the kind of bug that class of test exists to
// catch but, in this case, nobody could actually run.

function routeEntries(path) {
  const entries = [];
  function walk(stack) {
    for (const layer of stack) {
      if (layer.route) {
        entries.push({ methods: Object.keys(layer.route.methods), path: layer.route.path });
      } else if (layer.name === "router" && layer.handle.stack) {
        walk(layer.handle.stack);
      }
    }
  }
  walk(app._router.stack);
  return entries.filter(e => e.path === path);
}

function registrationIndexOf(method, path) {
  const all = [];
  function walk(stack) {
    for (const layer of stack) {
      if (layer.route) {
        all.push({ methods: Object.keys(layer.route.methods), path: layer.route.path });
      } else if (layer.name === "router" && layer.handle.stack) {
        walk(layer.handle.stack);
      }
    }
  }
  walk(app._router.stack);
  return all.findIndex(e => e.methods.includes(method) && e.path === path);
}

describe("Express route registration order", () => {
  it("every literal /api/positions/prices* route is registered, exactly once per method", () => {
    expect(routeEntries("/api/positions/prices").length).toBeGreaterThan(0);
  });

  it("PUT /api/positions/prices is registered BEFORE PUT /api/positions/:id (the literal path must win the match)", () => {
    const pricesIdx = registrationIndexOf("put", "/api/positions/prices");
    const idIdx = registrationIndexOf("put", "/api/positions/:id");
    expect(pricesIdx).toBeGreaterThanOrEqual(0);
    expect(idIdx).toBeGreaterThanOrEqual(0);
    expect(pricesIdx).toBeLessThan(idIdx);
  });

  it("DELETE /api/positions/prices/:ticker is registered before DELETE /api/positions/:id (defense in depth, even though different segment counts don't actually collide)", () => {
    const ticketIdx = registrationIndexOf("delete", "/api/positions/prices/:ticker");
    const idIdx = registrationIndexOf("delete", "/api/positions/:id");
    expect(ticketIdx).toBeGreaterThanOrEqual(0);
    expect(idIdx).toBeGreaterThanOrEqual(0);
    expect(ticketIdx).toBeLessThan(idIdx);
  });
});
