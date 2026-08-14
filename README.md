<p align="center">
  <img src="public/icon-192.png" width="80" alt="Finanza Tracker" />
</p>

<h1 align="center">Finanza Tracker</h1>

<p align="center">
  <strong>Shared expense & finance tracker for households</strong><br/>
  Track spending, split costs, settle debts, plan trips and recurring bills — from your phone.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/React-18-blue?logo=react" alt="React 18" />
  <img src="https://img.shields.io/badge/Vite-6-purple?logo=vite" alt="Vite 6" />
  <img src="https://img.shields.io/badge/Express-4-green?logo=express" alt="Express" />
  <img src="https://img.shields.io/badge/MongoDB-7-green?logo=mongodb" alt="MongoDB" />
  <img src="https://img.shields.io/badge/PWA-installable-orange" alt="PWA" />
</p>

---

## Overview

Finanza Tracker is a full-stack finance app for households that share money — couples, roommates, families. Each household is a self-service, PIN-protected account: register once, invite no one, and everyone with the PIN sees the same shared ledger.

Beyond basic expense tracking it covers the situations that usually need a spreadsheet: multi-way cost splitting, recurring bills that renew themselves, one-off group trips with temporary guests, savings goals, a stock/crypto portfolio, and multiple bank accounts with transfers between them.

The UI is in Italian; this document is in English.

---

## Feature summary

| Feature | Description |
|---|---|
| **Self-service households** | Register with a name, participants, and a 6–8 digit PIN — no admin setup |
| **Expense & income tracking** | Category, description, date, per-transaction notes |
| **Cost splitting** | 50/50, 70/30, or a custom percentage per person; ad-hoc guests via "extra people" |
| **Debt balance** | Running total of who owes whom, computed with a minimal-transfer algorithm, with one-tap settle |
| **Recurring transactions** | Weekly / monthly / quarterly / yearly bills that regenerate automatically, with a "variable amount" flag that prompts you to double check the value after each renewal (e.g. utility bills) |
| **Trash / soft delete** | Deleted transactions sit in a 30-day recovery bin before being purged for good |
| **Multiple accounts & transfers** | Track balances per bank account/wallet and move money between them |
| **Trips (Viaggi)** | Group expense tracking for events with temporary guests who aren't part of the household; auto-settles and closes once the trip's end date passes |
| **Savings goals** | Target amount/date per goal, with manual, percentage-of-income, or fixed automatic contributions |
| **Portfolio** | Stock/crypto holdings with live quotes and manual price overrides |
| **Receipt scanner** | Photograph a receipt to pre-fill amount, description, and category (on-device OCR) |
| **Statistics** | Category breakdown, monthly trend, spending heatmap, histogram |
| **Export** | XLSX/CSV export with custom date range and column selection |
| **Full backup & restore** | Download the entire household's data as JSON, restore it later |
| **Home screen widget** | Optional API key for a Scriptable widget showing balances and quick-adding transactions |
| **Offline-first** | Every write lands in `localStorage` immediately; syncs to the server in the background |
| **PWA** | Installable on Android & iOS, works offline |

---

## Using the app

### Getting in

The first screen is **Login**. Registering creates a new household: give it a name, add each participant (name + optional emoji/color), and set a 6–8 digit PIN — this PIN is the only credential, shared by everyone in the household. Returning users just enter the PIN; the app caches a hash locally so subsequent logins are instant even before the server responds. If the PIN is forgotten, a reset link can be emailed to a recovery address configured in Settings.

### Bottom navigation

| Icon | Screen | Purpose |
|---|---|---|
| ⌂ | **Home** | Balance for the month, debt summary, transaction list, savings goals |
| + | **Aggiungi** | Add a new transaction |
| 📈 | **Portfolio** | Stock/crypto holdings and live quotes |
| ✈ | **Viaggi** | Group trips with temporary guests |
| ◔ | **Statistiche** | Charts and spending breakdowns |
| ↓ | **Esporta** | XLSX/CSV export |

**Settings** (⚙, top-right of the header) holds everything account-level: categories, connected accounts, the trash bin, the home-screen widget key, backup/restore, recovery email, and account deletion.

### Home

Shows the selected month's balance (income − expenses), who owes whom right now (settle with one tap), any recurring transactions that just renewed, any renewed transactions flagged for an amount check, and the transaction list with search and filters (type, category, person, account, amount range). Tap any transaction to expand it inline and edit or delete it.

### Adding a transaction

