<p align="center">
  <img src="public/icon-192.png" width="80" alt="Finanza Tracker" />
</p>

<h1 align="center">Finanza Tracker</h1>

<p align="center">
  <strong>Shared expense tracker for couples</strong><br/>
  Track spending, split costs, settle debts — all from your phone.
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

Finanza Tracker is a full-stack personal finance app built for couples who share expenses. Each household gets a private, PIN-protected space to track income and spending, assign who paid, split costs with custom percentages, and settle debts.

### Key Features

| Feature | Description |
|---------|-------------|
| **Multi-household login** | PIN-based access — each couple sees only their data |
| **Expense & income tracking** | Add transactions with category, description, date |
| **Split costs** | Assign who paid, choose split % (50/50, 70/30, custom slider) |
| **Debt balance** | Real-time balance showing who owes whom, with one-tap settle |
| **Income owner** | Assign income to a specific person |
| **Edit in place** | Tap any transaction to edit all fields inline |
| **Receipt scanner** | AI-powered (Claude API) or OCR (Tesseract.js) receipt reading |
| **Statistics** | Donut chart, trend bars, heatmap, histogram, frequency analysis |
| **Trends & Insights** | Month-over-month comparison, saving rate gauge, smart tips |
| **Export to XLSX** | Custom date range, column picker, sort order |
| **Dark mode** | Full dark UI optimized for OLED |
| **PWA** | Installable on Android & iOS, works offline with localStorage fallback |

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

The frontend auto-detects if the backend is available. If not, it falls back to `localStorage` scoped by household — no data is lost.

---

## Quick Start

### Prerequisites

