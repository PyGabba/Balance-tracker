import express from "express";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import { ValidationError, DEFAULT_HOUSEHOLD_ROLE, validateRuolo, validatePersonaPassword, validatePersonaEmailOptional } from "../validation.js";
import { logger } from "../logger.js";
import {
  sendError, requireHousehold, requireRole, clientIp, pinLookupKey, hashPin,
  checkLock, recordFail, clearLock, isBlacklisted, audit,
  signToken, storeToken, revokeToken, revokeAllTokens, revokeTokensForPersona,
  sendLockoutAlert, sendPinResetCode, COOKIE_OPTS, IS_PROD, ROLE_RANK,
  writeLimiter, withTransaction, sanitizePersone, personaIdFromNome,
  DEFAULT_EMOJIS, PERSONA_COLORS, db, householdsCol, transactionsCol, tripsCol, quotesCol,
} from "../shared.js";

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30, // secondary ceiling — IP rotation can bypass MongoDB lockout but not this
  standardHeaders: true, legacyHeaders: false,
  message: { error: { code: "RATE_LIMITED", message: "Troppi tentativi di accesso, riprova tra 15 minuti" } },
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true, legacyHeaders: false,
  message: { error: { code: "RATE_LIMITED", message: "Troppi account creati, riprova tra un'ora" } },
});

// MOD-025 Stage 1: outer bound only — a single source hammering the
// endpoint at all, generous like loginLimiter. The real defense is the
// persistent, escalating login_locks lockout inside the handler itself
// (same checkLock/recordFail/clearLock the household PIN uses), keyed
// per-persona so it survives a restart and can't be reset by rotating IPs.
const personaLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true, legacyHeaders: false,
  message: { error: { code: "RATE_LIMITED", message: "Troppi tentativi di accesso, riprova tra 15 minuti" } },
});

async function findHouseholdByPin(pin) {
  const lookup = pinLookupKey(pin);
  let dbH = await householdsCol.findOne({ pinLookup: lookup });

  if (!dbH) {
    // Legacy: plain-text pin — migrate on first successful login
    dbH = await householdsCol.findOne({ pin });
    if (dbH) {
      const pinHash = await hashPin(pin);
      await householdsCol.updateOne(
        { _id: dbH._id },
        { $set: { pinHash, pinLookup: lookup }, $unset: { pin: "" } }
      );
    }
  } else if (!await bcrypt.compare(pin, dbH.pinHash)) {
    return null;
  }

  if (!dbH) return null;
  return { householdId: dbH.householdId, nome: dbH.nome, persone: dbH.persone, categorieUscita: dbH.categorieUscita || null, requiresPinChange: dbH.requiresPinChange || false };
}

