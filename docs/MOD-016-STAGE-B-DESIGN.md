# MOD-016 Stage B — breaking cutover design doc (not implemented)

Status: **design only, nothing in this document is built.** Stage A
(internal arithmetic + additive `*MinorUnits` companion fields, always
kept in sync on every write) is shipped — see the "MOD-016's two
stages" section in `API.md`. This document is the plan for Stage B:
making the integer companion field the actual persisted/API-canonical
one, and retiring the decimal field.

## Goals

- `importoMinorUnits` (and its siblings: `saldoInizialeMinorUnits`,
  `targetAmountMinorUnits`, `currentAmountMinorUnits`,
  `prezzoAcquistoMinorUnits`) become the real source of truth — not a
  companion a client is told it's safe to ignore.
- The decimal field (`importo`, etc.) is no longer required, no longer
  guaranteed accurate, and eventually not returned at all.
- Every phase below is independently safe to pause on or roll back
  from — no phase depends on rushing into the next one.

## Non-goals

- Renaming `importoMinorUnits` — the name stays; only its status
  (companion → canonical) changes.
- Any change to currency precision/rounding logic — `lib/money.js`
  already got that right in Stage A.
- Any change to MOD-025 (persona auth) — unrelated, shipped separately.
- Physically deleting the decimal fields from the database as part of
  this cutover — see Phase B3 below for why that's deliberately
  *not* part of the plan.

## Scoping the actual breaking surface

"Breaking" only matters because more than one thing reads/writes
`importo` and they don't all update in lockstep. For this app,
concretely, that's:

1. **The web frontend** (Vite/React via Vercel) — auto-deployed, every
   page load gets the latest build. No real version-lag problem here.
2. **The Capacitor-packaged mobile app** (iOS/Android) — THIS is where
   version lag is real: app store review time plus however long a
   given device takes to auto-update. A cutover that assumes every
   client is current the moment the server deploys is wrong for this
   one specifically.
3. **Widget/Shortcuts integrations** (`POST /api/widget/transaction`,
   `GET /api/widget`) — user-maintained personal scripts per `API.md`,
   not auto-updating with the server at all.
4. **`GET /api/backup` exports** — a JSON file a user might keep
   around indefinitely. A backup taken before the cutover has to still
   restore correctly after it.

(1) isn't a real constraint. (2) and (3) are what actually size the
compatibility window below, not a generic "assume some public API
consumer we know nothing about" SLA — this is a personal-scale app
with a known, small set of consumers.

## Migration sequence — expand → migrate → contract

Stage A already did "expand." This is "migrate" then "contract," each
as its own phase with its own rollback.

### Phase B0 — pre-flight integrity audit

Before touching any read/write path: a script (or a `verify`-only
migration, not part of `up`) that scans every money-bearing document
and confirms `importoMinorUnits === toMinorUnits(importo)` (and the
same for every sibling field) for 100% of documents. Stage A's
migration 001 and every write path since should already guarantee
this — B0 is the check that confirms it's actually true before
anything downstream starts trusting it, not an assumption. Any
mismatch found: **stop, investigate, do not proceed to B1** — a
mismatch here means either a Stage-A bug or a document that was
edited outside the app (e.g. directly in the database), and either
one needs a human decision, not an automated fix.

### Phase B1 — dual-accept, dual-return (the long, safe middle)

- **Server**: every write endpoint accepts *either* `importo` or
  `importoMinorUnits` in the request body. If both are present, they
  must agree — **reject with a clear error on mismatch, never silently
  prefer one.** (Silently preferring one is exactly the kind of
  "which field is actually true" ambiguity Stage A's `minorUnitsOf`
  was built to eliminate internally; the API boundary shouldn't
  reintroduce it.) If only one is present, derive the other.
- **Server responses**: keep returning both fields, exactly as today.
  A client that only ever looked at `importo` sees no change at all.
- **Frontend (web)**: switches to writing `importoMinorUnits` as the
  primary field on every create/update, and to reading it (not
  `importo`) for display/calculation — `lib/money.js`'s
  `fromMinorUnits`/`toMinorUnits` are already shared client+server code
  (Stage A), so this is wiring existing functions into
  `src/lib/format.js` and the transaction-entry forms, not new math.
  Continues to also send `importo` for the duration of B1, purely as a
  courtesy to a server that hasn't deployed B1 yet during a rolling
  deploy window.
