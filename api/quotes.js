// api/quotes.js
// Yahoo Finance API has been removed.
// Manual prices are now the only supported option for portfolio valuation.

// This endpoint returns an error indicating the API is disabled.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-household-id');

  if (req.method === 'OPTIONS') return res.status(200).end();

  return res.status(410).json({ error: 'API quotazioni Yahoo rimossa. Usa i prezzi manuali.' });
}