router.post("/api/auth/login", loginLimiter, async (req, res) => {
  try {
    const ip = clientIp(req);
    const deviceId = req.body?.deviceId || null;
    const ipKey = `ip:${ip}`;
    // PIN-hash lock: attacker rotating IPs/devices still hits this — same PIN tried 10x = lockout
    const pinKey = req.body?.pin ? `pin:${pinLookupKey(req.body.pin)}` : null;
    const devKey = deviceId ? `device:${deviceId}` : null;

    // Check blacklist first — permanent block
    const [ipBanned, devBanned] = await Promise.all([
      isBlacklisted(ipKey),
      devKey ? isBlacklisted(devKey) : false,
    ]);
    if (ipBanned || devBanned) {
      audit("login_blocked", { ip, deviceId, success: false, detail: "blacklisted" });
      return sendError(res, 403, "ACCESS_BLOCKED", "Accesso permanentemente bloccato");
    }

    // Check all three locks — IP, device, and PIN-hash
    const [ipLock, devLock, pinLock] = await Promise.all([
      checkLock(ipKey),
      devKey ? checkLock(devKey) : null,
      pinKey ? checkLock(pinKey) : null,
    ]);
    const activeLock = (ipLock?.lockedUntil && ipLock) || (devLock?.lockedUntil && devLock) || (pinLock?.lockedUntil && pinLock);
    if (activeLock) {
      const mins = Math.ceil((activeLock.lockedUntil - new Date()) / 60000);
      audit("login_blocked", { ip, deviceId, success: false, detail: `locked ${mins}m` });
      return sendError(res, 429, "RATE_LIMITED", `Accesso bloccato. Riprova tra ${mins} minuti.`, { retryAfterMinutes: mins });
    }

    const household = await findHouseholdByPin(req.body?.pin);
    if (!household) {
      const [ipNowLocked, devNowLocked, pinNowLocked] = await Promise.all([
        recordFail(ipKey),
        devKey ? recordFail(devKey) : false,
        pinKey ? recordFail(pinKey) : false,
      ]);
      if (ipNowLocked || devNowLocked || pinNowLocked) sendLockoutAlert(ip, deviceId).catch(console.error);
      audit("login_fail", { ip, deviceId, success: false });
      return sendError(res, 401, "INVALID_PIN", "PIN non valido");
    }

    await Promise.all([clearLock(ipKey), devKey ? clearLock(devKey) : null, pinKey ? clearLock(pinKey) : null]);
    const { token, jti } = signToken(household.householdId);
    await storeToken(jti, household.householdId);
    audit("login_success", { householdId: household.householdId, ip, deviceId });
    res.cookie("token", token, COOKIE_OPTS);
    res.json({ ...household, persone: sanitizePersone(household.persone) });
  } catch (e) { logger.error("login_failed", { requestId: req.requestId, error: e.message }); sendError(res, 500, "INTERNAL_ERROR", "Errore login"); }
});

router.post("/api/auth/logout", requireHousehold, async (req, res) => {
  try {
    await revokeToken(req.jti);
    audit("logout", { householdId: req.householdId, ip: clientIp(req) });
    res.clearCookie("token", { path: "/", httpOnly: true, secure: IS_PROD, sameSite: "strict" });
    res.json({ ok: true });
  } catch (e) { sendError(res, 500, "INTERNAL_ERROR", "Errore logout"); }
});

router.post("/api/auth/register", registerLimiter, async (req, res) => {
  try {
    const { nome, persone, pin, email } = req.body || {};
    if (!nome || !pin || !Array.isArray(persone) || persone.length === 0)
      return sendError(res, 400, "MISSING_FIELDS", "Campi obbligatori: nome, persone, pin");
    if (!/^\d{6,8}$/.test(pin))
      return sendError(res, 400, "INVALID_PIN_FORMAT", "Il PIN deve essere di 6-8 cifre");
    let emailNorm = null;
    if (email) {
      emailNorm = String(email).trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm) || emailNorm.length > 200)
        return sendError(res, 400, "INVALID_EMAIL", "Email non valida");
    }

    // Build householdId: slug from nome + random suffix
    const slug = nome.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const suffix = Math.random().toString(36).slice(2, 7);
    const householdId = `${slug}-${suffix}`;

    // MOD-025 foundation: the first persona (whoever filled in the
    // registration form) defaults to "owner", everyone else to "member" —
    // a reasonable default, not a security decision (see validateRuolo's
    // comment: roles aren't enforced by authentication yet). A caller can
    // override per-persona via an object's `ruolo` field.
    let personeFormatted;
    try {
      const usedIds = new Set();
      personeFormatted = persone.map((p, i) => {
        const explicitRuolo = typeof p === "object" ? p.ruolo : null;
        const ruolo = explicitRuolo != null ? validateRuolo(explicitRuolo) : (i === 0 ? "owner" : DEFAULT_HOUSEHOLD_ROLE);
        const id = personaIdFromNome(typeof p === "string" ? p : p.nome, usedIds);
        usedIds.add(id);
        return {
          id,
          nome: typeof p === "string" ? p : p.nome,
          emoji: (typeof p === "object" && p.emoji) ? p.emoji : DEFAULT_EMOJIS[i % DEFAULT_EMOJIS.length],
          colore: PERSONA_COLORS[i % PERSONA_COLORS.length],
          ruolo,
        };
      });
    } catch (ve) {
      if (ve instanceof ValidationError) return sendError(res, 400, ve.code, ve.message, ve.fields);
      throw ve;
    }

    const pinHash = await hashPin(pin);
    const doc = { householdId, nome, persone: personeFormatted, pinHash, pinLookup: pinLookupKey(pin), createdAt: new Date() };
    // Sparse unique index on email requires the field to be ABSENT (not null)
    // for docs without an email — a stored `null` still gets indexed, so a
    // second no-email registration would collide on the first one.
    if (emailNorm) doc.email = emailNorm;
    await householdsCol.insertOne(doc);
    const { token, jti } = signToken(householdId);
    await storeToken(jti, householdId);
    audit("register", { householdId, ip: clientIp(req) });
    res.cookie("token", token, COOKIE_OPTS);
    res.status(201).json({ householdId, nome, persone: sanitizePersone(personeFormatted) });
  } catch (e) {
    if (e.code === 11000 && e.message?.includes("pinLookup")) return sendError(res, 409, "PIN_ALREADY_IN_USE", "PIN già in uso, scegline un altro");
    if (e.code === 11000 && e.message?.includes("email")) return sendError(res, 409, "EMAIL_ALREADY_IN_USE", "Email già collegata a un altro gruppo");
    logger.error("register_failed", { requestId: req.requestId, error: e.message }); // never log e directly — req.body may appear in stack
    sendError(res, 500, "INTERNAL_ERROR", "Errore durante la registrazione");
  }
});

