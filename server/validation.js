// ─── Centralized transaction validation (MOD-001, MOD-002) ───
// Single source of truth for validating transaction input, used by
// POST /api/transactions, PUT /api/transactions/:id, and (via the shared
// helpers below) POST /api/widget/transaction. Every entry point that can
// create or modify a transaction runs the same rules, so a client can't get
// looser validation just by hitting a different endpoint.
//
// Pure functions only — no MongoDB/Express imports — so this module can be
// unit-tested in isolation (see validation.test.js). (randomUUID is a pure
// Node builtin, not a framework/DB dependency, so it's fine to use here.)

import { randomUUID } from "crypto";

export const TRANSACTION_TYPES = ["uscita", "entrata", "saldo", "trasferimento"];

// Percentage-point tolerance for split totals. Generous enough for 3-way
// splits like 33.33 + 33.33 + 33.34 = 100.00, tight enough that 40 + 40
// (=80) is still rejected instead of silently normalized.
export const SPLIT_QUOTA_TOLERANCE = 0.05;

export class ValidationError extends Error {
  constructor(code, message, fields = {}) {
    super(message);
    this.name = "ValidationError";
    this.code = code;
    this.fields = fields;
  }
}

export function sanitizeText(s, maxLen = 500) {
  if (s == null) return "";
  return String(s).trim().slice(0, maxLen);
}

export function isPlainId(v, maxLen = 50) {
  return typeof v === "string" && v.trim().length > 0 && v.trim().length <= maxLen;
}

// ─── Reusable participant-membership check (MOD-009) ───
// One small predicate used everywhere a client-supplied id must belong to
// a specific set of known participants — household members (+ any ad-hoc
// extraPersone declared on the same request) for transactions, below, or
// a trip's own partecipanti for trip expenses (a deliberately DIFFERENT
// set — trip guests who joined via a share link are never household
// members, see buildTripExpense further down). The set of valid ids
// differs by context; the membership check itself doesn't need to.
export function isKnownParticipant(id, participantIds) {
  return isPlainId(id) && participantIds.has(id);
}

// Rounded to 2 decimal places on the way in so floating-point noise
// (0.1 + 0.2 style artifacts) never propagates into stored balances. This
// still stores a decimal number (e.g. 12.34), not integer minor units
// (1234) — a true integer-cents money model is a separate, larger change
// (see MOD-016 in the modification plan) not yet implemented.
export function validateAmount(raw) {
  const n = typeof raw === "number" ? raw : parseFloat(raw);
  if (!Number.isFinite(n)) {
    throw new ValidationError("INVALID_AMOUNT", "Importo non valido", { importo: raw });
  }
  if (n <= 0) {
    throw new ValidationError("INVALID_AMOUNT", "L'importo deve essere maggiore di zero", { importo: raw });
  }
  return Math.round(n * 100) / 100;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function validateDateStr(raw) {
  if (typeof raw !== "string" || !DATE_RE.test(raw)) {
    throw new ValidationError("INVALID_DATE", "Data non valida", { data: raw });
  }
  const [y, m, d] = raw.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  // Rejects calendar-impossible dates (e.g. 2026-02-30) that Date would
  // otherwise silently roll forward into March.
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw new ValidationError("INVALID_DATE", "Data non valida", { data: raw });
  }
  return raw;
}

export function validateType(raw) {
  if (!TRANSACTION_TYPES.includes(raw)) {
    throw new ValidationError("INVALID_TYPE", "Tipo non valido", { tipo: raw });
  }
  return raw;
}

// extraPersone declared inline on the SAME request is the sanctioned way to
// add an ad-hoc split participant (e.g. a one-off guest) without them being
// a full household member — this mirrors the trip-guest feature. Anything
// malformed is rejected outright rather than silently dropped, since a
// dropped-but-referenced id would otherwise fail split validation anyway
// with a confusing error.
export function validateExtraPersone(arr) {
  if (arr == null) return [];
  if (!Array.isArray(arr)) throw new ValidationError("INVALID_EXTRA_PEOPLE", "Persone extra non valide", {});
  if (arr.length > 20) throw new ValidationError("TOO_MANY_EXTRA_PEOPLE", "Troppe persone extra", {});
  const seen = new Set();
  const out = [];
  for (const p of arr) {
    if (!p || typeof p !== "object" || !isPlainId(p.id) || !sanitizeText(p.nome, 100)) {
      throw new ValidationError("INVALID_EXTRA_PERSON", "Persona extra non valida", { extraPersone: p });
    }
    if (seen.has(p.id)) throw new ValidationError("DUPLICATE_EXTRA_PERSON", "Persona extra duplicata", { id: p.id });
    seen.add(p.id);
    out.push({ id: sanitizeText(p.id, 50), nome: sanitizeText(p.nome, 100) });
  }
  return out;
}

