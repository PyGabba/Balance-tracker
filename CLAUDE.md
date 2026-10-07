# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev              # client (Vite) + server (node --watch) concurrently
npm run dev:client        # Vite dev server only
npm run dev:server        # Express API only (server/, auto-restart)
npm run build             # vite build -> dist/
npm run preview           # preview the production build
npm test                  # vitest run (whole suite, client + server)
npx vitest run <path>     # single file, e.g. npx vitest run src/lib/money.test.js
npx vitest run -t "<name>" # single test by name
node server/migrate.js status          # list migrations + applied/pending
node server/migrate.js up [--dry-run]  # run pending migrations
```

Server tests (`server/*.test.js`) spin up a real single-node MongoDB replica set via `mongodb-memory-server` (see `server/testUtils.js`) — first run downloads a `mongod` binary. `vitest.config.js` sets generous `hookTimeout`/`testTimeout` (60s/30s) specifically for this; don't lower them for server suites.

`npm run lint` runs ESLint (flat config in `eslint.config.js`); CI runs it, tests, and the build on every PR (`.github/workflows/ci.yml`).

## Architecture

Full-stack: React 18 (Vite) SPA in `src/`, Express API in `server/`, MongoDB. `server/index.js` is now just the app bootstrap (middleware wiring, mounting route modules, startup/background-job intervals) — the former ~3300-line monolith was split by domain into `server/routes/*.js` (admin, auth, household, transactions, stats, categories, positions, goals, accounts, backup, widget, calendar, trips), each an `express.Router()` registered with its original full `/api/...` paths and mounted at `/`. `server/shared.js` holds everything those routers depend on: the Mongo connection/collections (`db`, `transactionsCol`, etc. — plain `let` bindings reassigned inside `connectDB()`, exported live so a router sees the connected instance without re-importing), auth/RBAC middleware (`requireHousehold`, `requireRole`, `sendError`), rate limiters, lockout/idempotency/capability-token helpers, multi-currency conversion, and the three background jobs (`generaRicorrentiDovute`, `svuotaCestinoScaduto`, `chiudiViaggiScaduti`). A handful of route-local helpers (e.g. `requirePortfolioAccess`, Yahoo quote fetching in `positions.js`; guest trip-token signing in `trips.js`) stay inside their own router file since nothing else needs them — `isHouseholdAccount` is the one exception promoted to `shared.js` because both `positions.js` and `goals.js` call it. Within one router file, routes for the same HTTP method are matched in registration order, and `:param` matches any single path segment including a literal sibling — `PUT /api/positions/:id` registered before `PUT /api/positions/prices` silently swallowed every `/prices` request as an invalid `:id` (400) for as long as that ordering existed, including in the original pre-split monolith. Register a literal sub-path (`/prices`, `/trash`, etc.) *before* any `:id`-shaped route at the same depth for the same method; `server/routes-ordering.test.js` guards the positions.js case directly and runs without a live MongoDB. Deploy split: frontend on Vercel (`vercel.json` proxies `/api/*` to a Render-hosted API), backend on Render. Don't add files under `api/` (repo root, outside `src`/`server`) — Vercel's filesystem routing for `api/*.js` serverless functions takes priority over the `vercel.json` rewrite, so any file there silently shadows the real Express route at the same path instead of reaching it (this bit `/api/quotes` in production: a leftover `api/quotes.js` intercepted every request and 404'd before Render's implementation ever ran).

### Auth & multi-tenancy model

A "household" is the tenant: register with a name + participants ("persone") + a 6-8 digit PIN, no admin setup. The PIN is hashed (bcrypt) and looked up via `pinLookupKey`; legacy plain-text PINs are migrated to hashed on first successful login. Session = JWT in an httpOnly cookie, verified by `requireHousehold` middleware (`server/shared.js`), which also enforces a `requiresPinChange` lock (`PIN_CHANGE_EXEMPT` lists the two routes still reachable while locked).

On top of the household-level PIN, a persona can optionally log in individually (`persona-login`) to get a `personaId` on the JWT and a household role (`owner` > `admin` > `member` > `guest`, see `ROLE_RANK`). `requireRole(minRole)` is **permissive when `req.personaId` is unset** — a plain household-PIN session (the default, pre-MOD-025 case) bypasses every role check by design, so adding a new `requireRole()` call never breaks a household that hasn't enrolled personas. Don't "fix" this into a hard 403 for anonymous sessions without understanding that tradeoff (see `docs/MOD-025-DESIGN.md`).

### Offline-first sync (client)

Every write goes through `src/lib/syncEngine.js`, not `fetch` directly. Three-layer split:
- `src/lib/outboxLogic.js` — pure functions (operation construction, ordering, conflict/merge rules, backoff). No I/O; this is what `outboxLogic.test.js` exercises directly.
- `src/lib/offlineDb.js` — IndexedDB persistence (entities + outbox queue + sync metadata).
- `src/lib/syncEngine.js` — wires the two together and talks to the network. Writes hit the outbox *before* any UI-visible state change; retries use `Idempotency-Key = operationId` so a retry can't duplicate; a fresh server snapshot never silently clobbers a pending local edit (conflict counter exposed via `onSyncStatusChange`).

`ENTITY_ENDPOINTS` in `syncEngine.js` lists which entities (transactions/accounts/goals/trips/positions) go through this path. `tripExpenses` is deliberately excluded — not a top-level REST resource — and special-cased in `runSync`.

### Money representation

Never accumulate raw floats for currency math. `src/lib/money.js` converts decimal amounts to integer minor units (cents) for arithmetic; a `*MinorUnits` companion field is stored alongside the decimal field on every write path (server/validation.js writes it, migration `001_amount_minor_units` backfilled existing records). Internal calculations prefer the `MinorUnits` field when present, falling back to converting the decimal field for pre-migration documents. The API/DB contract itself is still the decimal field — this is an internal-only cutover, not a breaking one. Zero-decimal currencies (JPY, KRW, VND, CLP, ISK, HUF) are handled explicitly in `minorUnitsPrecision`.

### Server migrations

`server/migrations/*.js` — numbered, tracked in a `schema_migrations` collection so each runs at most once. No `down()`/rollback by design: migrations here are additive (add a derived field, never remove/overwrite), so "undo" just means "stop reading the new field." A migration that isn't naturally reversible this way should be split into an additive step plus a separate later contract step. Every migration filters its update query on "field not already set," so it's idempotent independent of the `schema_migrations` bookkeeping. Register new migrations in `server/migrations/index.js`, in numeric order — the runner stops at the first failure rather than skipping ahead.

### Client structure

- `src/app/App.jsx` — root component: auth/session state, tab routing (`home`/`aggiungi`/`portfolio`/`viaggi`/`stats`/`export`/`impostazioni`), deep-link query params (`?action=add&tipo=...`) used by the Shortcuts/widget integration.
- `src/features/<name>/` — one directory per feature (transactions, trips ["Viaggi"], portfolio, goals, debts, accounts, auth, settings, statistics). UI text is Italian-first (`nome`, `importo`, `uscita`/`entrata`/`saldo`); `src/lib/i18n.js` provides `t()`/`mese()` for the actual i18n layer — don't assume Italian identifiers mean the UI is untranslated.
- `src/services/*.js` — pure business logic per domain (debt-splitting math, goal auto-contributions, recurring-transaction generation, portfolio valuation), each with a co-located `.test.js`.
- `src/lib/finance.js` — debt-matrix / minimal-settlement algorithm and per-person share calculations shared across Home, Stats, and Trips.

### Transaction types

Three `tipo` values matter across balance/debt/stats calculations: `"uscita"` (expense), `"entrata"` (income), `"saldo"` (a debt settlement payment — **not** income; every place that sums income filters `tipo === "entrata"` specifically, and debt-matrix calculations exclude `saldo` transactions from the current month to avoid fabricating reversed debts). Recurring transactions carry a "variable amount" flag (`importoVariabile`) that flags the freshly-renewed copy for the user to double check rather than silently repeating a stale amount.

### Trips ("Viaggi")

Group expenses for participants outside the household (temporary guests, no login). Has its own share-link flow (`/api/trips/:id/share`, `/api/trips/shared/:token`) separate from the household auth model — guests join and add expenses via the shared token, not a household PIN. A trip auto-settles and closes once its end date passes (minimal-settlement transaction recorded automatically).

### Content Security Policy

The real CSP lives in `vercel.json`'s `headers` block (not in `server/index.js` — the Express API never serves the HTML document, see the comment above `helmet(...)` there). It's intentionally strict: `script-src 'self'` with no `'unsafe-inline'`/`'unsafe-eval'` (the production Vite build has no inline `<script>`s), `style-src` allows `'unsafe-inline'` only for the one inline `<style>` block in `index.html` plus `fonts.googleapis.com`, `img-src` allows `data:` for the inline SVG chevron background and the receipt-scanner's base64 photo preview. `script-src` also carries `'wasm-unsafe-eval'` (and nothing broader) because receipt OCR runs Tesseract's WebAssembly core in a web worker; the worker, the WASM cores and the `ita`/`eng` language models are served same-origin under `/tesseract/` by the `tesseract-assets` plugin in `vite.config.js` (copied from `node_modules`), since tesseract.js's default jsdelivr CDN paths and `blob:` worker are blocked by this policy. Keep `OCR_PATHS` in `src/features/transactions/receiptOcr.js` and that plugin in sync. Adding a new external script/font/API domain, or a new inline `<script>`, means updating this policy too — it won't fail loudly, it'll just silently block the new resource in production. Verify a change with `npm run build` + serving `dist/` behind the same header (a plain static server with the header attached) and checking the browser console for `Refused to`/CSP violation messages before shipping.

### External integrations

- **Widget** (`/api/widget`, `/api/widget/transaction`): a separate API-key-based auth path (not the JWT cookie), meant for a home-screen Scriptable widget. Treat the widget key like a password.
- **Calendar** (`/api/calendar-key`, `/api/calendar.ics`): similar API-key pattern for exposing recurring bills as an ICS feed.
- **Capacitor** (`@capacitor/*` deps) is present for wrapping the PWA as a native iOS shell; `ios/`/`android/` are gitignored (not committed, generated on demand).
