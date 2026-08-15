import { describe, it, expect } from "vitest";
import { calcolaDebitiMatrix, calcolaSaldiConti, calcolaValorePortfolio, calcolaSettleViaggio, filtraTransazioni, contaFiltriAttivi, forecastNextMonthExpenses } from "./finance.js";

const persone = [
  { id: "g", nome: "Gabriele" },
  { id: "l", nome: "Laura" },
];

describe("calcolaDebitiMatrix", () => {
  it("split 50/50: chi non paga deve metà", () => {
    const debiti = calcolaDebitiMatrix([
      { tipo: "uscita", importo: 100, pagatoDa: "g", splits: [{ personaId: "g", quota: 50 }, { personaId: "l", quota: 50 }] },
    ], persone);
    expect(debiti).toEqual([{ da: "l", a: "g", importo: 50 }]);
  });

  it("un saldo azzera il debito corrispondente", () => {
    const debiti = calcolaDebitiMatrix([
      { tipo: "uscita", importo: 100, pagatoDa: "g", splits: [{ personaId: "g", quota: 50 }, { personaId: "l", quota: 50 }] },
      { tipo: "saldo", importo: 50, pagatoDa: "l", ricevutoDa: "g" },
    ], persone);
    expect(debiti).toEqual([]);
  });

  it("i saldi_viaggio sono record-only e ignorati", () => {
    const debiti = calcolaDebitiMatrix([
      { tipo: "saldo", importo: 3216.92, pagatoDa: "l", ricevutoDa: "g", categoria: "saldo_viaggio" },
    ], persone);
    expect(debiti).toEqual([]);
  });

  it("debiti incrociati vengono compensati (netting)", () => {
    const debiti = calcolaDebitiMatrix([
      { tipo: "uscita", importo: 100, pagatoDa: "g", splits: [{ personaId: "g", quota: 50 }, { personaId: "l", quota: 50 }] },
      { tipo: "uscita", importo: 60, pagatoDa: "l", splits: [{ personaId: "g", quota: 50 }, { personaId: "l", quota: 50 }] },
    ], persone);
    expect(debiti).toEqual([{ da: "l", a: "g", importo: 20 }]);
  });

  it("vecchio formato splitPagante retro-compatibile", () => {
    const debiti = calcolaDebitiMatrix([
      { tipo: "uscita", importo: 100, pagatoDa: "g", splitPagante: 30 },
    ], persone);
    expect(debiti).toEqual([{ da: "l", a: "g", importo: 70 }]);
  });
});

describe("calcolaSaldiConti", () => {
  const conti = [{ id: "b", saldoIniziale: 1000 }, { id: "c", saldoIniziale: 50 }];

  it("entrate e uscite muovono il conto assegnato", () => {
    const s = calcolaSaldiConti(conti, [
      { tipo: "entrata", importo: 100, contoId: "b" },
      { tipo: "uscita", importo: 30, contoId: "c" },
    ]);
    expect(s.b).toBe(1100);
    expect(s.c).toBe(20);
  });

  it("il giroconto sposta senza cambiare il totale", () => {
    const s = calcolaSaldiConti(conti, [
      { tipo: "trasferimento", importo: 200, contoDa: "b", contoA: "c" },
    ]);
    expect(s.b).toBe(800);
    expect(s.c).toBe(250);
    expect(s.b + s.c).toBe(1050);
  });

  it("saldi tra persone e conti orfani sono ignorati", () => {
    const s = calcolaSaldiConti(conti, [
      { tipo: "saldo", importo: 999, pagatoDa: "x", ricevutoDa: "y" },
      { tipo: "uscita", importo: 10, contoId: "eliminato" },
      { tipo: "trasferimento", importo: 10, contoDa: "eliminato", contoA: "b" },
    ]);
    expect(s.b).toBe(1010); // solo il lato esistente del trasferimento
    expect(s.c).toBe(50);
  });
});

describe("calcolaValorePortfolio", () => {
  it("vendita parziale: costo medio invariato, valore su prezzo manuale", () => {
    const { valore, investito } = calcolaValorePortfolio([
      { ticker: "A", tipo: "buy", quantita: 10, prezzoAcquisto: 100, dataAcquisto: "2026-01-01" },
      { ticker: "A", tipo: "sell", quantita: 5, prezzoAcquisto: 150, dataAcquisto: "2026-02-01" },
    ], { A: 200 });
    expect(investito).toBe(500);  // 5 pezzi × costo medio 100
    expect(valore).toBe(1000);    // 5 × 200
  });

  it("senza prezzo manuale il titolo vale il costo di carico", () => {
    const { valore } = calcolaValorePortfolio([
      { ticker: "B", tipo: "buy", quantita: 4, prezzoAcquisto: 25, dataAcquisto: "2026-01-01" },
    ], {});
    expect(valore).toBe(100);
  });

  it("posizione chiusa non contribuisce; oversell viene limitato", () => {
    const { valore, investito } = calcolaValorePortfolio([
      { ticker: "C", tipo: "buy", quantita: 5, prezzoAcquisto: 100, dataAcquisto: "2026-01-01" },
      { ticker: "C", tipo: "sell", quantita: 10, prezzoAcquisto: 110, dataAcquisto: "2026-02-01" },
    ], { C: 999 });
    expect(valore).toBe(0);
    expect(investito).toBe(0);
  });

  it("i trade vengono processati in ordine cronologico anche se arrivano disordinati", () => {
    const { investito } = calcolaValorePortfolio([
      { ticker: "D", tipo: "sell", quantita: 5, prezzoAcquisto: 150, dataAcquisto: "2026-03-01" },
      { ticker: "D", tipo: "buy", quantita: 10, prezzoAcquisto: 100, dataAcquisto: "2026-01-01" },
    ], {});
    expect(investito).toBe(500);
  });
});