- **Widget/Shortcuts docs**: updated to recommend `importoMinorUnits`;
  existing scripts sending only `importo` keep working completely
  unmodified — this phase does not require anyone to touch their
  script.

This phase is where the mobile app's version lag gets absorbed: an old
app-store build that only ever sends/reads `importo` keeps working for
as long as B1 stays live, with zero server-side special-casing beyond
"accept either."

### Phase B2 — telemetry-gated readiness gate

Not a code change — a **decision gate**, using metrics infrastructure
that already exists (MOD-023): add a counter for "requests that
included `importo` but not `importoMinorUnits`" (i.e., a client that's
still on the old-only format). B1 doesn't end on a calendar date; it
ends when that counter has been at zero for a full slow-client cycle
(app-store review + rollout — realistically weeks, not days, for
mobile). This turns "is it safe to cut over" from a guess into a
number you can actually look at.

### Phase B3 — contract: `importo` no longer returned or required

- Server stops returning the decimal field in responses.
- A write with only `importo` (no `importoMinorUnits`) is now
  rejected with a clear, actionable error — by this point B2 already
  established real traffic doesn't do this, so failing loud here is a
  safety net, not something expected to actually fire.
- **The decimal fields are NOT physically deleted from existing
  database documents in this phase.** Deleting them would be the one
  genuinely irreversible step in this whole plan, and it buys nothing
  — an unused field sitting in a document that nothing reads or writes
  anymore is inert. Physical cleanup (if ever wanted) is a separate,
  no-time-pressure, fully-optional future migration, explicitly not
  part of Stage B.
- `docs/API.md` / `docs/openapi.yaml` updated to reflect the field is
  gone from the contract.

## Rollback plan, per phase

- **B1 rollback**: trivial — B1 is purely additive on the server
  (accept either, still return both) and the frontend change is a
  normal deploy. Reverting either is a normal revert, no data was
  touched in a way that needs undoing.
- **B2 rollback**: N/A — it's a monitoring gate, not a code change.
- **B3 rollback**: redeploy the B1/B2-era server and frontend. Since
  decimal fields were never deleted, all data needed to serve `importo`
  again is still sitting right there.

## Testing plan

- B0: the audit script itself gets a test suite with deliberately
  mismatched fixtures, proving it actually flags them (not just that
  it runs).
- B1: request-body matrix — `importo` only, `importoMinorUnits` only,
  both matching, both mismatched (must reject) — for every affected
  endpoint. Response shape unchanged (both fields still present)
  regression-tested against the existing suite.
- B2: unit test for the new metrics counter itself (reuses the
  `server/logger.test.js` pattern from MOD-019/MOD-023).
- B3: every response asserted to NOT contain `importo`/sibling decimal
  fields; an `importo`-only request asserted to be rejected with a
  named error code; a pre-B3 backup JSON asserted to still restore
  correctly post-B3 (exercises the "old export still works" concern
  directly, not just in theory).

## Open questions — need a decision before implementation starts

1. **B1→B3 window length.** Weeks, sized to the slowest real client
   (mobile app-store rollout), is the default assumption above. Is the
   Capacitor mobile app actually shipped/installed anywhere right now,
   or still pre-release? That changes whether this constraint is real
   or can be shortened significantly.
2. **Is the widget/Shortcuts integration actually in active use?** If
   nobody currently has one configured, phase B1's backward-compat
   burden for it is theoretical, not real, and the window could be
   shorter.
3. **Reject-on-mismatch, confirmed?** The design above rejects a
   request that sends both fields disagreeing, rather than silently
   preferring one. This is the safer default (matches Stage A's own
   "no divergent-state failure mode" principle) but is worth an
   explicit sign-off since it's a new way for a write to fail that
   doesn't exist today.
4. **B3 trigger: calendar date, or purely the B2 metrics gate?** The
   design above says "wait for the counter to hit zero," not "wait N
   weeks regardless." Confirm that's actually the intended rule, since
   it means B3 could theoretically happen sooner (or need to wait
   longer) than a fixed calendar estimate.
