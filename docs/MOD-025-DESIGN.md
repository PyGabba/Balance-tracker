# MOD-025 full redesign — design doc (not implemented)

Status: **design only, nothing in this document is built**. The
foundation half of MOD-025 (`persone[].ruolo`, advisory-only, no
enforcement) is already merged — see "Household member roles" in
`API.md`. This document is the plan for the remaining, breaking half:
real per-user identity, with role checks that actually mean something.

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
  they stay exactly as they are. This redesign is about household
  members, not trip-share-link guests.
- A "guest" role member is not expected to get a real login — see Open
  Question 3.

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

## New/changed endpoints

- `POST /api/auth/persona-login` — body `{ personaId, password }` (or a
  WebAuthn assertion for passkey), issues a session with `personaId`
  set. Rate-limited like `POST /api/auth/login`.
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
2. **Enforcement, opt-in per request.** Wire `requirePersonaAuth` +ith 
   role checks onto the matrix above, but ONLY blocking when
   `personaId` is present and the role check fails. Households that
   haven't enrolled anyone see no change at all.
3. **(Future, not designed here) household-level "require persona
   login."** A household-wide flag that, once every persona has
   enrolled a credential, disables the PIN-only fallback entirely. Not
   part of this design — a household should be able to see stages 1-2
   work first.

No existing household is ever forced through a migration script for
this — unlike MOD-016's data migration, there's nothing to backfill;
`auth.method: null` is a valid, permanent, supported state for a
household that never wants individual logins.

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

## Testing plan (once implementation starts)

- Every row in the role-enforcement matrix: allowed for the right role,
  403 for the wrong one, unchanged behavior when `personaId` is absent.
- Enrollment requires the existing credential (can't silently
  reassign someone else's identity).
- Session issued by persona-login carries `personaId`; session issued
  by household-only login doesn't.
- Revoking one persona's credential doesn't affect any other persona's
  session or the household PIN.
- A household with zero personas enrolled behaves identically to today
  across the full existing test suite (regression gate).

## Open questions — need a decision before implementation starts

1. **Password vs. passkey priority.** Recommendation above: password
   first (reuses existing crypto/rate-limit infra, ships faster),
   passkey as a follow-up enrollment option. Confirm or override.
2. **Opt-in per-household, forever, or eventually mandatory?** This
   design assumes per-persona opt-in stays permanently optional (stage
   3's household-wide flag is speculative, not committed to). Confirm
   whether a future "require it for everyone" push is actually wanted,
   since that changes how much stage-3 needs designing now vs. later.
3. **Guest-role personas.** Should a `guest`-role household member ever
   get a real credential, or does "guest" in this system always mean
   "trip-share-link guest" (capability token, no household login at
   all — today's model, unaffected by any of this)? If household guests
   are meant to be a real category (e.g. a temporary member with
   limited access), that needs its own row in the role matrix.
4. **Rate limiting for persona login.** Needs its own limiter tier,
   keyed to `(householdId, personaId)` rather than just IP/household —
   worth sizing once stage 1 ships and there's a real enrollment count
   to reason about.
