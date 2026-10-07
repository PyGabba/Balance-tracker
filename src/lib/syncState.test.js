import { describe, it, expect } from "vitest";
import { deriveSyncState } from "./syncState.js";

describe("deriveSyncState", () => {
  it("everything saved on the server → synced", () => {
    expect(deriveSyncState({ online: true, pending: 0, failed: 0, syncing: false })).toEqual({ state: "synced", count: 0 });
    expect(deriveSyncState()).toEqual({ state: "synced", count: 0 });
  });
  it("online with queued changes → pending with the count", () => {
    expect(deriveSyncState({ pending: 2 })).toEqual({ state: "pending", count: 2 });
  });
  it("actively syncing → syncing", () => {
    expect(deriveSyncState({ pending: 1, syncing: true }).state).toBe("syncing");
  });
  it("offline wins over pending/syncing and keeps the queued count", () => {
    expect(deriveSyncState({ online: false, pending: 3, syncing: true })).toEqual({ state: "offline", count: 3 });
    expect(deriveSyncState({ online: false })).toEqual({ state: "offline", count: 0 });
  });
  it("failed operations win over everything, even offline", () => {
    expect(deriveSyncState({ online: false, pending: 2, failed: 1 })).toEqual({ state: "failed", count: 1 });
    expect(deriveSyncState({ failed: 4, syncing: true }).state).toBe("failed");
  });
});
