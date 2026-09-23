// api/quotes.js
// Superseded by GET /api/quotes on the Express API (server/index.js), which
// vercel.json's /api/:path* rewrite already routes every request to — this
// file's route is shadowed in production and unreachable there. Kept only
// so a deployment that skips the rewrite gets a clear pointer instead of a
// bare 404.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-household-id');

  if (req.method === 'OPTIONS') return res.status(200).end();

  return res.status(404).json({ error: 'Usa /api/quotes sul backend Express (vedi vercel.json rewrites).' });
}
