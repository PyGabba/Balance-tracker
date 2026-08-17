import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient } from "mongodb";
import { migrationStatus, runMigrations, getAppliedMigrations } from "./runner.js";

let mongod, client, db;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db("migration_runner_test");
});

afterAll(async () => {
  await client?.close();
  await mongod?.stop();
});

beforeEach(async () => {
  const collections = await db.listCollections().toArray();
  await Promise.all(collections.map(c => db.collection(c.name).deleteMany({})));
});

function fakeMigration(id, { docsAffected = 3, shouldFail = false } = {}) {
  return {
    id,
    description: `test migration ${id}`,
    up: async (_db, { dryRun }) => {
      if (shouldFail) throw new Error(`boom in ${id}`);
      return { docsAffected: dryRun ? docsAffected : docsAffected };
    },
  };
}

describe("runMigrations", () => {
  it("applies a pending migration and records it", async () => {
    const results = await runMigrations(db, [fakeMigration("001")], { log: () => {} });
    expect(results).toEqual([{ id: "001", status: "applied", docsAffected: 3, durationMs: expect.any(Number) }]);
    const applied = await getAppliedMigrations(db);
    expect(applied).toHaveLength(1);
    expect(applied[0].id).toBe("001");
    expect(applied[0].docsAffected).toBe(3);
  });

  it("skips a migration that's already applied", async () => {
    await runMigrations(db, [fakeMigration("001")], { log: () => {} });
    const second = await runMigrations(db, [fakeMigration("001")], { log: () => {} });
    expect(second).toEqual([{ id: "001", status: "skipped-already-applied" }]);
    const applied = await getAppliedMigrations(db);
    expect(applied).toHaveLength(1); // not recorded twice
  });

  it("dry run reports what would happen and writes nothing to history", async () => {
    const results = await runMigrations(db, [fakeMigration("001")], { dryRun: true, log: () => {} });
    expect(results).toEqual([{ id: "001", status: "dry-run-ok", docsAffected: 3, durationMs: expect.any(Number) }]);
    const applied = await getAppliedMigrations(db);
    expect(applied).toHaveLength(0);
  });

  it("runs multiple pending migrations in order and stops on the first failure", async () => {
    const order = [];
    const m1 = { id: "001", description: "a", up: async () => { order.push("001"); return { docsAffected: 1 }; } };
    const m2 = { id: "002", description: "b", up: async () => { order.push("002"); throw new Error("boom"); } };
    const m3 = { id: "003", description: "c", up: async () => { order.push("003"); return { docsAffected: 1 }; } };

    await expect(runMigrations(db, [m1, m2, m3], { log: () => {} })).rejects.toThrow("boom");
    expect(order).toEqual(["001", "002"]); // 003 never ran
    const applied = await getAppliedMigrations(db);
    expect(applied.map(a => a.id)).toEqual(["001"]); // only the one that succeeded is recorded
  });
});

describe("migrationStatus", () => {
  it("reports pending for migrations that haven't run and applied for those that have", async () => {
    await runMigrations(db, [fakeMigration("001")], { log: () => {} });
    const statuses = await migrationStatus(db, [fakeMigration("001"), fakeMigration("002")]);
    expect(statuses).toEqual([
      { id: "001", description: "test migration 001", status: "applied", appliedAt: expect.any(Date), docsAffected: 3 },
      { id: "002", description: "test migration 002", status: "pending" },
    ]);
  });
});