describe("calcolaSettleViaggio", () => {
  it("pareggio semplice a 3 partecipanti", () => {
    const settlements = calcolaSettleViaggio({
      expenses: [
        { importo: 90, pagatoDa: "a", splits: [{ personaId: "a", quota: 1 }, { personaId: "b", quota: 1 }, { personaId: "c", quota: 1 }] },
      ],
    });
    expect(settlements).toHaveLength(2);
    const totale = settlements.reduce((s, x) => s + x.importo, 0);
    expect(totale).toBeCloseTo(60, 2);
    expect(settlements.every(x => x.a === "a")).toBe(true);
  });

  it("spese incrociate: pagamenti minimizzati", () => {
    const settlements = calcolaSettleViaggio({
      expenses: [
        { importo: 100, pagatoDa: "a", splits: [{ personaId: "a", quota: 1 }, { personaId: "b", quota: 1 }] },
        { importo: 100, pagatoDa: "b", splits: [{ personaId: "a", quota: 1 }, { personaId: "b", quota: 1 }] },
      ],
    });
    expect(settlements).toEqual([]); // perfettamente in pari
  });

  it("quote diverse rispettate", () => {
    const settlements = calcolaSettleViaggio({
      expenses: [
        { importo: 100, pagatoDa: "a", splits: [{ personaId: "a", quota: 25 }, { personaId: "b", quota: 75 }] },
      ],
    });
    expect(settlements).toEqual([{ da: "b", a: "a", importo: 75 }]);
  });
});

describe("filtraTransazioni", () => {
  const categorie = [
    { id: "cibo", nome: "Cibo", emoji: "🍕" },
    { id: "trasporti", nome: "Trasporti", emoji: "🚗" },
  ];
  const tx = [
    { id: 1, tipo: "uscita", importo: 45.5, categoria: "cibo", descrizione: "Cena sushi", data: "2026-08-01", pagatoDa: "g", splits: [{ personaId: "g", quota: 50 }, { personaId: "m", quota: 50 }] },
    { id: 2, tipo: "uscita", importo: 120, categoria: "trasporti", descrizione: "Benzina", data: "2026-08-03", pagatoDa: "m", splits: [{ personaId: "m", quota: 100 }], contoId: "conto1" },
    { id: 3, tipo: "entrata", importo: 1500, categoria: "entrata", descrizione: "Stipendio agosto", data: "2026-08-05", intestataA: "g" },
    { id: 4, tipo: "trasferimento", importo: 200, descrizione: "Giroconto risparmi", data: "2026-08-06", contoDa: "conto1", contoA: "conto2" },
    { id: 5, tipo: "uscita", importo: 8.9, categoria: "cibo", descrizione: "Caffè", data: "2026-08-07", pagatoDa: "g", splits: [{ personaId: "g", quota: 100 }] },
  ];

  it("senza filtri restituisce tutto", () => {
    expect(filtraTransazioni(tx, {}, categorie)).toHaveLength(5);
  });

  it("query su descrizione, case-insensitive", () => {
    expect(filtraTransazioni(tx, { query: "SUSHI" }, categorie).map(t => t.id)).toEqual([1]);
  });

  it("query accent-insensitive", () => {
    expect(filtraTransazioni(tx, { query: "caffe" }, categorie).map(t => t.id)).toEqual([5]);
  });

  it("query matcha anche il nome categoria", () => {
    expect(filtraTransazioni(tx, { query: "cibo" }, categorie).map(t => t.id)).toEqual([1, 5]);
  });

  it("query multi-parola in AND", () => {
    expect(filtraTransazioni(tx, { query: "cena cibo" }, categorie).map(t => t.id)).toEqual([1]);
    expect(filtraTransazioni(tx, { query: "cena benzina" }, categorie)).toHaveLength(0);
  });

  it("filtro tipo", () => {
    expect(filtraTransazioni(tx, { tipo: "entrata" }, categorie).map(t => t.id)).toEqual([3]);
  });

  it("filtro categoria", () => {
    expect(filtraTransazioni(tx, { categoria: "cibo" }, categorie)).toHaveLength(2);
  });

  it("filtro persona: pagatoDa, intestataA e splits", () => {
    // g paga 1 e 5, è intestatario di 3, partecipa allo split di 1
    expect(filtraTransazioni(tx, { personaId: "g" }, categorie).map(t => t.id)).toEqual([1, 3, 5]);
    // m paga 2 e partecipa allo split di 1
    expect(filtraTransazioni(tx, { personaId: "m" }, categorie).map(t => t.id)).toEqual([1, 2]);
  });

  it("splits con quota 0 non contano come partecipazione", () => {
    const t0 = [{ id: 9, tipo: "uscita", importo: 10, pagatoDa: "g", splits: [{ personaId: "g", quota: 100 }, { personaId: "m", quota: 0 }] }];
    expect(filtraTransazioni(t0, { personaId: "m" }, categorie)).toHaveLength(0);
  });

  it("filtro conto include i giroconti (contoDa/contoA)", () => {
    expect(filtraTransazioni(tx, { contoId: "conto1" }, categorie).map(t => t.id)).toEqual([2, 4]);
    expect(filtraTransazioni(tx, { contoId: "conto2" }, categorie).map(t => t.id)).toEqual([4]);
  });

  it("range importo, anche con virgola decimale", () => {
    expect(filtraTransazioni(tx, { minImporto: "100" }, categorie).map(t => t.id)).toEqual([2, 3, 4]);
    expect(filtraTransazioni(tx, { maxImporto: "45,5" }, categorie).map(t => t.id)).toEqual([1, 5]);
    expect(filtraTransazioni(tx, { minImporto: 100, maxImporto: 300 }, categorie).map(t => t.id)).toEqual([2, 4]);
  });

  it("filtri combinati", () => {
    expect(filtraTransazioni(tx, { tipo: "uscita", personaId: "g", maxImporto: 10 }, categorie).map(t => t.id)).toEqual([5]);
  });

  it("input non valido nel range viene ignorato", () => {
    expect(filtraTransazioni(tx, { minImporto: "abc" }, categorie)).toHaveLength(5);
  });
});