// Non-throwing core of split validation: quotas 0-100, known participants
// only, no duplicates, total 100 within SPLIT_QUOTA_TOLERANCE. Returns the
// cleaned array, or null if anything about the input is invalid. Shared by
// the strict validator (validateSplits, throws) and the widget endpoint
// (which prefers to drop an invalid split rather than fail the whole write)
// so both entry points apply literally the same rule, not just the same
// tolerance number.
export function computeValidSplits(arr, validParticipantIds, { maxParticipants = 20 } = {}) {
  if (!Array.isArray(arr) || arr.length === 0 || arr.length > maxParticipants) return null;
  const seen = new Set();
  const out = [];
  let total = 0;
  for (const s of arr) {
    if (!s || typeof s !== "object") return null;
    const quota = typeof s.quota === "number" ? s.quota : parseFloat(s.quota);
    if (!Number.isFinite(quota) || quota < 0 || quota > 100) return null;
    if (!isPlainId(s.personaId)) return null;
    if (validParticipantIds && !validParticipantIds.has(s.personaId)) return null;
    if (seen.has(s.personaId)) return null;
    seen.add(s.personaId);
    total += quota;
    out.push({ personaId: sanitizeText(s.personaId, 50), quota });
  }
  if (Math.abs(total - 100) > SPLIT_QUOTA_TOLERANCE) return null;
  return out;
}

// Strict version for the main transaction endpoints: throws with a specific
// reason instead of just returning null, so the client (and frontend
// pre-submit check) can tell "40+40≠100" apart from "unknown participant".
export function validateSplits(arr, validParticipantIds) {
  if (arr == null) return null;
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new ValidationError("INVALID_SPLITS", "Ripartizione non valida", {});
  }
  if (arr.length > 20) {
    throw new ValidationError("TOO_MANY_SPLITS", "Troppi partecipanti nella ripartizione", {});
  }
  const seen = new Set();
  const out = [];
  let total = 0;
  for (const s of arr) {
    if (!s || typeof s !== "object") {
      throw new ValidationError("INVALID_SPLITS", "Voce di ripartizione non valida", {});
    }
    const quota = typeof s.quota === "number" ? s.quota : parseFloat(s.quota);
    if (!Number.isFinite(quota) || quota < 0 || quota > 100) {
      throw new ValidationError("INVALID_SPLIT_QUOTA", "Quota di ripartizione non valida (deve essere 0-100)", { personaId: s.personaId, quota: s.quota });
    }
    if (!isPlainId(s.personaId)) {
      throw new ValidationError("INVALID_SPLIT_PARTICIPANT", "Partecipante non valido", { personaId: s.personaId });
    }
    if (validParticipantIds && !validParticipantIds.has(s.personaId)) {
      throw new ValidationError("UNKNOWN_SPLIT_PARTICIPANT", "Partecipante non appartenente alla casa", { personaId: s.personaId });
    }
    if (seen.has(s.personaId)) {
      throw new ValidationError("DUPLICATE_SPLIT_PARTICIPANT", "Partecipante duplicato nella ripartizione", { personaId: s.personaId });
    }
    seen.add(s.personaId);
    total += quota;
    out.push({ personaId: sanitizeText(s.personaId, 50), quota });
  }
  if (Math.abs(total - 100) > SPLIT_QUOTA_TOLERANCE) {
    throw new ValidationError("SPLIT_TOTAL_NOT_100", `Le quote devono sommare a 100 (attuale: ${Math.round(total * 100) / 100})`, { total });
  }
  return out;
}

const RICORRENZA_FREQUENZE = ["settimanale", "mensile", "trimestrale", "annuale"];
export function validateRicorrenza(r) {
  if (r == null) return null;
  if (typeof r !== "object" || !RICORRENZA_FREQUENZE.includes(r.frequenza)) {
    throw new ValidationError("INVALID_RECURRENCE", "Ricorrenza non valida", {});
  }
  validateDateStr(r.prossimaData);
  return { frequenza: r.frequenza, prossimaData: r.prossimaData, variabile: !!r.variabile };
}

