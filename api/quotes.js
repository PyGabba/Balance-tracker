// api/quotes.js - SENZA dipendenze esterne (funziona su Vercel)
export default async function handler(req, res) {
  // ✅ CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-household-id');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { symbols, refresh } = req.query;
  const symbolList = (symbols || '').split(',').map(s => s.trim()).filter(Boolean);

  if (symbolList.length === 0) {
    return res.status(400).json({ error: 'Nessun simbolo fornito' });
  }

  try {
    const quotes = {};

    // Fetch parallelo con gestione errori per singolo ticker
    const results = await Promise.allSettled(
      symbolList.map(async (symbol) => {
        try {
          // Yahoo Finance public endpoint (CORS-enabled)
          const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`;
          
          const r = await fetch(url, {
            headers: { 
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' 
            },
            signal: AbortSignal.timeout(5000) // 5s timeout
          });
          
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          
          const data = await r.json();
          const meta = data.chart?.result?.[0]?.meta;
          
          if (meta?.regularMarketPrice != null) {
            return { 
              symbol, 
              data: {
                prezzo: meta.regularMarketPrice,
                cambioPct: meta.regularMarketChangePercent,
                currency: meta.currency || 'USD'
              } 
            };
          }
          throw new Error('Dati non disponibili');
        } catch (err) {
          console.warn(`⚠️ ${symbol}: ${err.message}`);
          return { symbol, error: true };
        }
      })
    );

    // Costruisci quotes solo per risultati validi
    results.forEach((r) => {
      if (r.status === 'fulfilled' && r.value?.data) {
        quotes[r.value.symbol] = r.value.data;
      }
    });

    return res.status(200).json({
      quotes,
      cached: !refresh,
      aggiornamento: new Date().toISOString().slice(0, 10),
    });

  } catch (error) {
    console.error('❌ quotes API error:', error);
    return res.status(500).json({ error: 'Errore nel fetch dei dati' });
  }
}
