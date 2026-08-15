// ─── Centralized transaction validation (MOD-001, MOD-002) ───
// Single source of truth for validating transaction input, used by
// POST /api/transactions, PUT /api/transactions/:id, and (via the shared
// helpers below) POST /api/widget/transaction. Every entry point that can
// create or modify a transaction runs the same rules, so a client can't get
// looser validation just by hitting a different endpoint.
//
// Pure functions only — no MongoDB/Express imports — so this module can be
// unit-tested in isolation (see validation.test.js).

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

// Amounts are normalized to cents on the way in so floating-point noise
// (0.1 + 0.2 style artifacts) never propagates into stored balances.
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
    if (!isPlainId(v) || !participantIds.has(v)) {
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