/**
 * Central validator for transaction create/update payloads.
 *
 * - `householdPersonIds`: array of household member ids.
 * - `accountIds`: Set of account ids that really belong to this household.
 * - `partial`: true for PUT (only validates/returns fields present in body).
 * - `existing`: the current document, required when partial=true so
 *   cross-field rules (e.g. transfer accounts) see the full picture even
 *   when the request only patches one field.
 *
 * Throws ValidationError on the first problem found. Returns a plain object
 * with only the validated/normalized fields — safe to spread directly into
 * a $set or insertOne document. Currency conversion (valuta/importoOriginale/
 * tassoCambio) is intentionally NOT handled here — see applyValutaTransazione
 * in index.js (MOD-005), which needs the live exchange-rate table.
 */
export function validateTransactionInput(body, { householdPersonIds = [], accountIds = new Set(), partial = false, existing = null } = {}) {
  const b = body || {};
  const doc = {};
  const get = (key) => (b[key] !== undefined ? b[key] : (partial ? existing?.[key] : undefined));

  if (!partial || b.tipo !== undefined) doc.tipo = validateType(get("tipo"));
  if (!partial || b.importo !== undefined) doc.importo = validateAmount(get("importo"));
  if (!partial || b.data !== undefined) doc.data = validateDateStr(get("data"));

  // Participants known to this request: household members + any ad-hoc
  // extraPersone declared on this same request (or already on the existing
  // doc, for a partial update that doesn't touch extraPersone).
  const extraPersone = b.extraPersone !== undefined
    ? validateExtraPersone(b.extraPersone)
    : (partial ? (existing?.extraPersone || []) : []);
  const participantIds = new Set([...householdPersonIds, ...extraPersone.map(p => p.id)]);

  function validatePersonRef(key) {
    const v = get(key);
    if (v == null || v === "") return null;
    if (!isKnownParticipant(v, participantIds)) {
      throw new ValidationError("UNKNOWN_PARTICIPANT", `Partecipante non valido: ${key}`, { [key]: v });
    }
    return v;
  }
  if (!partial || b.pagatoDa !== undefined) doc.pagatoDa = validatePersonRef("pagatoDa");
  if (!partial || b.ricevutoDa !== undefined) doc.ricevutoDa = validatePersonRef("ricevutoDa");
  if (!partial || b.intestataA !== undefined) doc.intestataA = validatePersonRef("intestataA");

  if (b.splits !== undefined) doc.splits = validateSplits(b.splits, participantIds);
  if (b.extraPersone !== undefined) doc.extraPersone = extraPersone.length > 0 ? extraPersone : null;

  function validateAccountRef(key) {
    const v = get(key);
    if (v == null || v === "") return null;
    if (!isPlainId(v) || !accountIds.has(v)) {
      throw new ValidationError("UNKNOWN_ACCOUNT", `Conto non valido: ${key}`, { [key]: v });
    }
    return v;
  }
  if (!partial || b.contoId !== undefined) doc.contoId = validateAccountRef("contoId");
  if (!partial || b.contoDa !== undefined) doc.contoDa = validateAccountRef("contoDa");
  if (!partial || b.contoA !== undefined) doc.contoA = validateAccountRef("contoA");

  const finalTipo = doc.tipo !== undefined ? doc.tipo : existing?.tipo;
  const finalContoDa = doc.contoDa !== undefined ? doc.contoDa : existing?.contoDa;
  const finalContoA = doc.contoA !== undefined ? doc.contoA : existing?.contoA;
  if (finalTipo === "trasferimento") {
    if (!finalContoDa || !finalContoA) {
      throw new ValidationError("TRANSFER_ACCOUNTS_REQUIRED", "Trasferimento: contoDa e contoA obbligatori", {});
    }
    if (finalContoDa === finalContoA) {
      throw new ValidationError("TRANSFER_SAME_ACCOUNT", "Trasferimento: i due conti devono essere diversi", {});
    }
  }

  if (!partial || b.categoria !== undefined) doc.categoria = sanitizeText(get("categoria"), 50) || "altro";
  if (!partial || b.descrizione !== undefined) doc.descrizione = sanitizeText(get("descrizione"), 500);
  if (b.splitPagante !== undefined) doc.splitPagante = b.splitPagante != null ? parseInt(b.splitPagante) : null;
  if (b.ricorrenza !== undefined) doc.ricorrenza = validateRicorrenza(b.ricorrenza);
  if (b.daVerificare !== undefined) doc.daVerificare = !!b.daVerificare;

  return doc;
}