// ─── DELETE household ───
// ─── Change PIN ───
router.put("/api/auth/pin", requireHousehold, requireRole("admin"), async (req, res) => {
  try {
    const { newPin } = req.body || {};
    if (!newPin || !/^\d{6,8}$/.test(newPin))
      return sendError(res, 400, "INVALID_PIN_FORMAT", "Il nuovo PIN deve essere di 6-8 cifre");
    const pinHash = await hashPin(newPin);
    const pinLookup = pinLookupKey(newPin);
    await householdsCol.updateOne(
      { householdId: req.householdId },
      { $set: { pinHash, pinLookup, requiresPinChange: false, updatedAt: new Date() }, $unset: { pin: "" } }
    );
    await revokeAllTokens(req.householdId);
    const { token, jti } = signToken(req.householdId);
    await storeToken(jti, req.householdId);
    audit("pin_change", { householdId: req.householdId, ip: clientIp(req) });
    res.cookie("token", token, COOKIE_OPTS);
    res.json({ ok: true });
  } catch (e) { logger.error("pin_change_failed", { requestId: req.requestId, householdId: req.householdId, error: e.message }); sendError(res, 500, "INTERNAL_ERROR", "Errore aggiornamento PIN"); }
});

// ─── Recupero PIN dimenticato ───
const forgotPinLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false, message: { error: { code: "RATE_LIMITED", message: "Troppi tentativi, riprova tra qualche minuto" } } });

