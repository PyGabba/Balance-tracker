# MOD-025 full redesign — design doc

Status: **Stage 1 is implemented** — schema (`persone[].auth`), the
three endpoints (`persona-credential` enroll/remove, `persona-login`),
rate limiting/lockout, and response sanitization described below. See
"Persona credentials (MOD-025 Stage 1)" in `API.md` for the actual
shipped behavior — that's the authoritative reference now, this
document is the plan it was built from. **Stage 2 (role enforcement)
and everything under "Role enforcement" below is still design only,
not built.**

The foundation half of MOD-025 (`persone[].ruolo`, advisory-only, no
enforcement) shipped earlier — see "Household member roles" in
`API.md`.

**Decisions locked in** (previously open questions, now resolved):
password-first (passkey as a later enrollment option, not blocking);
per-persona opt-in stays optional forever, no future "mandatory for
everyone" mode; a `guest`-role household member CAN get a real
credential, same as any other role — "guest" is a real, lower-privilege
member category, not just a synonym for trip-share-link guests; and the
persona-login rate-limiting shape is specified below rather than
deferred. These are reflected throughout the rest of this document —
see the sections they touch for what changed as a result.

## Goals

- A household member can prove they're specifically *them*, not just
  "someone who knows the shared PIN."
- Roles (owner/admin/member/guest) become an enforceable permission
  boundary, not a label.
- A single member's access can be revoked without rotating the whole
  household's credential.
- Audit events can name who did something, not just which household.

## Non-goals (explicitly out of scope for this design)

- Removing the household as the data-sharing boundary. Every persona in
  a household still sees the same transactions/accounts/goals — this is
  about *who's allowed to act*, not a multi-tenant-within-household data
  model.
- Trip guests (capability-token, no household session) are unaffected —
  they stay exactly as they are, a completely separate mechanism from
  household `persone`. A `guest`-*role* household member (see Decisions)
  is a different thing: a real persona, with a real optional credential,
  who happens to have the lowest-privilege role — not a trip-share-link
  guest.

## Why this is being designed separately from the foundation

The foundation (already shipped) couldn't safely go further than a
label, because the server has no way today to know *which* persona sent
a request — every household shares one PIN and one session. Making a
role check mean anything requires the session itself to carry a persona
identity, which is a breaking change to the JWT payload, the login flow,
and every endpoint that currently only checks `req.householdId`.

## Data model

