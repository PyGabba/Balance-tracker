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

## License

Private project. All rights reserved.