- Node.js 18+
- MongoDB (local, Docker, or [Atlas free tier](https://www.mongodb.com/atlas))

### 1. Clone & install

```bash
git clone https://github.com/YOUR_USERNAME/finanza-tracker.git
cd finanza-tracker

# Frontend
npm install

# Backend
cd server && npm install && cd ..
```

### 2. Configure environment

```bash
# Frontend
cp .env.example .env

# Backend
cp server/.env.example server/.env
```

Edit `server/.env`:

```env
MONGODB_URI=mongodb://localhost:27017   # or your Atlas connection string
DB_NAME=finanza_tracker
PORT=3001
PIN_LAURA_GABRIELE=1234                 # change this
PIN_GIANMARCO_GIULIA=5678              # change this
```

Edit `.env` (optional, for AI receipt scanning):

```env
VITE_API_URL=http://localhost:3001
VITE_ANTHROPIC_API_KEY=sk-ant-...       # optional
```

### 3. Start MongoDB

```bash
# Docker (easiest)
docker run -d -p 27017:27017 --name finanza-mongo mongo:7

# Or use MongoDB Atlas — no local install needed
```

### 4. Run

```bash
npm run dev
```

This starts both frontend (`:5173`) and backend (`:3001`) concurrently.

---

## Deployment

### Frontend → Vercel

```bash
npx vercel
```

Environment variables on Vercel dashboard:

| Variable | Value |
|----------|-------|
| `VITE_API_URL` | `https://your-api.onrender.com` |
| `VITE_ANTHROPIC_API_KEY` | `sk-ant-...` (optional) |

### Backend → Render

1. Create a **Web Service** on [render.com](https://render.com)
2. Connect your GitHub repository
3. Configure:

| Setting | Value |
|---------|-------|
| **Root Directory** | `server` |
| **Build Command** | `npm install` |
| **Start Command** | `npm start` |

4. Add environment variables:

| Variable | Value |
|----------|-------|
| `MONGODB_URI` | `mongodb+srv://...` (Atlas connection string) |
| `DB_NAME` | `finanza_tracker` |
| `PIN_LAURA_GABRIELE` | your PIN |
| `PIN_GIANMARCO_GIULIA` | your PIN |

### Database → MongoDB Atlas

1. Create free M0 cluster at [mongodb.com/atlas](https://www.mongodb.com/atlas)
2. Create database user, whitelist `0.0.0.0/0`
3. Copy connection string to `MONGODB_URI`

---

## API Reference

All transaction endpoints require the `x-household-id` header.

### Authentication

```
POST /api/auth/login          — Verify PIN, returns household info + persone
GET  /api/auth/households     — List households (no PINs exposed)
```

### Transactions

```
GET    /api/transactions      — List all (filters: tipo, categoria, pagatoDa, meseAnno, limit)
POST   /api/transactions      — Create
PUT    /api/transactions/:id  — Update
DELETE /api/transactions/:id  — Delete
```

### Statistics

```
GET /api/stats/summary        — Aggregated totals by tipo/categoria/persona
GET /api/stats/debiti         — Debt balance between the two persons
GET /api/health               — Health check
```

### Example: Create a transaction

```bash
curl -X POST https://your-api.onrender.com/api/transactions \
  -H "Content-Type: application/json" \
  -H "x-household-id: laura-gabriele" \
  -d '{
    "tipo": "uscita",
    "importo": 57.97,
    "categoria": "shopping",
    "descrizione": "Decathlon",
    "data": "2026-03-29",
    "pagatoDa": "gabriele",
    "splitPagante": 50
  }'
```

---

## Project Structure

```
finanza-tracker/
├── public/
│   ├── icon-192.png            PWA icon
│   ├── icon-512.png            PWA icon
│   └── manifest.json           PWA manifest
├── server/
│   ├── index.js                Express API + MongoDB + household auth
│   ├── keep-alive.js           Ping to prevent Render sleep
│   ├── migrate-household.js    One-time migration script
│   ├── package.json
│   └── .env.example
├── src/
│   ├── api.js                  API client (MongoDB + localStorage fallback)
│   ├── App.jsx                 Full React application
│   └── main.jsx                React entry point
├── .env.example                Frontend env template
├── index.html                  HTML entry with PWA meta tags
├── package.json                Frontend deps + scripts
├── vercel.json                 Vercel build config
└── vite.config.js              Vite config
```

---

## Data Model

### Transaction document (MongoDB)

```json
{
  "_id": "ObjectId",
  "householdId": "laura-gabriele",
  "tipo": "uscita",
  "importo": 57.97,
  "categoria": "shopping",
  "descrizione": "Decathlon",
  "data": "2026-03-29",
  "pagatoDa": "gabriele",
  "splitPagante": 50,
  "intestataA": null,
  "daScontrino": false,
  "createdAt": "ISODate"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `householdId` | string | Tenant isolation key |
| `tipo` | `"uscita"` \| `"entrata"` | Transaction type |
| `importo` | number | Amount in EUR |
| `categoria` | string | One of: cibo, trasporti, casa, salute, svago, shopping, bollette, altro, entrata |
| `pagatoDa` | string \| null | Who paid (expenses only) |
| `splitPagante` | number \| null | Payer's share % (0–100) |
| `intestataA` | string \| null | Income owner (income only) |
| `daScontrino` | boolean | Created via receipt scan |

---

## Households Configuration

Households are defined in `server/index.js`. To add a new couple:

```javascript
{
  id: "marco-anna",
  nome: "Marco & Anna",
  pin: process.env.PIN_MARCO_ANNA || "9999",
  persone: [
    { id: "marco", nome: "Marco", emoji: "👨", colore: "#E17055" },
    { id: "anna", nome: "Anna", emoji: "👩", colore: "#74B9FF" },
  ],
}
```

Then add `PIN_MARCO_ANNA=9999` to the server environment variables.

---

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start frontend + backend concurrently |
| `npm run dev:client` | Frontend only (Vite) |
| `npm run dev:server` | Backend only (Node --watch) |
| `npm run build` | Build frontend for production |
| `npm start` | Start backend (production) |
| `cd server && node migrate-household.js` | Assign householdId to old transactions |

---

## Costs

| Service | Plan | Cost |
|---------|------|------|
| Vercel | Hobby | Free |
| Render | Free | Free (sleeps after 15 min) |
| MongoDB Atlas | M0 | Free (512 MB) |
| **Total** | | **€0/month** |

> The `keep-alive.js` script pings the Render service every 5 minutes to prevent sleeping.

---

## License

Private project. All rights reserved.
