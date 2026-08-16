// ─── Shared test harness (MOD-014) ───
// Spins up a disposable in-memory MongoDB (mongodb-memory-server) and wires
// the real Express app (server/index.js) to it via the same connectDB()
// used in production, just pointed at a throwaway URI/db name instead of a
// real MongoDB deployment. No Docker, no network dependency beyond the
// one-time mongod binary download the first time this runs on a machine.
import { MongoMemoryServer } from "mongodb-memory-server";
import { app, connectDB } from "./index.js";

const TEST_DB_NAME = "balance_tracker_test";

let mongod;
let client;

export async function startTestServer() {
  mongod = await MongoMemoryServer.create();
  client = await connectDB(mongod.getUri(), TEST_DB_NAME);
  return app;
}

export async function stopTestServer() {
  await client?.close();
  await mongod?.stop();
}

// Wipes every collection between tests so one test's data can never leak
// into another's — cheaper than tearing down/recreating the whole in-memory
// instance per test.
export async function clearCollections() {
  if (!client) return;
  const db = client.db(TEST_DB_NAME);
  const collections = await db.listCollections().toArray();
  await Promise.all(collections.map(c => db.collection(c.name).deleteMany({})));
}

export function getDb() {
  return client.db(TEST_DB_NAME);
}
