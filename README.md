# 💰 Finanza Tracker

App PWA per spese personali con scansione scontrini AI, divisione spese Laura/Gabriele, e backend MongoDB.

## Architettura

```
┌──────────────┐     ┌──────────────────┐     ┌───────────┐
│  React PWA   │────▶│  Express API     │────▶│  MongoDB  │
│  (Vite)      │     │  (Node.js)       │     │           │
│  :5173       │     │  :3001           │     │  :27017   │
└──────────────┘     └──────────────────┘     └───────────┘
       │
       └── localStorage fallback (se DB offline)
```

## Setup rapido

```bash
# 1. Installa tutto
npm install
cd server && npm install && cd ..

# 2. Avvia MongoDB (una delle opzioni)
docker run -d -p 27017:27017 --name finanza-mongo mongo:7

# 3. Configura environment
cp .env.example .env
cp server/.env.example server/.env

# 4. Avvia frontend + backend
npm run dev
```

Frontend: `http://localhost:5173` — Backend: `http://localhost:3001`

## MongoDB Atlas (cloud gratuito)

1. Crea cluster su [mongodb.com/atlas](https://www.mongodb.com/atlas)
2. Copia la connection string in `server/.env`:
   ```
   MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net
   ```

## API Endpoints

| Metodo | Endpoint | Descrizione |
|--------|----------|-------------|
| GET | `/api/transactions` | Lista (filtri: tipo, categoria, pagatoDa, meseAnno) |
| POST | `/api/transactions` | Crea transazione |
| PUT | `/api/transactions/:id` | Aggiorna |
| DELETE | `/api/transactions/:id` | Elimina |
| GET | `/api/stats/debiti` | Saldo debiti Laura ↔ Gabriele |
| GET | `/api/health` | Health check |

## Deploy

**Frontend** → Vercel: `npx vercel` (env: `VITE_API_URL`, `VITE_ANTHROPIC_API_KEY`)

**Backend** → Railway / Render / Fly.io con MongoDB addon

## Indicatore connessione

🟢 Verde = MongoDB connesso — 🟡 Giallo = localStorage offline
