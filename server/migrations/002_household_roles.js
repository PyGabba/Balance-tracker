// ─── MOD-025 foundation: backfill persone[].ruolo ───
//
// Adds a `ruolo` field to every persona in every household that doesn't
// already have one — first persona in the array becomes "owner", every
// other one "member". Purely additive: only sets a field that's currently
// absent, never overwrites an existing one, so re-running it (or running
// it against a household someone already assigned roles to by hand) is a
// no-op for anything it already touched.
//
// See server/validation.js's validateRuolo comment for what this field
// does and — just as importantly — doesn't do: it's a household-visible
// label, not an authentication/authorization boundary. Every member still
// shares the same PIN and the same session.

const BATCH_SIZE = 500;

async function up(db, { dryRun }) {
  const col = db.collection("households");
  // $elemMatch, not a dotted "persone.ruolo" path — that would only match
  // when NO element has the field at all, not "at least one is missing it"
  // (a household where persona 0 already has a hand-set ruolo but persona
  // 1 doesn't needs to match too).
  const cursor = col.find({ persone: { $elemMatch: { ruolo: { $exists: false } } } });
  let docsAffected = 0;
  let batch = [];
  async function flush() {
    if (batch.length === 0) return;
    if (!dryRun) await col.bulkWrite(batch, { ordered: false });
    docsAffected += batch.length;
    batch = [];
  }
  for await (const household of cursor) {
    const persone = (household.persone || []).map((p, i) =>
      p.ruolo ? p : { ...p, ruolo: i === 0 ? "owner" : "member" }
    );
    batch.push({ updateOne: { filter: { _id: household._id }, update: { $set: { persone } } } });
    if (batch.length >= BATCH_SIZE) await flush();
  }
  await flush();
  return { docsAffected };
}

export default {
  id: "002",
  description: "Backfill persone[].ruolo — first persona owner, rest member (MOD-025 foundation)",
  up,
};
