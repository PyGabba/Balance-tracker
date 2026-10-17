// ─── Portfolio mirrors stop counting as spending ───
//
// A position funded from a household account stores a linked "mirror"
// transaction so the account's balance follows the cash. It used to be
// stored as an uscita (buy) / entrata (sell) with categoria "investimenti",
// which — because every expense/income total in the app keys off
// tipo === "uscita"/"entrata" — made an investment count as an expense and a
// sale as income.
//
// The API now records the mirror as a single-sided transfer instead (contoDa
// for a buy, contoA for a sell): the money still leaves/enters the account
// (calcolaSaldiConti and the widget both handle a transfer with one side
// missing), but it is no longer spending or income. This rewrites the
// mirrors that already exist so past months read the same way as new
// investments. Idempotent: a converted mirror is a trasferimento and no
// longer matches the query.

const BATCH_SIZE = 500;

async function up(db, { dryRun = false, log = () => {} } = {}) {
  const col = db.collection("transactions");
  const cursor = col.find({
    positionId: { $exists: true, $ne: null },
    tipo: { $in: ["uscita", "entrata"] },
  });

  let docsAffected = 0;
  let batch = [];
  async function flush() {
    if (batch.length === 0) return;
    if (!dryRun) await col.bulkWrite(batch, { ordered: false });
    docsAffected += batch.length;
    batch = [];
  }

  for await (const t of cursor) {
    const vendita = t.tipo === "entrata";
    const contoId = t.contoId ?? null;
    batch.push({
      updateOne: {
        filter: { _id: t._id },
        update: {
          $set: {
            tipo: "trasferimento",
            contoDa: vendita ? null : contoId,
            contoA: vendita ? contoId : null,
          },
          // The transfer shape has no category and no single contoId.
          $unset: { contoId: "", categoria: "" },
        },
      },
    });
    if (batch.length >= BATCH_SIZE) await flush();
  }
  await flush();

  if (docsAffected > 0) log(`[migrate 003]   transactions: ${docsAffected} doc(s)`);
  return { docsAffected };
}

export default {
  id: "003",
  description: "Store portfolio-linked transactions as single-sided transfers (not expenses/incomes)",
  up,
};
