import { describe, it, expect } from "vitest";
import { calcolaDebitiMatrix, calcolaSaldiConti, calcolaValorePortfolio, calcolaSettleViaggio } from "./finance.js";

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