router.post("/api/auth/forgot-pin/request", forgotPinLimiter, async (req, res) => {
  // Risposta generica sempre uguale, email esista o meno: non si conferma
  // né si smentisce l'esistenza di un account legato a quell'indirizzo.
  const GENERIC_OK = { ok: true, message: "Se l'email è collegata a un account, riceverai un codice a breve." };
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendError(res, 400, "INVALID_EMAIL", "Email non valida");

    const household = await householdsCol.findOne({ email });
    if (!household) return res.json(GENERIC_OK); // non riveliamo se l'email esiste

    const code = String(Math.floor(100000 + Math.random() * 900000)); // 6 cifre
    const codeHash = await bcrypt.hash(code, 10);
    await db.collection("pinResets").deleteMany({ householdId: household.householdId }); // invalida richieste precedenti
    await db.collection("pinResets").insertOne({
      householdId: household.householdId, codeHash, attempts: 0,
      createdAt: new Date(), expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    });
    // Invio in background, senza "await": anche una chiamata HTTPS può
    // essere lenta, e non deve mai tenere in sospeso la risposta al client
    // — altrimenti resta bloccato su "Invio..." indefinitamente.
    sendPinResetCode(email, code, household.nome).catch(mailErr => {
      logger.error("pin_reset_email_send_failed", { requestId: req.requestId, code: mailErr.code || null, error: mailErr.message, response: mailErr.response || undefined });
      // Non sveliamo all'esterno se l'invio è fallito per non far trapelare l'esistenza dell'account
    });
    audit("pin_reset_requested", { householdId: household.householdId, ip: clientIp(req) });
    res.json(GENERIC_OK);
  } catch (e) { logger.error("forgot_pin_request_failed", { requestId: req.requestId, error: e.message }); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

router.post("/api/auth/forgot-pin/confirm", forgotPinLimiter, async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const code = String(req.body?.code || "").trim();
    const newPin = req.body?.newPin;
    if (!email || !code || !newPin) return sendError(res, 400, "MISSING_FIELDS", "Campi obbligatori: email, codice, nuovo PIN");
    if (!/^\d{6,8}$/.test(newPin)) return sendError(res, 400, "INVALID_PIN_FORMAT", "Il nuovo PIN deve essere di 6-8 cifre");

    const household = await householdsCol.findOne({ email });
    if (!household) return sendError(res, 400, "INVALID_RESET_CODE", "Codice non valido o scaduto");

    // Reserve an attempt atomically BEFORE the (slow, ~10 rounds bcrypt)
    // comparison — reading attempts, checking it, and incrementing it as
    // three separate steps let N concurrent requests all read the same
    // pre-increment value and all pass the check, so the 5-attempt cap
    // could be blown past under concurrency (not IP-bound: a distributed
    // attacker isn't limited by forgotPinLimiter either). Folding the
    // check into the $inc's filter makes MongoDB itself the single point
    // of truth — only requests that land on a still-available slot get
    // reset back, and every one of them sees a distinct attempts value.
    const reset = await db.collection("pinResets").findOneAndUpdate(
      { householdId: household.householdId, expiresAt: { $gt: new Date() }, attempts: { $lt: 5 } },
      { $inc: { attempts: 1 } },
      { returnDocument: "before" }
    );
    if (!reset) {
      // Either no active/unexpired code, or attempts are already exhausted
      // — a second read here (outside the hot path, no race-sensitive
      // decision depends on it) just distinguishes which error to show.
      // Deliberately NOT deleted here: a fresh /forgot-pin/request already
      // clears any prior doc for this household before inserting a new
      // one, and the expiresAt TTL index reaps it either way — eager
      // deletion here would just make every capped-out request AFTER the
      // first one fall through to "no doc found" and report the wrong,
      // more permissive-sounding error (INVALID_RESET_CODE instead of
      // TOO_MANY_ATTEMPTS).
      const existing = await db.collection("pinResets").findOne({ householdId: household.householdId });
      if (existing && existing.attempts >= 5) {
        return sendError(res, 429, "TOO_MANY_ATTEMPTS", "Troppi tentativi. Richiedi un nuovo codice.");
      }
      return sendError(res, 400, "INVALID_RESET_CODE", "Codice non valido o scaduto");
    }

    const valid = await bcrypt.compare(code, reset.codeHash);
    if (!valid) {
      return sendError(res, 400, "INVALID_RESET_CODE", "Codice non corretto");
    }

    const pinHash = await hashPin(newPin);
    const pinLookup = pinLookupKey(newPin);
    await householdsCol.updateOne(
      { householdId: household.householdId },
      { $set: { pinHash, pinLookup, requiresPinChange: false, updatedAt: new Date() }, $unset: { pin: "" } }
    );
    await db.collection("pinResets").deleteOne({ _id: reset._id });
    await revokeAllTokens(household.householdId); // disconnette ogni sessione precedente, per sicurezza

    const { token, jti } = signToken(household.householdId);
    await storeToken(jti, household.householdId);
    audit("pin_reset_completed", { householdId: household.householdId, ip: clientIp(req) });
    res.cookie("token", token, COOKIE_OPTS);
    res.json({ id: household.householdId, nome: household.nome, persone: sanitizePersone(household.persone) });
  } catch (e) {
    if (e.code === 11000) return sendError(res, 409, "PIN_ALREADY_IN_USE", "PIN già in uso, scegline un altro");
    logger.error("forgot_pin_confirm_failed", { requestId: req.requestId, error: e.message });
    sendError(res, 500, "INTERNAL_ERROR", "Errore");
  }
});

