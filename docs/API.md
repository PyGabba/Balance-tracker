# Balance Tracker — API Reference

This documents the HTTP API implemented in `server/index.js`. It reflects
the code as of Phase 5 (MOD-024) — it does not describe an aspirational
contract, it describes what the server actually does today, including the
places where that's inconsistent (see [Known inconsistencies](#known-inconsistencies)).

See also [`openapi.yaml`](./openapi.yaml) for a machine-readable OpenAPI 3.0
schema of the core resources (auth, transactions, accounts, goals,
positions, trips + expenses/sharing, widget, admin metrics) — useful for
Swagger UI/Postman import or codegen. It's a narrower, schema-first
companion to this document, not a replacement for it; endpoints like
backup, categories, and the admin blacklist are documented here only.

## Base URL & transport

- All routes are prefixed `/api` except the CORS preflight catch-all.
- JSON in, JSON out, except `GET /api/calendar.ics` (`text/calendar`).
- CORS is restricted to a fixed allow-list (`ALLOWED_ORIGINS` + a Vercel
  preview-deploy regex) with `credentials: true`. Same-origin requests
  (the normal production path, via a Vercel proxy) never hit a CORS
  preflight at all.

## Authentication

Two independent auth mechanisms are used, depending on the route:

1. **Household session (JWT cookie)** — most `/api/*` routes. Login/register
   set an `httpOnly`, `sameSite=strict` cookie named `token` (JWT, HS256,
   90-day expiry, revocable server-side via an `active_tokens` collection
   keyed by the token's `jti`). Enforced by the `requireHousehold`
   middleware. Sending the cookie is the only way to authenticate — there is
   no `Authorization: Bearer` support despite `Authorization` being
   allow-listed as a CORS header (see [Known inconsistencies](#known-inconsistencies)).
   A revoked or expired session gets `401 SESSION_EXPIRED`; a missing cookie
   gets `401 NOT_AUTHENTICATED`; a malformed/invalid JWT gets
   `401 INVALID_TOKEN`.
2. **Capability tokens (bearer secrets, no session)** — widget key, calendar
   key, trip share token. Each is a 192-bit random token
   (`randomBytes(24).toString("base64url")`), stored server-side only as a
   SHA-256 hash, and passed by the client as a query string parameter
   (`?key=...` for widget/calendar) or a URL path segment (`/trips/shared/:token`).
   Holding the raw value grants exactly the access described below — there is
   no household session involved. Trip share tokens additionally expire
   30 days after creation (`TRIP_SHARE_TOKEN_TTL_DAYS`); an expired token is
   treated identically to a non-existent one (`404`), not a distinct "expired"
   error, so a client can't distinguish "wrong token" from "right token, too old."

Also: `requireHousehold` enforces a **forced PIN-change gate** — if a
household's `requiresPinChange` flag is set, every route except
`PUT /api/auth/pin` and `POST /api/auth/logout` returns
`403 PIN_CHANGE_REQUIRED` regardless of the token's validity.

### Capability token audit (MOD-011)

All three capability types share the same primitives
(`randomBytes(24).toString("base64url")`, `hashCapabilityToken` = SHA-256,
`findByCapabilityToken` for lookup) — this is the checklist every one of
them was verified against, not just asserted:

| | Widget key | Calendar key | Trip share token |
|---|---|---|---|
| Random secret | ✅ 192-bit | ✅ 192-bit | ✅ 192-bit |
| Hashed server-side | ✅ `widgetKeyHash` | ✅ `calendarKeyHash` | ✅ `shareTokenHash` |
| Explicit scope | Read-only aggregate snapshot (`GET /api/widget`) + `POST /api/widget/transaction`'s deliberately minimal write surface — never the raw transaction list | Read-only `.ics` feed of recurring-transaction templates — nothing else | Read-only trip view + guest join + guest expense logging, scoped to **this trip only**, never the rest of the household |
| Expiration | None (long-lived "subscribe once" credential, by design — see below) | None (same reasoning) | 30 days (`TRIP_SHARE_TOKEN_TTL_DAYS`) |
| Revoke | `DELETE /api/widget-key` | `DELETE /api/calendar-key` | `DELETE /api/trips/:id/share` |
| Regenerate | `POST /api/widget-key` — implicitly invalidates the previous one (one key per household, overwrites the hash) | `POST /api/calendar-key` — same | `POST /api/trips/:id/share` — same, per trip |
| Audit-logged create/revoke | ✅ `widget_key_created`/`widget_key_revoked` | ✅ `calendar_key_created`/`calendar_key_revoked` | ✅ `trip_share_created`/`trip_share_revoked` |
| Raw token ever logged | No — only the hash is persisted; `server/logger.js`'s `SENSITIVE_KEYS` redaction (`key`, `widgetkey`, `calendarkey`, `sharetoken`, case-insensitive) is a second line of defense on top of no call site ever passing the raw value to a log call | No | No |

**Why widget/calendar keys don't expire but trip share tokens do:** a
widget or calendar subscription is meant to be set up once and keep
working indefinitely — an unexpected expiry would silently break a home
screen widget or a calendar feed with no error the user would ever see
short of noticing stale data. A trip, by contrast, is an inherently
time-bound event; a share link is only ever needed for the trip's
duration plus some settling-up time after, and a copy of it circulating
long after the trip ended (a screenshot, a forwarded message) is a real
residual-risk case with no legitimate ongoing use. Both are intentional,
not an inconsistency — this table exists so that's verifiable rather than
assumed.

Found and fixed during this audit: `GET /api/calendar.ics`'s three error
responses (missing key, invalid key, and its catch-all) were still using
`res.status(...).send("plain text")` — the pre-MOD-022 pattern the rest
of the API moved off of, missed by that migration because it matched
`.json({error:...})` calls specifically and this route uses `.send()`
(the success response is `text/calendar`, not JSON). Now uses `sendError`
like every other route; only the success path stays `text/calendar`.

## Standard error shape

Introduced in MOD-022 (phase 3) via the `sendError(res, status, code, message, fields?)`
helper:

```json
{ "error": { "code": "UNKNOWN_ACCOUNT", "message": "Conto non valido: contoId", "fields": { "contoId": "..." } } }
```

`fields` is included only where relevant (mainly validation errors). Every
route in `server/index.js` now returns this shape on error — the full
migration away from the older plain `{ error: "text" }` shape (see
[Known inconsistencies](#known-inconsistencies) for what's still
inconsistent: success-response shapes, not error shapes).

## Rate limiting

Every route is behind one of these `express-rate-limit` instances (per IP,
`trust proxy: 1`):

| Limiter | Window | Max | Applied to |
|---|---|---|---|
| `loginLimiter` | 15 min | 30 | `POST /api/auth/login` |
| `registerLimiter` | 60 min | 5 | `POST /api/auth/register` |
| `forgotPinLimiter` | 10 min | 5 | forgot-PIN request/confirm |
| `adminLimiter` | 15 min | 5 | `/api/admin/*` |
| `quotesLimiter` | 60 s | 5 | `GET /api/quotes` (disabled endpoint) |
| `writeLimiter` | 60 s | 120 | most create/update/delete routes |
| `exportLimiter` | 60 s | 30 | `GET /api/transactions` (paginated list/export) |
| `widgetLimiter` | 60 s | 30 | `GET /api/widget` |
| `widgetWriteLimiter` | 60 s | 15 | `POST /api/widget/transaction` |
| `calendarLimiter` | 60 s | 30 | `GET /api/calendar.ics` |
| `tripShareLimiter` | 60 s | 30 | `GET /api/trips/shared/:token` |
| `tripShareWriteLimiter` | 60 s | 15 | trip-share join/expense routes |

A small number of routes (e.g. `GET /api/household`, `GET /api/goals`) have
no rate limiter of their own beyond `requireHousehold`'s implicit cost.

## Idempotency (MOD-004)

Client sends an `Idempotency-Key` header (any non-empty string, ≤100 chars)
on a create request. Applies to: `POST /api/transactions`,
`POST /api/positions`, `POST /api/goals`, `POST /api/accounts`,
`POST /api/trips`, `POST /api/widget/transaction`.

- First request for a given `(householdId, key)` pair proceeds normally; its
  response (status + body) is stored.
- A retry with the **same key** replays the stored response verbatim instead
  of creating a second entity — same status code, same body, including a
  `201` if that's what the original attempt produced.
- A retry that arrives **while the original is still in flight** gets
  `425 DUPLICATE_IN_PROGRESS` (transient — the sync engine's retry policy
  treats 425 as retryable).
- Records are kept 7 days (TTL index), comfortably longer than any realistic
  offline-retry window.
- Requests without a key proceed with no idempotency guarantee at all — this
  stays backward-compatible with any caller that doesn't send one.
- The key is scoped to `(householdId, key)`, **not** to the specific route —
  reusing the same key across two different endpoints for the same household
  is not something the server can distinguish and will misbehave (this
  isn't something any current client does, but it's a sharp edge worth
  knowing about).

## Pagination (MOD-006)

Only `GET /api/transactions` paginates. Cursor-based, not offset-based:

- Sort order is always `(data desc, _id desc)`.
- Response shape: `{ transactions: [...], nextCursor: string | null, hasMore: boolean }`.
- `nextCursor` is an opaque `base64url` blob (`encodeTransactionsCursor` /
  `decodeTransactionsCursor` in `server/validation.js`) encoding
  `{ d: <date string>, i: <last row's ObjectId as hex string> }` — i.e.
  "everything strictly before this (date, id) pair," not a page number or
  skip count. This keeps pages stable and gap-free even if rows are
  inserted/deleted between requests, and even with many rows sharing a date.
- Client passes it back unmodified via `?cursor=...` to get the next page.
  A malformed cursor is rejected with `400 INVALID_CURSOR` rather than
  silently falling back to page 1.
- `limit` query param: default 1000, max 2000, clamped (not rejected) if
  out of range.
- The only current caller (`src/api.js fetchTransactions`) drains every page
  to build a full local cache — this is a full-export mechanism as much as a
  "page 2 of the UI" mechanism, which is also why its rate limit
  (`exportLimiter`, 30/min) is more generous than the general write limiter.
  Full local caching is deliberate — offline mode, stats, and forecasting
  all need the household's complete history to be locally available, not
  just the newest N rows. What's paginated *on top of that* is DOM
  rendering: `HomeView` renders search/filter results (which, with the
  "all months" toggle, can match the full cached history) in pages of 100
  with a "load more" button, instead of mounting every matching row at
  once (MOD-006 follow-up).

---

## Auth — `/api/auth/*`

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/auth/register` | none (rate-limited) | Body: `{ nome, persone: string[]\|{nome,emoji?}[], pin: /^\d{6,8}$/, email? }`. Creates household, sets session cookie, returns `{ householdId, nome, persone }`. `409` on PIN or email collision. |
| POST | `/api/auth/login` | none (rate-limited + IP/device/PIN-hash lockout) | Body: `{ pin, deviceId? }`. `401 INVALID_PIN` on failure (with lockout bookkeeping); `429 RATE_LIMITED` with `retryAfterMinutes` once locked; `403 ACCESS_BLOCKED` if IP/device is on the admin blacklist. Sets session cookie on success. |
| POST | `/api/auth/logout` | session | Revokes the current `jti` from `active_tokens` and clears the cookie. |
| PUT | `/api/auth/pin` | session | Body: `{ newPin }`. Revokes **every** existing session for the household and issues a fresh one. Clears `requiresPinChange`. |
| POST | `/api/auth/forgot-pin/request` | none (rate-limited) | Body: `{ email }`. Always returns the same generic `{ ok: true, message }` regardless of whether the email exists (no account enumeration). Emails a 6-digit code, 15-min expiry, via SendGrid. |
| POST | `/api/auth/forgot-pin/confirm` | none (rate-limited) | Body: `{ email, code, newPin }`. Max 5 code attempts before the reset record is discarded. Revokes all sessions on success. |
| PUT | `/api/auth/recovery-email` | session | Body: `{ email }`. Attaches/updates the household's recovery email. |
| DELETE | `/api/auth/household` | session | Body: `{ pin }` (must match). **Irreversibly deletes every collection's data for this household** (transactions, accounts, goals, trips, positions, pinResets) and the household itself. |

## Household & settings

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/household` | session | `{ id, nome, persone, hasRecoveryEmail, valutaBase }`. |
| PUT | `/api/household/valuta` | session | Body: `{ valutaBase }` — any 3-letter ISO-4217-shaped code, not a hardcoded whitelist. |
| GET | `/api/exchange-rates` | session | Returns the household's base-currency rate table (cached 24h server-side). `503` if unavailable. |
| GET | `/api/categorie` | session | Household's custom expense categories, or `null` (client falls back to its own defaults). |
| PUT | `/api/categorie` | session | Body: `{ categorie: (string \| object)[] }`, ≤100 items. |
| GET | `/api/trip-categories` / PUT | session | Same shape as `/api/categorie`, separate field, used for trip expenses. |
| GET | `/api/health` | none | `{ status: "ok", db: boolean }` — liveness check, no auth. |

## Transactions — `/api/transactions*`

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/transactions` | session | Cursor-paginated (see above). Filters: `tipo, categoria, pagatoDa, contoId, meseAnno (YYYY-MM), from/to (YYYY-MM-DD), cursor, limit`. |
| POST | `/api/transactions` | session | Idempotency-Key supported. Body validated centrally by `validateTransactionInput` (`server/validation.js`) — see below. `422 EXCHANGE_RATE_UNAVAILABLE` if `valuta` is given and no rate/cache is available (never silently 1:1). |
| PUT | `/api/transactions/:id` | session | Partial update — only fields present in the body are validated/changed; cross-field rules (transfer accounts, splits) still see the merged document. |
| DELETE | `/api/transactions/:id` | session | Soft delete (`deletedAt` set) — moves to trash, not gone yet. |
| GET | `/api/transactions/trash` | session | Soft-deleted transactions, most recently deleted first. |
| POST | `/api/transactions/:id/restore` | session | Un-deletes. |
| DELETE | `/api/transactions/:id/permanent` | session | Hard delete of a single trashed transaction. |
| DELETE | `/api/transactions/trash/empty` | session | Hard delete of everything currently in trash. Trash also auto-purges after 30 days via the `svuotaCestinoScaduto` background job. |
| GET | `/api/stats/debiti` | session | N-person debt-settlement matrix (who owes whom, minimal number of transfers). |
| GET | `/api/stats/summary` | session | Aggregated totals grouped by `(tipo, categoria, pagatoDa)`, optionally filtered by `meseAnno`. |

**Transaction validation rules** (`validateTransactionInput`, shared by POST,
PUT, and — via `buildTripExpense`/`computeValidSplits` — the widget and trip
endpoints):

- `importo`: finite number, strictly `> 0` (rejects `0`, negative, `NaN`,
  `Infinity`), rounded to 2 decimals.
- `data`: `YYYY-MM-DD`, calendar-valid (rejects e.g. `2026-02-30`).
- `tipo`: one of `uscita | entrata | saldo | trasferimento`.
- `pagatoDa` / `ricevutoDa` / `intestataA`: must be a known participant —
  a household member id, or an `extraPersone` id declared on the *same*
  request (or already present on the existing doc, for a partial PUT).
- `splits`: each entry's `personaId` must be a known participant; quotas
  `0–100`; no duplicate participants; **total must be `100 ± 0.05`** (tight
  enough to reject `40+40`, loose enough for `33.33+33.33+33.34`).
- `contoId` / `contoDa` / `contoA`: must be an account id that actually
  belongs to the requesting household (`UNKNOWN_ACCOUNT`) — this is the
  MOD-009 cross-household guessing defense.
- `tipo: "trasferimento"` requires both `contoDa` and `contoA`, and they
  must differ (`TRANSFER_ACCOUNTS_REQUIRED` / `TRANSFER_SAME_ACCOUNT`).

## Accounts (conti) — `/api/accounts*`

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/accounts` | session | |
| POST | `/api/accounts` | session | Idempotency-Key supported. Body: `{ nome, icona?, saldoIniziale? }`. |
| PUT | `/api/accounts/:id` | session | Partial update. |
| DELETE | `/api/accounts/:id` | session | Detaches (nulls out) the account reference on every transaction/goal that pointed at it instead of leaving dangling ids. |

A `trasferimento` transaction moves money between two accounts (`contoDa`→`contoA`);
`entrata`/`uscita` move it in/out of `contoId`. Balances are **not** computed
server-side by a dedicated endpoint — clients compute them from
`GET /api/accounts` + `GET /api/transactions` (see `src/lib/finance.js
calcolaSaldiConti`), except the widget endpoint, which does compute balances
server-side via a Mongo aggregation for its own response.

## Goals — `/api/goals*`

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/goals` | session | |
| POST | `/api/goals` | session | Idempotency-Key supported. Body: `{ nome, targetAmount, targetDate?, currentAmount?, contributionType?, contributionValue?, autoAdd?, contoId? }`. `contoId`, if given, must belong to this household (`400 UNKNOWN_ACCOUNT`). |
| PUT | `/api/goals/:id` | session | Partial update, same `contoId` ownership check. |
| DELETE | `/api/goals/:id` | session | |

## Portfolio / positions — `/api/positions*`

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/positions` | session | |
| POST | `/api/positions` | session | Idempotency-Key supported. Body: `{ ticker, quantita, prezzoAcquisto, dataAcquisto?, valuta?, note?, tipo? ("buy"\|"sell") }`. |
| DELETE | `/api/positions/:id` | session | |
| GET / PUT | `/api/positions/prices` | session | Manual price overrides (`{ manualPrices: { TICKER: number } }`, ≤200 entries) — the live-quote endpoint below is disabled, so this is the only price source. |
| GET | `/api/quotes` | session | **Disabled.** Always `410 Gone` — "Usa i prezzi manuali." Kept only so old clients get a clear error instead of a 404. |

### Cost-basis accounting (MOD-018)

**This is portfolio *tracking*, not tax accounting.** It exists to answer
"what is this worth and how has it done," not "what do I owe in capital
gains tax." No jurisdiction's specific tax-lot rules (FIFO/LIFO election,
wash-sale adjustments, long/short-term holding-period splits, etc.) are
modeled. If a `sell` position needs to be reported to a tax authority,
treat this as a starting point for that calculation, not the calculation
itself.

**Method: single average cost per ticker**, computed by
`computeHoldingsBreakdown` (`src/services/portfolioService.js`, mirrored by
`calcolaValorePortfolio` in `src/lib/finance.js` for the lighter-weight
value-only case) — not FIFO, not LIFO, not per-lot. Every `buy` for a
ticker pools into one running `(quantità, costoTotale)`; every `sell`
draws down that same pool at its current average cost, regardless of
which specific earlier `buy` "the shares came from." This is deliberate:
per-lot tracking would need a lot-matching policy (FIFO vs. LIFO vs.
specific-lot) that this app has no basis for choosing on the user's
behalf, and average-cost is both simpler to reason about and the more
common default for personal (non-tax-lot-elected) tracking.

- **Chronological, not insertion-order.** Trades are sorted by
  `(dataAcquisto, createdAt)` before processing, so a `sell` entered before
  an earlier-dated `buy` (backfilling a receipt, correcting a typo'd date,
  etc.) still nets against the right average cost — not against whatever
  happened to exist in the array at insert time. Covered by "out-of-order
  trades" tests in both `finance.test.js` and `portfolioService.test.js`.
- **Partial sale:** a `sell` for less than the held quantity reduces
  `costoTotale` by `soldQty × averageCost` and `quantità` by `soldQty`,
  leaving the *average cost of the remainder unchanged* — exactly what
  average-cost accounting means. Realized P&L for that sell is
  `soldQty × (sellPrice − averageCostAtTimeOfSale)`.
- **Full sale (closed position):** quantity reaches (within a `0.0001`
  floating-point tolerance) zero — cost basis is zeroed out with it, and
  the position moves from the open `holdings` list to `closedHoldings`,
  keyed by its last trade date. A closed position never contributes to
  `totalInvestito`/`totalValore`; only its realized P&L persists.
- **Overselling is clamped, not rejected.** A `sell` for more than the
  currently-held quantity (a manual-entry mistake, or two sells racing) is
  silently capped to the held quantity — `Math.min(sellQty, heldQty)` — so
  quantity and cost basis can never go negative. This trades "tell the
  user their data is wrong" for "never show a nonsensical negative
  holding"; there is currently no user-facing warning when a clamp
  happens, which is itself worth knowing if you're debugging why a
  recorded sell quantity doesn't match what got realized.
- **Zero holdings:** an empty position list, or a ticker whose trades net
  to zero, simply contributes nothing — `holdings`/`totalValore` are `0`/
  `[]`, not an error state.
- **Realized vs. unrealized P&L are tracked and shown separately** (see
  `PortfolioView.jsx`'s "Realized"/"Unrealized" figures) — realized comes
  only from `sell` trades already recorded; unrealized is
  `currentValue − costBasis` on what's still held, and is `0`/hidden for
  any ticker with no manual price set (see below), not silently computed
  against cost basis as if that were the current price.

**Known limitations, not yet handled:**

- **No fees.** `prezzoAcquisto` is the trade price only; brokerage/
  transaction fees aren't a modeled field anywhere, so cost basis and
  realized P&L are both fee-exclusive. A user who wants fee-accurate
  figures needs to fold the fee into the recorded price themselves.
- **No currency conversion.** Each position has a `valuta` field (default
  `EUR`), but nothing in the cost-basis calculation reads it — quantities
  and prices across every position are summed as if they were all the
  same currency, regardless of what `valuta` says. Recording a position
  in a currency other than the household's base currency will silently
  produce a wrong total, the same failure mode MOD-005 eliminated for
  transactions (an unavailable/ignored exchange rate) — just not yet
  fixed here.
- **Price source is manual-only.** The live-quote endpoint is disabled
  (see the table above); an open position with no manual price set has no
  current value distinct from its cost basis, so its unrealized P&L shows
  as `0`/`—` rather than "unknown." Don't read a `0` unrealized P&L as "no
  gain or loss" without checking whether a manual price is actually set.

**Acceptance criterion this section exists to satisfy:** identical
transaction history always produces deterministic portfolio results — the
sort-then-fold algorithm above has no hidden state, no wall-clock
dependency, and no randomness, so re-running it against the same trades
(regardless of the order they were originally entered) always produces
the same `holdings`/`closedHoldings`/realized-P&L numbers. See
`finance.test.js` and `portfolioService.test.js` for the tests that pin
this down (partial sale, full sale, oversell clamp, out-of-order,
zero-holdings).

## Backup & restore — `/api/backup*`

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/backup` | session | Full JSON export of everything for the household: transactions, accounts, goals, trips, positions, manual prices, plus household metadata. `formato: "balance-tracker-backup"`, `versione: 1`. |
| POST | `/api/backup/restore` | session | Re-imports a backup produced by the endpoint above. **Additive, not destructive** — nothing existing is deleted first; restored rows get a `restoredAt` timestamp. Account ids are remapped (old→new) so restored transactions/goals still point at the right restored account. Custom categories are only restored if the household currently has none set. |

## Widget — `/api/widget*`, capability-token auth

No household session involved — authenticated purely by a `?key=` query
param checked against the household's hashed `widgetKeyHash`.

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/widget-key` | session | Issues a new widget key (invalidates any previous one implicitly — a household has at most one). Raw key is returned **once**, in this response only; never persisted server-side or logged. |
| DELETE | `/api/widget-key` | session | Revokes it. |
| GET | `/api/widget` | key (query) | Read-only aggregate snapshot: account balances, portfolio value, this-month income/expense totals, categories, people. Computed server-side via a Mongo aggregation (not a full transaction-history load) so it's cheap to poll frequently. |
| POST | `/api/widget/transaction` | key (query) | Deliberately minimal write surface: `tipo` (`uscita`/`entrata`), `importo` (capped at 1,000,000), `descrizione`, `data`, optional `categoria`/`pagatoDa`/`intestataA`/`splits`/`contoId` — each cross-checked against the household and **silently dropped** (not rejected) if invalid, since this endpoint is meant to be forgiving for third-party shortcuts/automations. Idempotency-Key supported. |

## Calendar feed — `/api/calendar*`, capability-token auth

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/calendar-key` | session | Issues a calendar subscription key. |
| DELETE | `/api/calendar-key` | session | Revokes it. |
| GET | `/api/calendar.ics` | key (query) | Returns a `text/calendar` feed (RFC 5545) of the household's recurring-transaction templates as `RRULE` events, for "subscribe by URL" in Google/Apple/Outlook calendars. Read-only, no write counterpart. |

## Trips — `/api/trips*`

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/trips` | session | |
| POST | `/api/trips` | session | Idempotency-Key supported. Body: `{ nome, descrizione?, startDate?, endDate?, partecipanti? }`. |
| PUT | `/api/trips/:id` | session | Partial update. |
| DELETE | `/api/trips/:id` | session | |
| POST | `/api/trips/:id/expenses` | session | Body validated by `buildTripExpense` against **this trip's own `partecipanti`**, not the household's member list (a trip can include guests who joined via a share link and were never household members). `400` if the trip is already `settled`. Enforces a hard cap of 2000 embedded expenses per trip (atomic, via `$expr` on the same write — not a separate check-then-push), plus a soft warning logged past 300. |
| DELETE | `/api/trips/:id/expenses/:expenseId` | session | |
| POST | `/api/trips/:id/share` | session | Issues a share token (30-day TTL), stored hashed. |
| DELETE | `/api/trips/:id/share` | session | Revokes it immediately (independent of the TTL). |

### Embedded-array scalability (MOD-019)

Trip expenses live embedded inside the trip document (`trips.expenses[]`),
not in their own collection — simple and fast for the normal case, but
MongoDB's 16MB document limit and `$push`'s whole-document-rewrite cost
mean that stops being the right model at some size. Rather than guess at
a threshold, this measures:

- **A single expense's real size.** `{ id, pagatoDa, importo,
  importoMinorUnits, descrizione, categoria, data, splits }` with a
  realistic description and a 2-person split serializes to **~270 bytes**
  (measured via `Buffer.byteLength(JSON.stringify(...))`, not estimated).
- **Current hard limit (2000 expenses) → ~527 KB per trip document** —
  about **3.3% of the 16MB BSON limit**. The document-size ceiling is not
  the binding constraint at the current limit; there's roughly 30x
  headroom before it would be. (Reaching the 16MB limit at ~270
  bytes/expense would take ~62,000 expenses on a single trip — nobody is
  near that.)
- **The actual risk is write cost, not size**: every `POST
  /api/trips/:id/expenses` does a `$push` against the whole document, and
  `GET /api/trips` returns every expense of every trip in one response —
  both costs scale with expense count regardless of whether the 16MB
  ceiling is anywhere close. `GET /api/admin/metrics` already tracks p50/
  p95/p99 latency per route (MOD-023), so `POST /api/trips/:id/expenses`
  and `GET /api/trips` latency is the number to actually watch, not
  document size.
- **Runtime instrumentation** (`recordTripEmbeddingStats` in
  `server/logger.js`, fed by `GET /api/trips` and every expense write):
  `GET /api/admin/metrics` → `tripEmbedding` reports the largest expense
  count and largest (JSON-approximated) document size seen across every
  trip fetched or written since the process started, plus how many trips
  have crossed the 300-expense warn threshold. This is what "evidence"
  means here — numbers a deployment actually produces, not a one-time
  estimate.

**Migration trigger (revisit when any of these is actually observed, not
before):** move to a `trip_expenses` collection (`{ tripId, expenseId,
date, amount, participants }`, indexed on `tripId`) if *either* (a)
`tripEmbedding.maxDocumentSizeBytes` exceeds roughly 1MB (a large margin
under the 16MB cap, left deliberately conservative since write cost
degrades before the hard limit does) or (b) `POST
/api/trips/:id/expenses` / `GET /api/trips` p95 latency climbs and stays
elevated as `tripEmbedding.maxExpenseCount` grows. **Neither condition is
currently observed in this codebase's own usage** — the existing 300-warn/
2000-hard-limit guard is doing its job as an early-warning system, and
normalizing now would be solving a problem that doesn't exist yet. This
section is the record of *why* that's the right call today, and the
metric to watch for when it stops being one.

### Trip guest access — capability-token auth, no household session

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/trips/shared/:token` | share token (path) | Returns a stripped view of the trip (no `householdId`). `404` if the token is invalid, revoked, **or expired** — indistinguishable from each other by design. |
| POST | `/api/trips/shared/:token/join` | share token (path) | Body: `{ nome }`. Adds the guest to `trip.partecipanti` (idempotent by normalized name — rejoining with the same name returns the existing participant instead of duplicating). |
| POST | `/api/trips/shared/:token/expenses` | share token (path) | Same validation/limits as the household version above, plus a friendlier error message specifically for "you tried to log an expense before joining."|

## Admin — `/api/admin/*`

Header-secret auth (`x-admin-secret` must equal `ADMIN_SECRET` env var — if
unset, every admin route returns `503`), separate from both the session and
capability-token mechanisms above.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/admin/blacklist` | List blocked IP/device keys. |
| POST | `/api/admin/blacklist` | Body: `{ key, reason? }` — `key` is e.g. `ip:1.2.3.4` or `device:<uuid>`. Permanent block, independent of the temporary lockout mechanism. |
| DELETE | `/api/admin/blacklist/:key(*)` | Un-blocks. |
| GET | `/api/admin/metrics` | Operational snapshot (MOD-023): per-route request counts/error rates/latency percentiles (p50/p95/p99), background-job run/failure counts with the last error message, a running sync-conflict tally, and trip embedded-array size/count instrumentation (`tripEmbedding`, MOD-019 — see "Embedded-array scalability" above) (see `server/logger.js`). In-memory only — resets on server restart. |

## Background jobs (not HTTP endpoints)

Three jobs run on a server timer (every 6h, plus once at boot) — documented
here because they affect what shows up via the API even though they aren't
routes themselves:

- **`generaRicorrentiDovute`** — generates due occurrences of recurring
  transactions. Concurrency-safe across multiple server instances via a
  unique index on `(parent transaction id, due date)`.
- **`svuotaCestinoScaduto`** — hard-deletes trashed transactions older than
  30 days.
- **`chiudiViaggiScaduti`** — auto-settles and closes trips past their
  `endDate`. Crash-resumable: a trip stuck mid-settlement for >10 minutes is
  reclaimed and resumed rather than left stuck or re-settled from scratch.

All three log structured start/end/failure JSON lines (job name, a
per-run id, counts, duration) — see MOD-023.

## Migrations (MOD-026)

Not an HTTP endpoint — a CLI (`server/migrate.js`), run manually against
whatever database `MONGODB_URI`/`DB_NAME` point at (same env vars, same
defaults, as the server itself):

```
node migrate.js status              # list every migration + applied/pending
node migrate.js up --dry-run        # report what would change, write nothing
node migrate.js up                  # run every pending migration
```

Each migration (`server/migrations/*.js`) is a plain module exporting
`{ id, description, up(db, ctx) }`; the runner (`server/migrations/runner.js`)
tracks completed ones in a `schema_migrations` collection so `up` is
always safe to re-run — already-applied migrations are skipped, and every
migration is additionally idempotent on its own terms (filters its update
query on "field not already set"), so an interrupted run can also just be
re-run. There is no `down()` — every migration so far is additive (adds a
derived field, never removes/overwrites the original), which is what
makes "undo" unnecessary: stop reading the new field.

**Migration 001** backfills `*MinorUnits` integer-cents companion fields
(MOD-016) onto every existing money-bearing document — `transactions`,
`accounts`, `goals`, `positions`, and each element of `trips[].expenses` —
without touching the original decimal field, so it cannot change any
stored balance. Every write path has set the companion field going
forward since this migration was added, so running it once catches
existing data up; nothing about the API contract changes (the decimal
field is still what every response returns and what the server still
reads everywhere except lib/money.js's arithmetic helpers).

This does **not** back up the database first — take a snapshot before
running `up` against production. See the file-level comment in
`server/migrate.js` for why that's still worth doing even though every
migration here is written to be additive/idempotent.

### MOD-016's two stages — "contract phase" is internal-only, on purpose

MOD-016's storage side is deliberately split into two separate,
independently-riskier stages, and only the first is done:

- **Stage A (done): internal cutover, non-breaking.** Every write path
  sets `*MinorUnits` alongside the decimal field (migration 001 backfills
  existing data — see above). `lib/money.js`'s `minorUnitsOf(entity,
  field)` is the single place that decides which one a calculation
  actually reads: the companion field if it's a number, otherwise convert
  the decimal field. Every internal financial calculation across both
  `src/lib/finance.js` and `server/index.js`'s duplicated equivalents
  (debt matrix, account balances, trip settlement, forecast, portfolio
  cost basis, goal contributions) now reads amounts through this accessor
  — not scattered per-call-site decisions between the two fields, which
  is exactly the failure mode that would let two code paths compute two
  different balances from the same document. The API/DB contract is
  completely unchanged: `importo` is still what every response returns
  and what a client sends; `importoMinorUnits` is optional and ignorable.
  Zero coordinated deploy required, zero external-integration risk.
- **Stage B (not started, not scheduled): breaking cutover.** Making
  `importoMinorUnits` the *persisted, canonical* field — dropping decimal
  `importo` from the API/DB entirely — is a real breaking API change: it
  needs a coordinated frontend+backend deploy, and it breaks any external
  widget/Shortcuts integration still parsing `importo` from a response.
  Doing that now would be solving a problem Stage A already solves
  (floating-point drift in financial arithmetic) for no additional benefit
  today. If Stage B is ever undertaken, it's its own migration/release
  gated on the same backup-first discipline as migration 001, not a
  continuation of this one.

Confidence that Stage A didn't change any calculated result: every
function converted was already covered by pre-existing tests pinning
exact expected values (`finance.test.js`, `portfolioService.test.js`,
`goalsService.test.js`, `debtService.test.js`, plus the server-side
`api.transactions.test.js` integration suite) — all of them still pass
unchanged, on top of new tests specifically proving `importoMinorUnits`
wins over a deliberately-inconsistent decimal value when both are present
(`money.test.js`, `finance.test.js`).

---

## Known inconsistencies

Documented here rather than silently fixed — standardizing these is
MOD-012-13 (phase 6) scope, not phase 5's. MOD-022 (error shape) is done.

- **Success response shapes are inconsistent.** Some POST endpoints
  return the created entity in-body (`{ id, ...doc }` — transactions,
  accounts, goals, positions); `POST /api/trips` does the same but via
  `res.json(...)` instead of `res.status(201).json(...)` (some think success);
  some just return `{ ok: true }` (categories, prices, widget/calendar-key
  creation, trip-categories) with no way to read back what was actually
  stored without a follow-up GET.
- **`Authorization` header is CORS-allow-listed but unused.** `CORS_OPTIONS.allowedHeaders`
  includes `Authorization`, but the only auth path implemented is the
  `token` cookie — there is no code path that reads an `Authorization`
  header. Likely leftover from an earlier design or defensive future-proofing;
  as written today it's dead configuration.