From the **Aggiungi** tab, choose the type — **Uscita** (expense), **Entrata** (income), or **Trasferimento** (transfer between two of your own accounts, if you have 2+). For expenses, pick who paid and how the cost is split: an even split, a preset (70/30), a custom slider, or add extra people outside the household for a one-off split. Optionally photograph a receipt first to auto-fill the amount, description, and category.

To make a transaction recurring, set **Ripeti** to weekly/monthly/quarterly/yearly. If the amount tends to change each cycle (a variable utility bill, for example), check **"Importo variabile"** — the renewed copy will be flagged so you're reminded to verify and correct the amount instead of it silently repeating the wrong value. Recurring transactions renew automatically both when the app is opened and via a background job on the server, so bills don't get missed even if you don't open the app that day.

### Debts & settling

Balances are computed across the whole household, not just pairwise, using a greedy algorithm that finds the minimum number of payments needed to settle everyone up. Tap **Salda** to record a settlement payment between two people.

### Trash

Deleting a transaction from Home doesn't erase it immediately — it moves to the **Cestino** in Settings, where it can be restored or permanently deleted. Anything left untouched for 30 days is purged automatically.

### Viaggi (trips)

Use this for one-off group spending that shouldn't affect the household's regular splits — a weekend away, a dinner with friends. Create a trip, add participants (they don't need to be household members), log expenses with their own splits, and either settle it manually when it's done or let it auto-close: once the trip's end date passes, the app computes the minimal settlement automatically and records it as a transaction, marking the trip closed.

### Savings goals

On Home, set a name, target amount, and optional target date for a goal. Contributions can be tracked manually, or automated as a percentage or fixed amount deducted from every income transaction.

### Portfolio

Add stock or crypto positions by ticker; quotes refresh from a live source and cache for 24 hours, or set a manual price for anything not covered.

### Statistics & export

**Statistiche** breaks down spending by category, over time, and by size (histogram/heatmap) for the selected month or a custom range. **Esporta** produces an XLSX or CSV file with a chosen date range and columns.

### Settings

- **Categorie** — add, rename, recolor, or remove expense categories.
- **Conti** — manage bank accounts/wallets used for transfers and balances.
- **Cestino** — restore or permanently delete trashed transactions.
- **Widget** — generate an API key for a home-screen widget (via the Scriptable app) that shows balances and can quick-add transactions. Treat the key like a password.
- **Backup** — download the full household dataset as JSON, or restore from a previous backup.
- **Email di recupero** — set a recovery email so a forgotten PIN can be reset.
- **Zona pericolosa** — permanently delete the household and all its data (PIN-confirmed, irreversible).

---

## Architecture

```
┌─────────────────┐         ┌──────────────────┐         ┌───────────┐
│   React SPA     │  REST   │   Express API    │         │  MongoDB  │
│   Vite + PWA    │────────▶│   Node.js        │────────▶│  Atlas    │
│   Vercel        │         │   Render         │         │           │
└─────────────────┘         └──────────────────┘         └───────────┘
        │                                                       │
        └──── localStorage fallback (if API unreachable) ───────┘
```

The frontend auto-detects whether the backend is reachable. If it isn't, it falls back to `localStorage` scoped by household — no data is lost, and it syncs back once the connection returns.

The backend also runs a few background jobs on an interval (checked every 6 hours, and once at boot): generating due recurring transactions, purging trash older than 30 days, and auto-closing/settling trips past their end date.

---

## Local development

```bash
# from the repo root
npm install
cd server && npm install && cd ..

# frontend + backend together
npm run dev
```

| Command | Description |
|---|---|
| `npm run dev` | Start frontend + backend concurrently |
| `npm run dev:client` | Frontend only (Vite) |
| `npm run dev:server` | Backend only (Node `--watch`) |
| `npm run build` | Build frontend for production |
| `npm start` | Start backend (production) |
| `cd server && node migrate-household.js` | One-off migration script for legacy transactions missing a `householdId` |

### Environment variables

Frontend (`.env`):

| Variable | Description | Default |
|---|---|---|
| `VITE_API_URL` | Backend base URL | `http://localhost:3001` |

Backend (`server/.env`):

| Variable | Description | Default |
|---|---|---|
| `MONGODB_URI` | MongoDB connection string | `mongodb://localhost:27017` |
| `DB_NAME` | Database name | `finanza_tracker` |
| `PORT` | Server port | `3001` |
| `JWT_SECRET` | Secret for signing session tokens | required in production |

Households are **not** configured in code — they're created at runtime via the in-app registration screen.

---

## Deployment

Frontend on Vercel, backend on Render, database on MongoDB Atlas. Any Node-compatible host works for the backend as long as the environment variables above are set and the Mongo instance is reachable.

---

## License

Private project. All rights reserved.