// Aggiungere/aggiornare l'email di recupero da account già autenticato
// (fondamentale per le case create prima che questa funzione esistesse).
router.put("/api/auth/recovery-email", writeLimiter, requireHousehold, async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200)
      return sendError(res, 400, "INVALID_EMAIL", "Email non valida");
    await householdsCol.updateOne({ householdId: req.householdId }, { $set: { email, updatedAt: new Date() } });
    audit("recovery_email_set", { householdId: req.householdId, ip: clientIp(req) });
    res.json({ ok: true });
  } catch (e) {
    if (e.code === 11000) return sendError(res, 409, "EMAIL_ALREADY_IN_USE", "Email già collegata a un altro gruppo");
    console.error("Set recovery email error:", e.message); sendError(res, 500, "INTERNAL_ERROR", "Errore");
  }
});

router.delete("/api/auth/household", requireHousehold, requireRole("owner"), async (req, res) => {
  try {
    const { pin } = req.body || {};
    if (!pin) return sendError(res, 400, "MISSING_PIN", "PIN obbligatorio per confermare");

    // Verify PIN matches
    const household = await householdsCol.findOne({ householdId: req.householdId });
    if (!household) return sendError(res, 404, "NOT_FOUND", "Account non trovato");
    const pinValid = household.pinHash
      ? await bcrypt.compare(pin, household.pinHash)
      : household.pin === pin;
    if (!pinValid) return sendError(res, 401, "INVALID_PIN", "PIN non corretto");

    // Delete all data for this household — one transaction, so a crash or
    // network drop partway through can never leave e.g. the household gone
    // but its transactions still present (or vice versa).
    const hid = req.householdId;
    await withTransaction(async (session) => {
      await transactionsCol.deleteMany({ householdId: hid }, { session });
      await db.collection("positions").deleteMany({ householdId: hid }, { session });
      await db.collection("portfolio_snapshots").deleteMany({ householdId: hid }, { session });
      await db.collection("goals").deleteMany({ householdId: hid }, { session });
      await db.collection("accounts").deleteMany({ householdId: hid }, { session });
      await tripsCol.deleteMany({ householdId: hid }, { session });
      await quotesCol.deleteMany({ householdId: hid }, { session });
      await db.collection("pinResets").deleteMany({ householdId: hid }, { session });
      await revokeAllTokens(hid, session);
      await householdsCol.deleteOne({ householdId: hid }, { session });
    });
    audit("household_delete", { householdId: req.householdId, ip: clientIp(req) });
    res.clearCookie("token", { path: "/", httpOnly: true, secure: IS_PROD, sameSite: "strict" });
    res.json({ ok: true });
  } catch (e) { console.error("Delete household error:", e.message); sendError(res, 500, "INTERNAL_ERROR", "Errore durante l'eliminazione"); }
});

