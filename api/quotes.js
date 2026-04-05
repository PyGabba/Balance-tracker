// api/quotes.js
export default async function handler(req, res) {
  // ✅ Dynamic import per compatibilità ESM/CommonJS
  const yahooFinance = await import('yahoo-finance2').then(m => m.default || m);
  
  const { symbols, refresh } = req.query;
  const symbolList = symbols?.split(',') || [];

  if (symbolList.length === 0) {
    return res.status(400).json({ error: 'Nessun simbolo fornito' });
  }

  try {
    const quotes = {};

    // Fetch con gestione errori per singolo ticker
    const results = await Promise.allSettled(
      symbolList.map(async (symbol) => {
        try {
          const q = await yahooFinance.quote(symbol);
          return { symbol, data: q };
        } catch (err) {
          console.warn(`⚠️ ${symbol}: ${err.message}`);
          return { symbol, error: true };
        }
      })
    );

    results.forEach((r) => {
      if (r.status === 'fulfilled' && r.value.data) {
        const q = r.value.data;
        quotes[r.value.symbol] = {
          prezzo: q.regularMarketPrice,
          cambioPct: q.regularMarketChangePercent,
        };
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
