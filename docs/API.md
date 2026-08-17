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
| GET | `/api/admin/metrics` | Operational snapshot (MOD-023): per-route request counts/error rates/latency percentiles (p50/p95/p99), background-job run/failure counts with the last error message, and a running sync-conflict tally (see `server/logger.js`). In-memory only — resets on server restart. |

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