// ─── Persona credentials (MOD-025 Stage 2) ───
// Enroll/change a persona's own password. Requires the household PIN
// (already enforced by requireHousehold) PLUS — if this persona already
// has a credential — that credential too, so knowing only the shared PIN
// is never enough to silently take over an already-enrolled identity.
// That currentPassword requirement (further down in POST) already fully
// covers POST for any already-claimed target, regardless of who's
// asking — only enrolling a still-UNCLAIMED persona stays open to any
// PIN holder, the intentional Stage 1 bootstrap case.
//
// DELETE had no equivalent protection at all, which mattered more than
// it looks: deleting a persona's credential and then re-enrolling it
// through the open bootstrap path let ANY household-PIN holder bypass
// POST's currentPassword check entirely. personaCredentialAuthorized
// (used by DELETE, below) closes that:
//
//  1. personaCredentialRoleAuthorized — allowed by WHO you are:
//       - a persona can always manage their own credential (self-service);
//       - an unclaimed persona (nothing to delete) is a no-op either way;
//       - beyond that, touching an ALREADY-enrolled OTHER persona's
//         credential requires an attributed admin+ identity, and an
//         owner/admin target specifically requires the requester
//         themselves be an owner — an admin can't use this endpoint to
//         take over another admin or the household's owner.
//  2. personaCredentialAuthorized — also accepts proof by WHAT you know:
//       a correct currentPassword for the target (new optional field on
//       DELETE) is treated as equivalent to being that persona, even on
//       a plain PIN-only session — mirroring the proof POST has always
//       required for a password change.
//
// Note: this intentionally does NOT let an admin/owner remove someone
// else's credential and take it over without proving they know the old
// password, beyond what their admin role already grants on its own —
// a true "admin reset" is a reasonable follow-up but a separate, larger
// behavior change, left out of this fix to keep it minimal and reviewable.
function personaCredentialRoleAuthorized(req, target) {
  if (req.personaId && req.personaId === target.id) return true; // self-service
  if (!target.auth) return true; // unclaimed identity: bootstrap, any session

  if (!req.personaId) return false; // PIN-only session touching an already-claimed identity: no

  const requester = (req.household.persone || []).find(p => p.id === req.personaId);
  const requesterRole = requester?.ruolo || DEFAULT_HOUSEHOLD_ROLE;
  const targetRole = target.ruolo || DEFAULT_HOUSEHOLD_ROLE;

  if ((ROLE_RANK[requesterRole] ?? 0) < ROLE_RANK.admin) return false; // must be admin or owner
  if ((targetRole === "owner" || targetRole === "admin") && requesterRole !== "owner") return false; // only an owner touches privileged accounts
  return true;
}

async function personaCredentialAuthorized(req, target, currentPassword) {
  if (personaCredentialRoleAuthorized(req, target)) return true;
  // Not authorized by identity/role alone — the remaining path is proving
  // you ARE this persona by supplying their current password.
  return !!(target.auth?.method === "password" && currentPassword &&
    await bcrypt.compare(currentPassword, target.auth.passwordHash));
}

