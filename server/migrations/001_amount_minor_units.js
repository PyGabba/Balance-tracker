// ─── MOD-016 storage migration: additive *MinorUnits companion fields ───
//
// Adds an integer minor-units companion field next to every existing
// decimal money field, WITHOUT touching the decimal field itself:
//   transactions.importo            -> importoMinorUnits
//   transactions.importoOriginale   -> importoOriginaleMinorUnits
//   accounts.saldoIniziale          -> saldoInizialeMinorUnits
//   goals.targetAmount              -> targetAmountMinorUnits
//   goals.currentAmount             -> currentAmountMinorUnits
//   positions.prezzoAcquisto        -> prezzoAcquistoMinorUnits
//   trips.expenses[].importo        -> trips.expenses[].importoMinorUnits
//
// This is the "expand" half of an expand/contract migration: purely
// additive, so "existing data can be migrated without changing balances"
// (MOD-016's acceptance criterion) holds by construction — nothing is
// removed or overwritten, every read path that exists today keeps reading
// the untouched decimal field. Making importoMinorUnits the canonical
// field (and dropping the decimal one) is a separate future "contract"
// migration, deliberately not part of this one.
//
// Precision: uses lib/money.js's default (2 decimals) for every document,
// not a per-household currency lookup — every household in this app has
// always used a 2-decimal-precision base currency in practice, and the
// existing pre-migration code (validateAmount, applyValutaTransazione,
// etc.) already rounded to 2 decimals unconditionally. A household that
// somehow used a 0-decimal currency would get a wrong companion value
// here; nothing currently in this app makes that reachable, but it's
// worth knowing about before ever exposing currency choice more broadly.

import { toMinorUnits } from "../../src/lib/money.js";

const BATCH_SIZE = 500;

// [decimal field, minor-units field] pairs per top-level collection.
const TARGETS = [
  { collection: "transactions", fields: [["importo", "importoMinorUnits"], ["importoOriginale", "importoOriginaleMinorUnits"]] },
  { collection: "accounts", fields: [["saldoIniziale", "saldoInizialeMinorUnits"]] },
  { collection: "goals", fields: [["targetAmount", "targetAmountMinorUnits"], ["currentAmount", "currentAmountMinorUnits"]] },
  { collection: "positions", fields: [["prezzoAcquisto", "prezzoAcquistoMinorUnits"]] },
];

async function migrateCollectionFields(db, collectionName, fields, { dryRun }) {
  const col = db.collection(collectionName);
  const orClauses = fields.map(([dec, min]) => ({ [dec]: { $type: "number" }, [min]: { $exists: false } }));
  const cursor = col.find({ $or: orClauses });
  let docsAffected = 0;
  let batch = [];
  async function flush() {
    if (batch.length === 0) return;
    if (!dryRun) await col.bulkWrite(batch, { ordered: false });
    docsAffected += batch.length;
    batch = [];
  }
  for await (const doc of cursor) {
    const set = {};
    for (const [dec, min] of fields) {
      if (typeof doc[dec] === "number" && doc[min] === undefined) {
        set[min] = toMinorUnits(doc[dec]);
      }
    }
    if (Object.keys(set).length === 0) continue;
    batch.push({ updateOne: { filter: { _id: doc._id }, update: { $set: set } } });
    if (batch.length >= BATCH_SIZE) await flush();
  }
  await flush();
  return docsAffected;
}

// Trip expenses live in an embedded array, so "field missing on some
// element" can't be expressed as cleanly as the top-level $or above — this
// collection gets its own pass, rewriting the whole expenses array per trip
// (only for trips that actually have a expense needing it).
async function migrateTripExpenses(db, { dryRun }) {
  const col = db.collection("trips");
  const cursor = col.find({ "expenses.importo": { $type: "number" }, "expenses.importoMinorUnits": { $exists: false } });
  let docsAffected = 0;
  let batch = [];
  async function flush() {
    if (batch.length === 0) return;
    if (!dryRun) await col.bulkWrite(batch, { ordered: false });
    docsAffected += batch.length;
    batch = [];
  }
  for await (const trip of cursor) {
    const expenses = (trip.expenses || []).map(e =>
      (typeof e.importo === "number" && e.importoMinorUnits === undefined)
        ? { ...e, importoMinorUnits: toMinorUnits(e.importo) }
        : e
    );
    batch.push({ updateOne: { filter: { _id: trip._id }, update: { $set: { expenses } } } });
    if (batch.length >= BATCH_SIZE) await flush();
  }
  await flush();
  return docsAffected;
}

async function up(db, ctx) {
  let docsAffected = 0;
  for (const { collection, fields } of TARGETS) {
    const n = await migrateCollectionFields(db, collection, fields, ctx);
    if (n > 0) ctx.log(`[migrate 001]   ${collection}: ${n} doc(s)`);
    docsAffected += n;
  }
  const tripDocs = await migrateTripExpenses(db, ctx);
  if (tripDocs > 0) ctx.log(`[migrate 001]   trips: ${tripDocs} doc(s)`);
  docsAffected += tripDocs;
  return { docsAffected };
}

export default {
  id: "001",
  description: "Add *MinorUnits companion fields alongside existing decimal money fields (MOD-016)",
  up,
};
