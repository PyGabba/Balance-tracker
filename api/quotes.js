import yahooFinance from 'yahoo-finance2';

export default async function handler(req, res) {
  const { symbols, refresh } = req.query;
  const symbolList = symbols?.split(',') || [];

  try {
    const quotes = {};

    // Fetch all quotes in parallel
    const results = await Promise.all(
      symbolList.map(symbol =>
        yahooFinance.quote(symbol)
      )
    );

    results.forEach((q) => {
      quotes[q.symbol] = {
        prezzo: q.regularMarketPrice,
        cambioPct: q.regularMarketChangePercent,
      };
    });

    res.status(200).json({
      quotes,
      cached: !refresh,
      aggiornamento: new Date().toISOString().slice(0, 10),
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Errore nel fetch dei dati' });
  }
}