router.post("/api/auth/persona-credential", writeLimiter, requireHousehold, async (req, res) => {
  try {
    const { personaId, newPassword, currentPassword, email } = req.body || {};
    if (!personaId || typeof personaId !== "string") return sendError(res, 400, "MISSING_FIELDS", "personaId obbligatorio");
    const persone = req.household.persone || [];
    const target = persone.find(p => p.id === personaId);
    if (!target) return sendError(res, 404, "NOT_FOUND", "Persona non trovata");
    // No separate role gate here on purpose: the currentPassword check
    // below already requires proof of identity for any ALREADY-claimed
    // target regardless of who's asking, so it fully covers this route.
    // Enrolling an UNCLAIMED persona stays open to any PIN holder — the
    // intentional Stage 1 bootstrap case. The actual missing protection
    // was on DELETE (below), since deleting-then-recreating a credential
    // let anyone bypass the currentPassword check entirely.

    let validatedPassword, validatedEmail;
    try {
      validatedPassword = validatePersonaPassword(newPassword);
      // Optional — lets this persona use the standalone email+password
      // login (no PIN first) in addition to the existing PIN-then-password
      // flow. `email` omitted from the request entirely keeps whatever was
      // already set (e.g. a plain password change); an explicit empty
      // string clears it (validatePersonaEmailOptional treats "" as null).
      validatedEmail = email !== undefined ? validatePersonaEmailOptional(email) : (target.auth?.email || null);
    }
    catch (ve) { if (ve instanceof ValidationError) return sendError(res, 400, ve.code, ve.message, ve.fields); throw ve; }

    if (target.auth?.method === "password") {
      if (!currentPassword || !(await bcrypt.compare(currentPassword, target.auth.passwordHash))) {
        return sendError(res, 401, "INVALID_CURRENT_PASSWORD", "Password attuale non corretta");
      }
    }

    const passwordHash = await bcrypt.hash(validatedPassword, 10);
    const auth = { method: "password", passwordHash, enrolledAt: new Date() };
    if (validatedEmail) auth.email = validatedEmail; // omitted (not null) to match the sparse unique index's expectations
    const updatedPersone = persone.map(p => p.id === personaId ? { ...p, auth } : p);
    try {
      await householdsCol.updateOne({ householdId: req.householdId }, { $set: { persone: updatedPersone, updatedAt: new Date() } });
    } catch (e) {
      if (e.code === 11000) return sendError(res, 409, "EMAIL_ALREADY_IN_USE", "Email già collegata a un altro account");
      throw e;
    }
    // A password CHANGE (not first-time enroll) must kill every session
    // issued under the old password — otherwise a compromised session
    // survives its own remediation.
    if (target.auth?.method === "password") await revokeTokensForPersona(req.householdId, personaId);
    audit("persona_credential_enrolled", { householdId: req.householdId, ip: clientIp(req), detail: { personaId } }); // never the password/hash
    res.json({ persone: sanitizePersone(updatedPersone) });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

router.delete("/api/auth/persona-credential/:id", writeLimiter, requireHousehold, async (req, res) => {
  try {
    const persone = req.household.persone || [];
    const target = persone.find(p => p.id === req.params.id);
    if (!target) return sendError(res, 404, "NOT_FOUND", "Persona non trovata");
    if (!(await personaCredentialAuthorized(req, target, req.body?.currentPassword))) {
      return sendError(res, 403, "INSUFFICIENT_ROLE", "Non puoi rimuovere la credenziale di questa persona");
    }
    const updatedPersone = persone.map(p => p.id === req.params.id ? { ...p, auth: null } : p);
    await householdsCol.updateOne({ householdId: req.householdId }, { $set: { persone: updatedPersone, updatedAt: new Date() } });
    await clearLock(`persona:${req.householdId}:${req.params.id}`); // an un-enrolled persona shouldn't stay locked from a credential that no longer exists
    await revokeTokensForPersona(req.householdId, req.params.id); // kill every session issued under the now-removed credential
    audit("persona_credential_removed", { householdId: req.householdId, ip: clientIp(req), detail: { personaId: req.params.id } });
    res.json({ persone: sanitizePersone(updatedPersone) });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

// Step 2 of the layered login flow (see MOD-025-DESIGN.md) — requires an
// existing household session (the PIN, step 1), issues a NEW session that
// additionally names which persona this is. Rate limiting mirrors the
// household PIN's own two-layer pattern: personaLoginLimiter as a blunt
// IP-keyed outer bound, plus the same persistent login_locks lockout the
// PIN uses, keyed per-persona so an attacker rotating IPs/devices still
// hits it and a lockout on one persona never affects any other persona or
// the household PIN itself.
router.post("/api/auth/persona-login", personaLoginLimiter, requireHousehold, async (req, res) => {
  try {
    const { personaId, password } = req.body || {};
    if (!personaId || typeof personaId !== "string") return sendError(res, 400, "MISSING_FIELDS", "personaId obbligatorio");
    const lockKey = `persona:${req.householdId}:${personaId}`;
    const lock = await checkLock(lockKey);
    if (lock?.lockedUntil) {
      const mins = Math.ceil((lock.lockedUntil - new Date()) / 60000);
      audit("persona_login_blocked", { householdId: req.householdId, ip: clientIp(req), success: false, detail: { personaId, lockedMinutes: mins } });
      return sendError(res, 429, "RATE_LIMITED", `Accesso bloccato. Riprova tra ${mins} minuti.`, { retryAfterMinutes: mins });
    }

    const target = (req.household.persone || []).find(p => p.id === personaId);
    if (!target || target.auth?.method !== "password") {
      return sendError(res, 400, "NO_PERSONA_CREDENTIAL", "Questa persona non ha una credenziale configurata");
    }

    const valid = typeof password === "string" && await bcrypt.compare(password, target.auth.passwordHash);
    if (!valid) {
      const nowLocked = await recordFail(lockKey);
      audit("persona_login_fail", { householdId: req.householdId, ip: clientIp(req), success: false, detail: { personaId, locked: nowLocked } });
      return sendError(res, 401, "INVALID_PERSONA_PASSWORD", "Password non corretta");
    }

    await clearLock(lockKey);
    const { token, jti } = signToken(req.householdId, personaId);
    await storeToken(jti, req.householdId, personaId);
    await revokeToken(req.jti); // the household-only session this replaces
    audit("persona_login_success", { householdId: req.householdId, ip: clientIp(req), detail: { personaId } });
    res.cookie("token", token, COOKIE_OPTS);
    res.json({ personaId });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

// ─── Standalone email+password login — no household PIN first ───
// Unlike persona-login above (step 2 ON TOP OF an existing PIN session,
// MOD-025 Stage 1), this is a single-step alternative entry point: the
// login page lets a user pick "PIN" or "password", and this is what the
// password tab calls. It only works for a persona that opted in by
// setting a credential email (see POST /api/auth/persona-credential) —
// the email is the only thing that identifies which household/persona a
// bare password belongs to, since there's no PIN-established household
// context to search within.
//
// Same generic-failure-message discipline as the household PIN login:
// unknown email and wrong password return the identical error/status, so
// this can't be used to enumerate which emails have an account.
const personaPasswordLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true, legacyHeaders: false,
  message: { error: { code: "RATE_LIMITED", message: "Troppi tentativi di accesso, riprova tra 15 minuti" } },
});
router.post("/api/auth/persona-login-password", personaPasswordLoginLimiter, async (req, res) => {
  try {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const { password } = req.body || {};
    if (!email || !password) return sendError(res, 400, "MISSING_FIELDS", "Email e password obbligatorie");

    // Locked per-email (not per-persona/household, which aren't known yet)
    // — still persistent/escalating like every other lockout in this app,
    // and still survives an attacker rotating IPs.
    const lockKey = `persona-pw:${email}`;
    const lock = await checkLock(lockKey);
    if (lock?.lockedUntil) {
      const mins = Math.ceil((lock.lockedUntil - new Date()) / 60000);
      audit("persona_password_login_blocked", { ip: clientIp(req), success: false, detail: { lockedMinutes: mins } });
      return sendError(res, 429, "RATE_LIMITED", `Accesso bloccato. Riprova tra ${mins} minuti.`, { retryAfterMinutes: mins });
    }

    const household = await householdsCol.findOne({ "persone.auth.email": email });
    const target = household?.persone?.find(p => p.auth?.email === email);
    const valid = !!target && typeof password === "string" && await bcrypt.compare(password, target.auth.passwordHash);
    if (!valid) {
      const nowLocked = await recordFail(lockKey);
      audit("persona_password_login_fail", { ip: clientIp(req), success: false, detail: { locked: nowLocked } });
      return sendError(res, 401, "INVALID_CREDENTIALS", "Email o password non corretti");
    }

    await clearLock(lockKey);
    const { token, jti } = signToken(household.householdId, target.id);
    await storeToken(jti, household.householdId, target.id);
    audit("persona_password_login_success", { householdId: household.householdId, ip: clientIp(req), detail: { personaId: target.id } });
    res.cookie("token", token, COOKIE_OPTS);
    res.json({
      householdId: household.householdId,
      nome: household.nome,
      persone: sanitizePersone(household.persone),
      requiresPinChange: household.requiresPinChange || false,
      personaId: target.id,
    });
  } catch (e) { console.error(e); sendError(res, 500, "INTERNAL_ERROR", "Errore"); }
});

export default router;
