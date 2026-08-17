// ─── Migration framework (MOD-026) ───
// Replaces the one-off, hand-run scripts (migrate-household.js is the
// example that motivated this) with a small, reusable runner: migrations
// are numbered, tracked in a `schema_migrations` collection so each one
// runs at most once, support a dry-run mode that touches zero data, and
// log a structured result. A migration file is a plain module exporting
// { id, description, up(db, ctx) }.
//
// Design choices, on purpose:
// - No down()/rollback. Every migration in this codebase so far is
//   additive (adds a derived field, never removes/overwrites the
//   original) specifically so it doesn't need one — "undo" is just "stop
//   reading the new field." A migration that isn't naturally reversible
//   this way should be split into an additive step + a later, separate
//   contract step, not given a hand-rolled down().
// - up(db, ctx) receives the raw `db` (mongodb Db instance) and a ctx of
//   { dryRun, log } — not the whole app — so a migration can be unit
//   tested against a disposable in-memory Mongo the same way the API
//   integration tests already are (see testUtils.js), with no Express/
//   auth/etc in the way.
// - Idempotent by construction, not just by the schema_migrations guard:
//   every migration in server/migrations/*.js filters its update query on
//   "field not already set" so re-running one that already completed (or
//   was interrupted partway through) is always safe, matching the plan's
//   "migrations are idempotent" requirement independent of the bookkeeping
//   collection.

const MIGRATIONS_COLLECTION = "schema_migrations";

export async function getAppliedMigrations(db) {
  const docs = await db.collection(MIGRATIONS_COLLECTION).find({}).sort({ id: 1 }).toArray();
  return docs;
}

// Returns [{ id, description, status: "applied"|"pending", appliedAt?, docsAffected? }]
// for every migration in `migrations`, applied or not — the basis for both
// `migrate status` and deciding what `migrate up` still needs to run.
export async function migrationStatus(db, migrations) {
  const applied = await getAppliedMigrations(db);
  const appliedById = new Map(applied.map(a => [a.id, a]));
  return migrations.map(m => {
    const a = appliedById.get(m.id);
    return a
      ? { id: m.id, description: m.description, status: "applied", appliedAt: a.appliedAt, docsAffected: a.docsAffected }
      : { id: m.id, description: m.description, status: "pending" };
  });
}

// Runs every not-yet-applied migration in `migrations`, in the order given
// (callers should keep that order == numeric id order). Stops at the first
// failure rather than skipping ahead, so migrations that depend on an
// earlier one having run can't silently run out of order.
//
// dryRun: run each pending migration's up() with dryRun=true (no writes),
// report what it *would* do, and never write to schema_migrations — a
// dry run leaves the database and the migration history untouched.
export async function runMigrations(db, migrations, { dryRun = false, log = console.log } = {}) {
  const applied = await getAppliedMigrations(db);
  const appliedIds = new Set(applied.map(a => a.id));
  const results = [];

  for (const m of migrations) {
    if (appliedIds.has(m.id)) {
      results.push({ id: m.id, status: "skipped-already-applied" });
      continue;
    }
    log(`[migrate] running ${m.id}: ${m.description}${dryRun ? " (dry run)" : ""}`);
    const startedAt = new Date();
    let outcome;
    try {
      outcome = await m.up(db, { dryRun, log });
    } catch (err) {
      log(`[migrate] FAILED ${m.id}: ${err.message}`);
      results.push({ id: m.id, status: "failed", error: err.message });
      throw err; // stop the batch — later migrations may assume this one succeeded
    }
    const durationMs = Date.now() - startedAt.getTime();
    const docsAffected = outcome?.docsAffected ?? 0;
    log(`[migrate] ${dryRun ? "would affect" : "affected"} ${docsAffected} document(s) in ${durationMs}ms`);

    if (!dryRun) {
      await db.collection(MIGRATIONS_COLLECTION).insertOne({
        id: m.id,
        description: m.description,
        appliedAt: new Date(),
        durationMs,
        docsAffected,
      });
    }
    results.push({ id: m.id, status: dryRun ? "dry-run-ok" : "applied", docsAffected, durationMs });
  }
  return results;
}