Extend each `persone[]` entry in the `households` collection (no new
top-level collection — keeps the household as the sharding/scoping
boundary, per the plan's own "keep household as the primary
data-sharing boundary" requirement):

```js
{
  id: "gabriele",
  nome: "Gabriele",
  emoji: "🧑",
  colore: "#6C5CE7",
  ruolo: "owner",              // already exists (MOD-025 foundation)

  // New:
  auth: {
    method: "password" | "passkey" | null,   // null = not enrolled, PIN-only (current behavior)
    passwordHash: "...",                      // bcrypt, only if method === "password"
    passkeyCredentials: [ { id, publicKey, counter, createdAt } ],  // only if method includes passkey
    enrolledAt: Date,
  }
}
```

A persona with `auth.method === null` behaves exactly as every persona
does today — selectable after the household PIN, no extra credential.
This is what makes the rollout non-breaking (see Migration plan).

## Auth flow — layered, not replaced

**Recommendation: keep the household PIN as step 1, add per-persona
credential as an optional step 2.**

```
Household PIN (unchanged)
      ↓
Select persona (unchanged UI)
      ↓
  Does this persona have auth.method set?
      ├─ No  → logged in as that persona (today's behavior, unchanged)
      └─ Yes → prompt for that persona's password/passkey
                     ↓
               logged in as that persona, with a session that
               actually names them
```

Rejected alternative: replacing the household PIN entirely with
per-user login (email/username + password). This is architecturally
cleaner but a much bigger break — it loses the "type a 6-digit PIN in
2 seconds on a shared kitchen tablet" convenience this app is
deliberately built around (see `API.md`'s login section), and it forces
every household to migrate on day one instead of opting in per-persona.

## Session / JWT

Current payload: `{ householdId, jti }`.
New payload: `{ householdId, personaId, jti }` — `personaId` is
**optional**. A token issued for a persona with `auth.method === null`
either omits it (today's behavior) or the login step never collects a
persona-specific credential in the first place.

`requireHousehold` middleware gains a sibling, `requirePersonaAuth`,
used only on endpoints that need to know who specifically is acting
(see Role enforcement below). It 401s with a new code
(`PERSONA_AUTH_REQUIRED`) if the session has no `personaId` — telling
the client "this action needs you to log in as yourself, not just the
household."

## Role enforcement — a concrete matrix, not "add checks everywhere"

Enforcement only applies to requests carrying a `personaId` (see
above) — a request without one keeps today's permissive behavior
exactly, which is what makes this rollout gradual instead of a cliff.

| Action | Minimum role | Today | After |
|---|---|---|---|
| `DELETE /api/auth/household` | owner | any PIN-holder | owner, if the requesting persona has one; unchanged otherwise |
| `PUT /api/household/persone/:id/ruolo` | admin (to change others), self-exempt for viewing | any PIN-holder | admin+, if attributable |
| `PUT /api/auth/pin` (household PIN change) | owner or admin | any PIN-holder | owner/admin, if attributable |
| Create/edit/delete transactions, accounts, goals, trips | member+ (i.e. not guest) | any PIN-holder | member+, if attributable |
| Read-only endpoints (GET *) | any role including guest | unchanged | unchanged |
| Widget/calendar key create/revoke | admin+ | any PIN-holder | admin+, if attributable |

This list is a starting point for review, not final — the point of the
table is that enforcement is scoped and explicit, not "audit every
endpoint and add checks."

## Audit logging

`audit(event, { householdId, ... })` gains an optional `personaId` —
populated whenever `req.personaId` is present, `null` otherwise (i.e.
for households/requests that haven't adopted per-persona auth). No
schema migration needed — additive field, same pattern as every
`*MinorUnits` companion field from MOD-016.

## New/changed endpoints — implemented as described, see API.md

- `POST /api/auth/persona-login` — body `{ personaId, password }` (or a
  WebAuthn assertion for passkey), issues a session with `personaId`
  set. Rate limiting: see "Rate limiting for persona login" below.
- `POST /api/auth/persona-credential` — enroll or change a persona's
  own password/passkey. Requires the household PIN (today's auth) plus,
  if the persona already has a credential enrolled, that credential too
  (can't silently take over someone else's identity by just knowing the
  shared PIN).
- `DELETE /api/auth/persona-credential/:id` — un-enroll, reverting that
  persona to PIN-only. Restricted to the persona themselves or an
  owner/admin.
- `GET /api/household` response gains `persone[].hasCredential: boolean`
  (never exposes hash/credential material, mirrors how capability keys
  are write-only-once).

## Migration plan — staged, each stage independently shippable

1. **Schema + enrollment, zero enforcement.** Add the `auth` field,
   ship enrollment endpoints, ship a UI for a persona to optionally set
   a password. Every household keeps working exactly as today — this
   stage is invisible unless someone opts in.
2. **Enforcement, opt-in per request.** Wire `requirePersonaAuth` with
   role checks onto the matrix above, but ONLY blocking when
   `personaId` is present and the role check fails. Households that
   haven't enrolled anyone see no change at all.

There is no stage 3. Per-persona opt-in is permanent, by decision —
there will not be a household-wide "require persona login for
everyone" mode. `auth.method: null` is a valid, permanent, supported
state for any persona indefinitely, not a transitional one.

No existing household is ever forced through a migration script for
this — unlike MOD-016's data migration, there's nothing to backfill.

## Threat model changes

- **New capability, not just new risk:** a household can now actually
  revoke one member (`DELETE /api/auth/persona-credential/:id` +
  demote their role) without rotating the PIN everyone else uses —
  this is the concrete thing MOD-025 asked for that the foundation
  couldn't provide.
- **New risk: per-persona password strength.** Reuses the existing
  bcrypt infra (same library, same cost factor as the household PIN),
  but a persona password isn't digit-only like the PIN — needs its own
  minimum-length/strength rule, and its own rate-limiter tier (can't
  reuse `loginLimiter` as-is since it's keyed to household-level
  lockout, not per-persona).
- **New risk: passkey implementation surface.** WebAuthn is
  phishing-resistant and strictly better than a password, but adds a
  relying-party-ID/origin-binding configuration surface that has to be
  gotten right for both the Vercel-proxied production origin and local
  dev — worth doing, but real added complexity, which is why the
  recommendation is password-first, passkey as a follow-up enrollment
  option once the flow is proven.

## Rate limiting for persona login

Same two-layer pattern the household PIN login already uses (see
`POST /api/auth/login` in `API.md`) — a fast in-memory IP limiter as a
blunt outer bound, plus a persistent, escalating Mongo-backed lockout as
the real defense, since the in-memory limiter alone resets on every
server restart/deploy:

- **Outer bound — `personaLoginLimiter`** (`express-rate-limit`, same
  family as `loginLimiter`): 15 min window, IP-keyed, generous (~30
  attempts) — catches a single source hammering the endpoint at all,
  same role `loginLimiter` already plays for household login.
- **Real defense — persistent lockout, reusing `login_locks`.** Same
  collection and escalating-lockout-duration mechanism the household
  PIN already uses (`locksCol` / `checkLock` / `recordFailure` in
  `server/index.js`), keyed by `persona:${householdId}:${personaId}`
  instead of the household-level key the PIN uses. This is the
  attacker-rotating-IPs-doesn't-help layer — 10 wrong passwords against
  one specific persona locks that persona out regardless of source IP,
  mirroring exactly how the PIN lockout already works. Locking is
  per-persona, not per-household: a lockout on one persona's login
  doesn't affect any other persona's ability to log in (household PIN
  access is also unaffected either way, since that's a separate
  mechanism this doesn't touch).
- **Not IP+personaId combined as the lock key** — deliberately just
  `householdId:personaId`, matching the household PIN lockout's own
  choice to key on the credential being guessed, not the credential
  plus the guesser's IP (an attacker only needs to rotate IPs to reset
  an IP-scoped lock; keying on the target instead removes that
  escape hatch, at the cost of a legitimate user on a shaky connection
  potentially locking themselves out faster — same tradeoff the PIN
  lockout already accepts today).

## Testing plan

Stage 1 — done, see `server/api.persona-auth.test.js`:

- Enrollment requires the existing credential to change an
  already-enrolled one; first-time enrollment doesn't (can't silently
  reassign someone else's identity, but also isn't gatekept when
  there's nothing to reassign yet).
- Session issued by persona-login carries `personaId` and replaces the
  household-only session it came from.
- Revoking a persona's credential clears its lockout and reverts login
  to `NO_PERSONA_CREDENTIAL`, without touching any other persona.
- Lockout triggers after repeated wrong passwords and blocks even the
  correct password until cleared; independent per persona.
- No response (`GET /household`, `GET /backup`, `PUT .../ruolo`, etc.)
  ever includes `passwordHash` in the JSON body — checked directly
  against the serialized response, not just the documented shape —
  while the raw hash still exists in the database (proving
  sanitization is response-only, not data loss).
- A household with zero personas enrolled behaves identically to
  today across a dedicated regression check.

Stage 2 (not built) — planned, not yet written:

- Every row in the (not-yet-implemented) role-enforcement matrix:
  allowed for the right role, 403 for the wrong one, unchanged
  behavior when `personaId` is absent.

## Decisions (formerly open questions)

1. **Password vs. passkey priority — password first.** Reuses existing
   bcrypt/rate-limit infra, ships faster. Passkey is a later, additive
   enrollment option per persona, not a blocker for stage 1.
2. **Opt-in scope — permanently optional, no mandatory mode.** There is
   no stage 3 (see Migration plan). A household that never enrolls
   anyone is not on a deprecation path.
3. **Guest-role personas — get a real login, same as any other role.**
   `guest` is the lowest-privilege row in the role matrix for a real
   household member, unrelated to trip-share-link guests (a completely
   separate, unauthenticated-session mechanism that this design doesn't
   touch). A `guest` persona can enroll `auth.method` exactly like an
   `owner`/`admin`/`member` persona; what differs is what the role
   matrix permits them to do once authenticated, not whether they can
   authenticate at all.
4. **Rate limiting — specified**, see "Rate limiting for persona login"
   above: IP-keyed `express-rate-limit` outer bound + persistent
   `login_locks`-based lockout keyed on `householdId:personaId`,
   mirroring the household PIN's existing lockout mechanism exactly.
