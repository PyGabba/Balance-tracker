# Balance Tracker API Reference

This is the API contract for the Balance Tracker backend (`server/index.js`).
It documents every endpoint, the authentication model, error shapes,
pagination, idempotency, and rate limiting — the things that "just knowing
the code" doesn't make obvious to a new contributor or an external
integration. See also [`openapi.yaml`](./openapi.yaml) for a
machine-readable schema of the core resources.

This document reflects the API as of the Phase 1–5 modification work
(MOD-001 through MOD-024 in the modification plan). It is a snapshot, not
generated from the code — if you change an endpoint's contract, update this
file in the same change.

## Contents

- [Conventions](#conventions)
- [Authentication](#authentication)
- [Error shape](#error-shape)
- [Pagination](#pagination)
- [Idempotency](#idempotency)
- [Rate limiting](#rate-limiting)
- [Endpoint reference](#endpoint-reference)

---

## Conventions

- Base URL: relative paths (`/api/...`) proxied same-origin in production
  (via Vercel); `VITE_API_URL` or `http://localhost:3001` in development.
- All request/response bodies are JSON (`Content-Type: application/json`)
  unless noted (the calendar feed returns `text/calendar`).
- All amounts are decimal numbers (e.g. `12.34`), not integer minor units —
  see MOD-016 in the modification plan for the not-yet-implemented
  integer-cents model.
- Dates are `YYYY-MM-DD` strings, not ISO datetimes, except where a field
  is explicitly a full timestamp (e.g. `createdAt`).
- Every response carries an `X-Request-Id` header. Include it when
  reporting an issue — it correlates to the structured server logs
  (`server/logger.js`, MOD-023).

## Authentication

The household is the authentication and data-sharing boundary — there are
no per-user identities within a household (see MOD-025 for the
not-yet-implemented per-user model). A household authenticates with a PIN.

- **Session token**: issued by `POST /api/auth/login` or
  `POST /api/auth/register`, set as an **httpOnly, Secure (in production),
  SameSite=Strict** cookie named `token`. It is a JWT containing the
  household id and a `jti` (JWT ID); the `jti` is also stored server-side
  (`active_tokens` collection) so a session can be revoked (logout, PIN
  change/reset) independent of the JWT's own expiry.
- Every endpoint except `POST /api/auth/login`, `POST /api/auth/register`,
  `POST /api/auth/forgot-pin/*`, the widget/calendar/trip-share endpoints
  (which use their own capability tokens instead), and `GET /api/health`
  requires this cookie via the `requireHousehold` middleware.
- **Capability tokens** (widget key, calendar key, trip share token) are
  separate, unrelated bearer credentials — see their respective sections
  below. They do **not** grant access to the full API, only to the
  specific narrow surface each was designed for.
- **Admin endpoints** (`/api/admin/*`) use a completely separate mechanism:
  an `X-Admin-Secret` header matching the `ADMIN_SECRET` environment
  variable. Not related to household auth at all.

### Offline PIN verifier (client-side only)

The client caches a PBKDF2-derived verifier of the PIN in `localStorage`
purely to allow login-from-cache when the server is unreachable. This
**never** proves identity to the server — the real credential check is
always the server-side bcrypt comparison in `POST /api/auth/login`. See
`src/api.js` for the threat-model comment (MOD-010).

## Error shape

Two shapes currently coexist in the API (MOD-022 is a partial migration,
not yet applied to every endpoint):

**Legacy shape** (most endpoints):
```json
{ "error": "Human-readable message" }
```

**Structured shape** (the authentication gate, login, and every endpoint
touched during the security/scalability hardening work — transactions,
goals, trip expenses, capability tokens, and others):
```json
{
  "error": {
    "code": "UNKNOWN_PARTICIPANT",
    "message": "Human-readable, safe-to-display message",
    "fields": { "pagatoDa": "some-id" }
  }
}
```

`fields` is present only when there's something specific to point at
(which field failed validation, etc.) and is always safe to display —
never a stack trace or raw database error.

Clients should read the error message defensively: `src/api.js`'s
`errorMessageFrom(body, fallback)` handles both shapes uniformly:
```js
const message = (typeof body?.error === "string" ? body.error : body?.error?.message) || fallback;
```

### Common error codes (structured shape)

| Code | Meaning | Typical status |
|---|---|---|
| `NOT_AUTHENTICATED` | No session cookie | 401 |
| `INVALID_TOKEN` | Session cookie present but invalid/malformed | 401 |
| `SESSION_EXPIRED` | Valid JWT but the session was revoked (logout/PIN change elsewhere) | 401 |
| `PIN_CHANGE_REQUIRED` | Login succeeded but a forced PIN change is pending | 403 |
| `INVALID_PIN` | Login PIN didn't match | 401 |
| `ACCESS_BLOCKED` | IP/device/PIN-hash on the permanent blacklist | 403 |
| `RATE_LIMITED` | Login lockout after repeated failures | 429 |
| `DUPLICATE_IN_PROGRESS` | Another request with the same Idempotency-Key is still being processed — retry shortly | 425 |
| `INVALID_AMOUNT` / `INVALID_DATE` / `INVALID_TYPE` | Transaction field validation | 400 |
| `UNKNOWN_PARTICIPANT` / `UNKNOWN_SPLIT_PARTICIPANT` / `UNKNOWN_TRIP_PARTICIPANT` | Referenced person doesn't belong to this household/trip | 400 |
| `UNKNOWN_ACCOUNT` | Referenced account doesn't belong to this household | 400 |
| `SPLIT_TOTAL_NOT_100` | Split quotas don't sum to 100 (± small tolerance) | 400 |
| `TRANSFER_SAME_ACCOUNT` / `TRANSFER_ACCOUNTS_REQUIRED` | Transfer validation | 400 |
| `EXCHANGE_RATE_UNAVAILABLE` | No usable exchange rate (fresh or stale cache) for a currency conversion | 422 / 503 |
| `TRIP_TOO_MANY_EXPENSES` | Trip hit the 2000-expense hard limit (MOD-019) | 400 |
| `INVALID_CURSOR` | Malformed pagination cursor | 400 |
| `INTERNAL_ERROR` | Unexpected server error | 500 |

Never exposed to clients: stack traces, raw MongoDB error text, or request
payloads. Server-side logs (structured, MOD-023) carry the detail needed
to debug a specific failure via its `X-Request-Id`.

## Pagination

Only `GET /api/transactions` is paginated today (MOD-006); every other
list endpoint returns its full result set (reasonable for the current
scale of accounts/goals/trips/positions per household — see MOD-020's
review notes on the modification plan for the scaling story there).

- Cursor-based, not offset-based. Sort order is always `data` (date)
  descending, then `_id` descending as a tiebreaker.
- Query params: `limit` (default 1000, max 2000), `cursor` (opaque,
  base64url-encoded, echo back exactly what you were given), plus filters:
  `tipo`, `categoria`, `pagatoDa`, `contoId`, `meseAnno` (`YYYY-MM`), or
  `from`/`to` (`YYYY-MM-DD`, mutually exclusive with `meseAnno`).
- Response: `{ "transactions": [...], "nextCursor": "..." | null, "hasMore": boolean }`.
- To fetch everything: keep requesting with `cursor = nextCursor` while
  `hasMore` is true. `src/api.js`'s `fetchTransactions` does exactly this
  to build its local offline cache.

## Idempotency

Applies to the six creation endpoints that generate a real record with
financial or scheduling consequences: `POST /api/transactions`,
`POST /api/accounts`, `POST /api/goals`, `POST /api/trips`,
`POST /api/positions`, `POST /api/widget/transaction`.

- Send an `Idempotency-Key` header (any string up to 100 chars — the
  client's offline outbox uses the operation's own UUID). Requests without
  one proceed normally with no idempotency guarantee.
- First request for a given `(household, key)` pair: processed normally,
  the result is stored.
- A retry with the **same key**: replays the stored result — the entity is
  **not** created again. Works even for retries that arrive concurrently
  (the claim itself, not just the final result, is atomic — see MOD-004's
  hardening in the code comments above `claimIdempotencyKey`).
- If another request with the same key is still being processed when a
  concurrent one arrives, the second gets `425 DUPLICATE_IN_PROGRESS` —
  retry after a short backoff (this status is in the client's
  automatically-retryable set).
- Idempotency records expire after 7 days (comfortably longer than any
  realistic retry/reconnect window).

## Rate limiting

Every write and most reads are rate-limited per IP (`express-rate-limit`).
Approximate values as configured today — treat these as subject to change,
not a contract:

| Limiter | Window | Max |
|---|---|---|
| Login | — | Progressive lockout (IP + device + PIN-hash), see `checkLock`/`recordFail` |
| Writes (transactions, accounts, goals, trips, positions) | 1 min | 120 |
| Transaction list (paginated) | 1 min | 30 |
| Widget read | 1 min | 30 |
| Widget write | 1 min | 15 |
| Trip share (read) | 1 min | 30 |
| Trip share (write) | 1 min | 15 |
| Admin | 15 min | 5 |
| Quotes | 1 min | 5 |

A rate-limited request gets `429` with `{ "error": "..." }` (legacy shape)
or, for login lockouts, the structured `RATE_LIMITED` code.

---

## Endpoint reference

Auth column: 🔓 none · 🍪 household cookie · 🔑 capability token (query
param or URL path, noted per-endpoint) · 👑 admin secret header.

### Auth & household

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/auth/register` | 🔓 | Create a household. Body: `{ nome, persone: [{nome}], pin, email? }`. Returns the session (cookie set) plus household data. |
| POST | `/api/auth/login` | 🔓 | Body: `{ pin, deviceId? }`. Progressive lockout on repeated failures (IP + device + PIN-hash). Structured errors. |
| POST | `/api/auth/logout` | 🍪 | Revokes the current session token server-side. |
| PUT | `/api/auth/pin` | 🍪 | Change PIN. Body: `{ currentPin, newPin }`. Revokes all other sessions for the household. |
| POST | `/api/auth/forgot-pin/request` | 🔓 | Body: `{ email }`. Always returns a generic "if this email is linked..." response — never confirms/denies account existence. |
| POST | `/api/auth/forgot-pin/confirm` | 🔓 | Body: `{ email, code, newPin }`. |
| PUT | `/api/auth/recovery-email` | 🍪 | Set/change the household's recovery email. |
| DELETE | `/api/auth/household` | 🍪 | Permanently deletes the household and all its data. Body: `{ pin }` (re-confirmation required). |
| GET | `/api/household` | 🍪 | Current household's profile (name, members, currency, recovery-email flag). |
| PUT | `/api/household/valuta` | 🍪 | Set the household's base currency. |
| GET | `/api/exchange-rates` | 🍪 | Current exchange rate table for the household's base currency. `503 EXCHANGE_RATE_UNAVAILABLE` if no usable rate (fresh or stale). |
| GET | `/api/health` | 🔓 | Liveness check. |

### Transactions

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/transactions` | 🍪 | Paginated — see [Pagination](#pagination). |
| POST | `/api/transactions` | 🍪 | Idempotency-Key supported. Full validation via `validateTransactionInput` (MOD-001/002): type, amount, date, participants, accounts, split totals. |
| PUT | `/api/transactions/:id` | 🍪 | Partial update — only fields present in the body are validated/changed. |
| DELETE | `/api/transactions/:id` | 🍪 | Soft delete (moves to trash; `deletedAt` set). |
| GET | `/api/transactions/trash` | 🍪 | List soft-deleted transactions. |
| POST | `/api/transactions/:id/restore` | 🍪 | Undo a soft delete. |
| DELETE | `/api/transactions/:id/permanent` | 🍪 | Hard delete one trashed transaction. |
| DELETE | `/api/transactions/trash/empty` | 🍪 | Hard delete everything in the trash. |
| GET | `/api/stats/debiti` | 🍪 | Who-owes-whom summary across all splits. |
| GET | `/api/stats/summary` | 🍪 | Aggregation-based summary (MongoDB `$group`, not computed client-side). |

### Accounts, goals, positions

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET / POST | `/api/accounts` | 🍪 | POST supports Idempotency-Key. |
| PUT / DELETE | `/api/accounts/:id` | 🍪 | |
| GET / POST | `/api/goals` | 🍪 | POST validates `contoId` belongs to the household (MOD-009) and supports Idempotency-Key. |
| PUT / DELETE | `/api/goals/:id` | 🍪 | |
| GET / POST | `/api/positions` | 🍪 | Portfolio buy/sell records. POST supports Idempotency-Key. No PUT — positions are immutable once created. |
| DELETE | `/api/positions/:id` | 🍪 | |
| GET / PUT | `/api/positions/prices` | 🍪 | Manual price overrides (ticker → price) used when there's no live quote. |
| GET | `/api/quotes` | 🍪 | Live quote lookup (rate-limited, 5/min — external provider). |

### Trips

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET / POST | `/api/trips` | 🍪 | POST supports Idempotency-Key. |
| PUT / DELETE | `/api/trips/:id` | 🍪 | |
| POST | `/api/trips/:id/expenses` | 🍪 | Validates payer/splits against **this trip's own** `partecipanti` (MOD-009) — not the household's participant list, since trip guests may not be household members. Atomic 2000-expense hard limit (MOD-019). |
| DELETE | `/api/trips/:id/expenses/:expenseId` | 🍪 | |
| POST / DELETE | `/api/trips/:id/share` | 🍪 | Create/revoke a guest share link. Token is hashed at rest (MOD-011); expires 30 days after creation. |
| GET | `/api/trips/shared/:token` | 🔑 (URL path) | Guest-facing, no household auth. Returns a stripped-down trip view. |
| POST | `/api/trips/shared/:token/join` | 🔑 (URL path) | A guest adds themselves as a trip participant. |
| POST | `/api/trips/shared/:token/expenses` | 🔑 (URL path) | Same validation as the household-side expense endpoint (MOD-009 — both use the shared `buildTripExpense`). |

### Categories

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET / PUT | `/api/categorie` | 🍪 | Household's custom expense categories. PUT allow-lists object keys (`nome`/`icona`/`colore`/etc.) — max 100 entries. |
| GET / PUT | `/api/trip-categories` | 🍪 | Same pattern, for trip expense categories. |

### Backup

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/backup` | 🍪 | Full household data export as JSON (`formato: "balance-tracker-backup"`, versioned). |
| POST | `/api/backup/restore` | 🍪 | Imports a backup file. Accounts are inserted first and an old→new id map is built so transactions/goals referencing them get remapped correctly. Additive, not destructive — does not clear existing data first. |

### Widget (iOS/Scriptable-style home-screen widget)

Read-only aggregate access via a separate capability token — never the
household session, never write access beyond the one narrow transaction-add
endpoint.

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST / DELETE | `/api/widget-key` | 🍪 | Create/revoke the widget's capability token. The plaintext key is returned exactly once, at creation; only its hash is ever stored (MOD-011). |
| GET | `/api/widget` | 🔑 (`?key=`) | Returns aggregates only (balances, this-month totals, portfolio value) — never the raw transaction list. Computed via a MongoDB aggregation, not by loading full history into memory (MOD-020). |
| POST | `/api/widget/transaction` | 🔑 (`?key=`) | Deliberately minimal write surface: amount/date/category/payer/account only, no splits editing beyond what's passed, no deletes. Idempotency-Key supported. |

### Calendar feed

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST / DELETE | `/api/calendar-key` | 🍪 | Create/revoke the calendar subscription token. |
| GET | `/api/calendar.ics` | 🔑 (`?key=`) | Returns `text/calendar` — upcoming recurring transactions as calendar events, for subscribing in a calendar app. |

### Admin

Requires `X-Admin-Secret` header matching the `ADMIN_SECRET` environment
variable — entirely separate from household auth.

| Method | Path | Notes |
|---|---|---|
| GET / POST | `/api/admin/blacklist` | List / add a permanently-blocked IP, device, or PIN hash. |
| DELETE | `/api/admin/blacklist/:key` | Remove a blacklist entry. |
| GET | `/api/admin/metrics` | Request counts/error rates/latency percentiles per route, background-job run/failure counts, sync-conflict tally (MOD-023). In-memory, resets on server restart. |

---

## Background jobs

Not HTTP endpoints, but part of the system's behavior and worth documenting
alongside the API:

- **Recurring transaction generation** (`generaRicorrentiDovute`) — runs
  every 6 hours. Each occurrence gets a unique `(parentId, dueDate)` key
  enforced by a database unique index, so concurrent instances or retries
  can never generate the same occurrence twice (MOD-007).
- **Trip auto-settlement** (`chiudiViaggiScaduti`) — runs every 6 hours.
  Trips past their end date are atomically claimed via a
  `settlementStatus` state machine (`open → settling → settled`); each
  settlement transaction has a deterministic key, so a crash mid-settlement
  can resume safely without duplicating or losing a settlement (MOD-008).
- Both jobs emit structured logs and report into `GET /api/admin/metrics`
  (MOD-023).
