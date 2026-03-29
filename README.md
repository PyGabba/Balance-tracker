# 💰 Finanza Tracker

App PWA per il tracciamento di spese e finanze personali con scansione scontrini AI.

## Funzionalità

- ✅ Aggiungere spese e entrate
- ✅ 8 categorie con emoji (Cibo, Trasporti, Casa, Salute, Svago, Shopping, Bollette, Altro)
- ✅ Grafici: ciambella per categoria + trend 6 mesi
- ✅ Scansione scontrini con AI (Claude) + OCR fallback (Tesseract.js)
- ✅ Dark mode
- ✅ PWA installabile su Android/iOS
- ✅ Funziona offline
- ✅ Dati salvati in localStorage

## Setup rapido

### 1. Installa dipendenze

```bash
npm install
```

### 2. Configura API key (opzionale, per scansione AI)

```bash
cp .env.example .env
```

Modifica `.env` e inserisci la tua API key Anthropic:
```
VITE_ANTHROPIC_API_KEY=sk-ant-la-tua-chiave
```

> Senza API key, la scansione scontrini usa Tesseract.js (OCR nel browser).
> Con API key, Claude analizza lo scontrino estraendo importo, categoria e descrizione.

### 3. Avvia in sviluppo

```bash
npm run dev
```

Apri `http://localhost:5173` nel browser.

### 4. Genera le icone PWA

Crea due immagini PNG nella cartella `public/`:
- `icon-192.png` (192×192 px)
- `icon-512.png` (512×512 px)

Puoi usare un generatore online come [favicon.io](https://favicon.io) o creare un semplice logo.

## Deploy su Vercel (gratuito)

### Opzione A: CLI

```bash
npm install -g vercel
vercel
```

Segui le istruzioni. Aggiungi la variabile d'ambiente `VITE_ANTHROPIC_API_KEY` nelle impostazioni del progetto su Vercel.

### Opzione B: GitHub

1. Pusha il progetto su GitHub
2. Vai su [vercel.com](https://vercel.com) → Import Project
3. Seleziona il repo
4. Nelle Environment Variables aggiungi `VITE_ANTHROPIC_API_KEY`
5. Deploy!

## Installare come app sul telefono

Dopo il deploy:

### Android
1. Apri il sito in Chrome
2. Tocca ⋮ → "Aggiungi a schermata Home"
3. L'app apparirà come app nativa

### iOS
1. Apri il sito in Safari
2. Tocca condividi → "Aggiungi a Home"
3. L'app apparirà come app nativa

## Struttura del progetto

```
finanza-tracker/
├── public/
│   ├── icon-192.png      ← Crea tu (192×192)
│   └── icon-512.png      ← Crea tu (512×512)
├── src/
│   ├── App.jsx           ← Componente principale
│   └── main.jsx          ← Entry point React
├── .env.example           ← Template per API key
├── index.html             ← HTML con meta PWA
├── package.json
├── vite.config.js         ← Vite + PWA plugin
└── README.md
```

## Note tecniche

- **Storage**: localStorage (persistente, nessun backend necessario)
- **Scansione**: Claude API (priorità) → Tesseract.js OCR (fallback) → inserimento manuale
- **PWA**: Service worker per offline, manifest per installazione
- **Framework**: React 18 + Vite 6
- **CORS API**: L'header `anthropic-dangerous-direct-browser-access` abilita le chiamate dirette dal browser. Per produzione, considera un proxy backend.

## Sicurezza: nota sull'API key

L'API key è esposta nel frontend (`VITE_` prefix). Per un'app in produzione:
1. Crea un piccolo backend/serverless function (es. Vercel Edge Function)
2. Il frontend chiama il tuo backend, che chiama Claude
3. L'API key resta lato server

Per uso personale è accettabile tenerla nel frontend.