// ─── Trip expenses (MOD-002, MOD-009) ───
// Shared by both the household-authenticated and guest-share-link expense
// endpoints, so a trip expense is validated exactly the same way regardless
// of which one submitted it: payer and every split participant must
// actually be in trip.partecipanti — not the household's participant list,
// since trip guests joined via a share link are deliberately NOT household
// members — and, if splits are given, quotas must sum to 100 within
// tolerance rather than being silently dropped.
export function buildTripExpense(body, trip) {
  const b = body || {};
  const partecipantiIds = new Set((trip.partecipanti || []).map(p => p.id));
  if (!isKnownParticipant(b.pagatoDa, partecipantiIds)) {
    throw new ValidationError("UNKNOWN_TRIP_PARTICIPANT", "Partecipante non valido per questo viaggio", { pagatoDa: b.pagatoDa });
  }
  const importo = validateAmount(b.importo);
  let data;
  try { data = validateDateStr(b.data); } catch { data = new Date().toISOString().slice(0, 10); }
  const splits = b.splits != null ? validateSplits(b.splits, partecipantiIds) : null;
  return {
    id: randomUUID(),
    pagatoDa: b.pagatoDa,
    importo,
    descrizione: sanitizeText(b.descrizione, 200),
    categoria: sanitizeText(b.categoria, 50) || "altro",
    data,
    splits,
  };
}

// ─── Transaction list pagination (MOD-006) ───
// Cursor encodes exactly where a (data desc, _id desc) page stopped — date
// plus id, not just an offset — so pages stay stable and gap-free even
// with many transactions sharing a date, and even if rows are inserted or
// deleted between page requests. Opaque to the client; it just echoes back
// whatever it was given. A 24-hex-char check stands in for ObjectId.isValid
// here rather than importing the mongodb driver into this dependency-free
// module — same validation, no extra dependency.
const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;

export function encodeTransactionsCursor(data, id) {
  return Buffer.from(JSON.stringify({ d: data, i: id })).toString("base64url");
}

export function decodeTransactionsCursor(cursor) {
  try {
    const { d, i } = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof d !== "string" || typeof i !== "string" || !OBJECT_ID_RE.test(i)) return null;
    return { data: d, id: i };
  } catch { return null; }
}

// ─── Idempotency claim decision (MOD-004, hardened) ───
// Pure decision core for claimIdempotencyKey in index.js: given whatever
// existing idempotency record was found after losing the initial atomic
// insert race (or null, if none), decide what the losing request should
// do. Kept separate from the actual database reads/writes so this
// "who wins" logic — the part most worth getting exactly right — can be
// unit-tested without a database.
//   - no existing record -> safe to claim (raced past it entirely)
//   - a completed record -> replay its stored response
//   - a pending record younger than staleMs -> genuinely in flight, wait
//   - a pending record older than staleMs -> presumed crashed, steal it
export function decideIdempotencyClaim(existing, nowMs, staleMs) {
  if (!existing) return { action: "claim" };
  if (existing.status !== "pending") return { action: "replay" };
  const ageMs = nowMs - new Date(existing.createdAt).getTime();
  if (ageMs < staleMs) return { action: "wait" };
  return { action: "steal", createdAt: existing.createdAt };
}

// ─── Trip auto-settlement resumability (MOD-008, hardened) ───
// Pure specification of chiudiViaggiScaduti's eligibility/key logic in
// index.js — kept here so the intent is unit-testable even though the
// actual enforcement happens as MongoDB query filters (the real guarantee
// against a crash losing or duplicating a settlement) rather than this
// function being called directly at runtime. This is NOT a substitute for
// integration-testing the real concurrent-claim behavior against a live
// MongoDB instance — that requires an actual database and isn't covered
// here; treat these tests as an executable spec of the intended rule, not
// proof the database enforces it.
//
// A trip is eligible to be claimed (or re-claimed, if a previous attempt
// appears to have crashed) when either:
//   - it's newly due: no settlement in progress, not yet settled, past its
//     end date
//   - it's stuck: a previous attempt marked it "settling" but never
//     finished, and enough time has passed that attempt is presumed dead
export function isTripSettlementCandidate(trip, { today, nowMs, staleMs }) {
  const status = trip.settlementStatus;
  if ((status == null || status === "open") && trip.settled === false && trip.endDate && trip.endDate < today) {
    return true;
  }
  if (status === "settling" && trip.settlingStartedAt) {
    const ageMs = nowMs - new Date(trip.settlingStartedAt).getTime();
    return ageMs >= staleMs;
  }
  return false;
}

// Deterministic per-settlement-leg key (tripId:index). The settlements
// array is a pure function of the trip's own data, and the trip is locked
// in "settling" for the entire duration of generating it, so recomputing
// it on a resume-after-crash always reproduces the exact same array in the
// exact same order — leg i always gets the same key, which is what makes
// re-inserting an already-inserted leg a harmless no-op (via a unique
// index on this field) rather than a duplicate.
export function settlementTransactionKey(tripId, index) {
  return `${tripId}:${index}`;
}