describe("contaFiltriAttivi", () => {
  it("conta solo i filtri valorizzati", () => {
    expect(contaFiltriAttivi({})).toBe(0);
    expect(contaFiltriAttivi({ tipo: "", categoria: "", minImporto: "" })).toBe(0);
    expect(contaFiltriAttivi({ tipo: "uscita", categoria: "cibo" })).toBe(2);
    expect(contaFiltriAttivi({ personaId: "g", contoId: "c1", minImporto: "10", maxImporto: "20" })).toBe(4);
    expect(contaFiltriAttivi({ minImporto: "abc" })).toBe(0);
  });
});

describe("forecastNextMonthExpenses", () => {
  const cats = [{ id: "cibo", nome: "Cibo", emoji: "🍕", colore: "#FF6B6B" }, { id: "casa", nome: "Casa", emoji: "🏠", colore: "#45B7D1" }];
  const oggi = new Date(2026, 7, 20); // 20 agosto 2026 — mese in corso escluso

  it("media semplice sugli ultimi 3 mesi completi", () => {
    const tx = [
      { tipo: "uscita", importo: 100, categoria: "cibo", data: "2026-05-10" },
      { tipo: "uscita", importo: 200, categoria: "cibo", data: "2026-06-10" },
      { tipo: "uscita", importo: 300, categoria: "cibo", data: "2026-07-10" },
      { tipo: "uscita", importo: 999, categoria: "cibo", data: "2026-08-05" }, // mese in corso, escluso
    ];
    const r = forecastNextMonthExpenses(tx, cats, oggi);
    expect(r.forecast).toBe(200);
    expect(r.monthsUsed).toBe(3);
  });

  it("entrate e trasferimenti non contano", () => {
    const tx = [
      { tipo: "uscita", importo: 100, categoria: "cibo", data: "2026-07-10" },
      { tipo: "entrata", importo: 5000, categoria: "entrata", data: "2026-07-15" },
      { tipo: "trasferimento", importo: 300, data: "2026-07-20" },
    ];
    const r = forecastNextMonthExpenses(tx, cats, oggi);
    expect(r.forecast).toBe(100);
  });

  it("nessuno storico → previsione zero", () => {
    const r = forecastNextMonthExpenses([], cats, oggi);
    expect(r).toEqual({ forecast: 0, monthsUsed: 0, perCategory: [] });
  });

  it("media solo sui mesi con dati, non sulla finestra intera", () => {
    const tx = [
      { tipo: "uscita", importo: 150, categoria: "cibo", data: "2026-07-10" },
    ];
    const r = forecastNextMonthExpenses(tx, cats, oggi);
    expect(r.forecast).toBe(150);
    expect(r.monthsUsed).toBe(1);
  });

  it("ripartizione per categoria ordinata per valore decrescente", () => {
    const tx = [
      { tipo: "uscita", importo: 100, categoria: "cibo", data: "2026-07-01" },
      { tipo: "uscita", importo: 400, categoria: "casa", data: "2026-07-02" },
    ];
    const r = forecastNextMonthExpenses(tx, cats, oggi);
    expect(r.perCategory.map(c => c.id)).toEqual(["casa", "cibo"]);
    expect(r.perCategory[0].valore).toBe(400);
    expect(r.perCategory[0].nome).toBe("Casa");
  });
});
