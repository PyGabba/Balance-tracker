import { COLORI_EXTRA } from "../../lib/appHelpers.js";

// ─── Splitwise CSV parser ───
// Splitwise format: Data, Descrizione, Categorie, Costo, Valuta, <one column per person>
// Each person column holds the NET balance: positive = paid more than their share.
export function parseSplitwiseRows(rawRows, persone) {
  const righe = [];
  const errori = [];
  const extraMap = {};
  let extraCount = 0;

  const metaCols = ["Data", "Date", "Descrizione", "Description", "Categorie", "Categories", "Costo", "Cost", "Valuta", "Currency"];
  const first = rawRows.find(r => Object.keys(r).length > 0) || {};
  const nameCols = Object.keys(first).filter(k => !metaCols.includes(k.trim()) && k.trim() !== "");

  // Splitwise category → app category (nome). Adjust to taste.
  const CAT_MAP = {
    "ristorante": "Cibo",
    "alimentari": "Cibo",
    "trasporti": "Trasporti",
    "trasporti - altro": "Trasporti",
    "casa": "Casa",
    "generali": "Altro",
  };

  function resolvePersona(nome) {
    const p = persone.find(x => x.nome.toLowerCase() === nome.toLowerCase());
    if (p) return p.id;
    const id = nome.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "") || `extra${extraCount}`;
    if (!extraMap[id]) {
      extraMap[id] = { id, nome, emoji: "👤", colore: COLORI_EXTRA[extraCount % COLORI_EXTRA.length] };
      extraCount++;
    }
    return id;
  }

  // Excel stores dates as serial numbers (days since 1899-12-30).
  // Splitwise timestamps are near midnight, so round to the nearest day.
  function excelSerialToISO(v) {
    const n = parseFloat(v);
    if (isNaN(n) || n < 20000 || n > 60000) return null;
    return new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000).toISOString().slice(0, 10);
  }

  rawRows.forEach((row, i) => {
    const num = i + 2;
    let data = String(row["Data"] || row["Date"] || "").trim();
    if (/^\d+(\.\d+)?$/.test(data)) data = excelSerialToISO(data) || data;
    const descrizione = String(row["Descrizione"] || row["Description"] || "").trim();

    // Skip blank rows and the final "Bilancio totale" summary row
    if (!data && !descrizione) return;
    const descLow = descrizione.toLowerCase();
    if (descLow.includes("bilancio totale") || descLow.includes("total balance")) return;

    if (!data.match(/^\d{4}-\d{2}-\d{2}$/)) {
      errori.push(`Riga ${num}: data non valida ("${data}") — formato atteso YYYY-MM-DD`);
      return;
    }

    const costo = parseFloat(String(row["Costo"] ?? row["Cost"] ?? "").replace(",", "."));
    if (isNaN(costo) || costo <= 0) {
      errori.push(`Riga ${num}: costo non valido ("${row["Costo"]}")`);
      return;
    }

    // Net balance per person for this expense
    const nets = nameCols.map(n => ({
      nome: n.trim(),
      net: parseFloat(String(row[n] ?? "0").replace(",", ".")) || 0,
    }));

    // All zeros → expense fully self-paid: nothing to split, skip
    if (nets.every(x => Math.abs(x.net) < 0.005)) return;

    // Payer = person with the largest positive net (Splitwise single-payer rows)
    const payer = nets.reduce((a, b) => (b.net > a.net ? b : a));
    if (payer.net <= 0) {
      errori.push(`Riga ${num}: nessun pagante rilevato ("${descrizione}")`);
      return;
    }

    // Actual share of each participant:
    //   payer's share  = costo − suo net
    //   others' share  = −(loro net)   (persone a 0 sono escluse dalla spesa)
    const shares = nets
      .map(x => ({
        nome: x.nome,
        share: x.nome === payer.nome ? costo - x.net : Math.max(0, -x.net),
      }))
      .filter(x => x.share > 0.005);

    const splits = shares.map(x => ({
      personaId: resolvePersona(x.nome),
      quota: Math.round((x.share / costo) * 10000) / 100,
    }));

    // Fix rounding so quotas sum to exactly 100
    const totQ = splits.reduce((s, x) => s + x.quota, 0);
    if (splits.length && Math.abs(totQ - 100) > 0.001) {
      const last = splits[splits.length - 1];
      last.quota = Math.round((last.quota + 100 - totQ) * 100) / 100;
    }

    const catRaw = String(row["Categorie"] || row["Categories"] || "").trim().toLowerCase();
    const categoria = CAT_MAP[catRaw] || "Altro";

    righe.push({
      data,
      tipo: "uscita",
      importo: costo,
      categoria,
      descrizione,
      pagatoDa: resolvePersona(payer.nome),
      ricevutoDa: null,
      splits,
      extraPersone: null, // filled after the loop
    });
  });

  const extraList = Object.values(extraMap);
  if (extraList.length > 0) righe.forEach(r => { r.extraPersone = extraList; });

  return { righe, errori };
}
