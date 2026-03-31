// migrate-household.js
// Run once to add householdId to all existing transactions
//
// Usage:
//   node migrate-household.js
//
// Or with custom connection string:
//   MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net node migrate-household.js

import { MongoClient } from "mongodb";
import dotenv from "dotenv";

dotenv.config();

const MONGO_URI = process.env.MONGODB_URI || "mongodb://localhost:27017";
const DB_NAME = process.env.DB_NAME || "finanza_tracker";
const HOUSEHOLD_ID = "laura-gabriele"; // ← change if needed

async function migrate() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(DB_NAME);
  const col = db.collection("transactions");

  // Count docs without householdId
  const count = await col.countDocuments({ householdId: { $exists: false } });
  console.log(`Found ${count} transactions without householdId`);

  if (count === 0) {
    console.log("Nothing to migrate!");
    await client.close();
    return;
  }

  // Update all docs that don't have householdId
  const result = await col.updateMany(
    { householdId: { $exists: false } },
    { $set: { householdId: HOUSEHOLD_ID } }
  );

  console.log(`Updated ${result.modifiedCount} transactions → householdId: "${HOUSEHOLD_ID}"`);

  // Verify
  const verify = await col.countDocuments({ householdId: HOUSEHOLD_ID });
  console.log(`Total transactions for "${HOUSEHOLD_ID}": ${verify}`);

  await client.close();
  console.log("Done!");
}

migrate().catch(err => {
  console.error("Migration failed:", err);
  process.exit(1);
});
