// ─── Migration CLI (MOD-026) ───
// Usage:
//   node migrate.js status              — list every migration + applied/pending
//   node migrate.js up                  — run every pending migration
//   node migrate.js up --dry-run        — report what would change, write nothing
//
// Connects the same way the server does (MONGODB_URI / DB_NAME env vars,
// same defaults) via the app's own connectDB(), so this always targets
// exactly the database the server would.
//
// This does NOT back up the database first. Take a snapshot (e.g.
// `mongodump`, or your hosting provider's backup tool) before running
// `up` against production — every migration here is written to be
// additive/idempotent, but "the migration has a bug" is a risk no amount
// of idempotency removes, and the whole point of a backup is not needing
// the migration to be perfect.

import dotenv from "dotenv";
import { connectDB } from "./index.js";
import { migrations } from "./migrations/index.js";
import { migrationStatus, runMigrations } from "./migrations/runner.js";

dotenv.config();

const DB_NAME = process.env.DB_NAME || "finanza_tracker";

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const dryRun = rest.includes("--dry-run");

  const client = await connectDB();
  const db = client.db(DB_NAME);

  try {
    if (cmd === "status" || !cmd) {
      const statuses = await migrationStatus(db, migrations);
      for (const s of statuses) {
        const suffix = s.status === "applied" ? ` (${s.appliedAt.toISOString()}, ${s.docsAffected} doc(s))` : "";
        console.log(`${s.id}  [${s.status}]  ${s.description}${suffix}`);
      }
      return;
    }

    if (cmd === "up") {
      if (dryRun) console.log("--- DRY RUN: no data will be written ---");
      const results = await runMigrations(db, migrations, { dryRun });
      const ran = results.filter(r => r.status !== "skipped-already-applied");
      if (ran.length === 0) console.log("Nothing to do — every migration is already applied.");
      return;
    }

    console.error(`Unknown command: ${cmd}\nUsage: node migrate.js [status|up] [--dry-run]`);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

main().catch(err => {
  console.error("Migration run failed:", err);
  process.exitCode = 1;
});
