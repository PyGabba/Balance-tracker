import { useState } from "react";
import { t, mese } from "../../lib/i18n.js";
import { formattaValuta, importoOscurabile } from "../../lib/format.js";
import { getAllPersone, COLORI_EXTRA, equalQuotas } from "../../lib/appHelpers.js";
import { toast } from "../../components/Toast.jsx";
import { labelStyle, inputStyle, color, alpha, accentGradient, moneyFont, displayFont } from "../../components/ui/styles.js";
import { parseSplitwiseRows } from "./parseSplitwiseRows.js";
import { BackupSection } from "./BackupSection.jsx";

const ALL_COLUMN_IDS = ["data", "tipo", "importo", "categoria", "descrizione", "pagatoDa", "ricevutoDa", "partecipanti", "conto"];

export function ExportView({ transazioni, persone, positions, conti = [], onImport, onImportComplete, onImportPosition, onImportPositionComplete, lang = "it" }) {
  const oggi = new Date();
  const [meseDa, setMeseDa] = useState(`${oggi.getFullYear()}-${String(oggi.getMonth()+1).padStart(2,"0")}`);
  const [meseA, setMeseA] = useState(meseDa);
  const [colonne, setColonne] = useState(ALL_COLUMN_IDS);
  const [ordinamento, setOrdinamento] = useState("data-asc");
  const [esportando, setEsportando] = useState(false);
  const [includiPortfolio, setIncludiPortfolio] = useState(false);

  // Import state
  const [importando, setImportando] = useState(false);
  const [importPreview, setImportPreview] = useState(null);
  const [importPortfolioPreview, setImportPortfolioPreview] = useState(null);
  const [importFile, setImportFile] = useState(null);

  function toggleColonna(id) {
    setColonne(prev => prev.includes(id) ? prev.filter(c => c !== id) : [...prev, id]);
  }

  function selezionaTutte() { setColonne(ALL_COLUMN_IDS); }
  function deselezionaTutte() { setColonne(["data", "importo"]); } // minimo

  async function parseImportFile(file) {
    setImportando(true);
    setImportPreview(null);
    setImportPortfolioPreview(null);
    try {
      const XLSX = await import("xlsx");
      const buffer = await file.arrayBuffer();
      const wb = XLSX.read(buffer, { type: "array" });

      // ── Parse transactions (first non-Portfolio sheet) ──
      const txSheetName = wb.SheetNames.find(n => n !== "Portfolio") || wb.SheetNames[0];
      const ws = wb.Sheets[txSheetName];
      const rawRows = XLSX.utils.sheet_to_json(ws, { defval: "" });

      // ── Splitwise CSV auto-detection ──
      const headerKeys = Object.keys(rawRows.find(r => Object.keys(r).length > 0) || {});
      const isSplitwise =
        (headerKeys.includes("Costo") || headerKeys.includes("Cost")) &&
        (headerKeys.includes("Valuta") || headerKeys.includes("Currency"));
      if (isSplitwise) {
        setImportPreview(parseSplitwiseRows(rawRows, persone));
        return; // "finally" already resets importando
      }

      const righe = [];
      const errori = [];

      rawRows.forEach((row, i) => {
        const num = i + 2;
        const data = String(row["Data"] || "").trim();
        const tipoRaw = String(row["Tipo"] || "").toLowerCase().trim();
        const importoRaw = row["Importo (€)"] ?? row["Importo"] ?? "";
        const categoria = String(row["Categoria"] || "Altro").trim();
        const descrizione = String(row["Descrizione"] || "").trim();
        const pagatoDaNome = String(row["Pagato da"] || "").trim();
        const ricevutoDaNome = String(row["Ricevuto da"] || "").trim();

        if (!data.match(/^\d{4}-\d{2}-\d{2}$/)) {
          errori.push(`Riga ${num}: data non valida ("${data}") — formato atteso YYYY-MM-DD`);
          return;
        }
        const tipo = tipoRaw === "saldo" ? "saldo" : tipoRaw === "entrata" ? "entrata" : "uscita";
        const importo = parseFloat(String(importoRaw).replace(",", "."));
        if (isNaN(importo) || importo <= 0) {
          errori.push(`Riga ${num}: importo non valido ("${importoRaw}")`);
          return;
        }
        const persona = persone.find(p => p.nome.toLowerCase() === pagatoDaNome.toLowerCase());
        const pagatoDa = persona?.id || persone[0]?.id || "";
        const ricevutoDaPersona = persone.find(p => p.nome.toLowerCase() === ricevutoDaNome.toLowerCase());
        const ricevutoDa = ricevutoDaPersona?.id || null;

        let splits = null;
        let extraPersone = null;
        const partecipantiRaw = String(row["Partecipanti e quote"] || row["Partecipanti"] || "").trim();
        if (tipo === "uscita" && partecipantiRaw) {
          const extraMap = {};
          let extraCount = 0;
          const parsed = partecipantiRaw.split(",").map(s => s.trim()).map(s => {
            const m = s.match(/^(.+?)\s+(\d+(?:\.\d+)?)%$/);
            if (!m) return null;
            const nome = m[1].trim();
            const quota = parseFloat(m[2]);
            const p = persone.find(x => x.nome.toLowerCase() === nome.toLowerCase());
            if (p) return { personaId: p.id, quota };
            const id = nome.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "") || `extra${extraCount}`;
            if (!extraMap[id]) {
              extraMap[id] = { id, nome, emoji: "👤", colore: COLORI_EXTRA[extraCount % COLORI_EXTRA.length] };
              extraCount++;
            }
            return { personaId: id, quota };
          }).filter(Boolean);

          const extraList = Object.values(extraMap);
          if (extraList.length > 0) extraPersone = extraList;

          if (parsed.length > 0) {
            const assignedTotal = parsed.reduce((s, x) => s + x.quota, 0);
            const remaining = Math.round((100 - assignedTotal) * 100) / 100;
            const unassigned = persone.filter(p => !parsed.find(x => x.personaId === p.id));
            if (remaining > 0.5 && unassigned.length > 0) {
              const share = Math.floor(remaining / unassigned.length);
              let leftover = remaining - share * unassigned.length;
              unassigned.forEach((p, i) => {
                parsed.push({ personaId: p.id, quota: share + (i === 0 ? Math.round(leftover) : 0) });
              });
            }
            splits = parsed;
          }
        }
        if (tipo === "uscita" && !splits) {
          const quotas = equalQuotas(persone.length);
          splits = persone.map((p, i) => ({ personaId: p.id, quota: quotas[i] }));
        }

        righe.push({ data, tipo, importo, categoria: tipo === "saldo" ? null : categoria, descrizione, pagatoDa, ricevutoDa, splits, extraPersone });
      });

      setImportPreview({ righe, errori });

      // ── Parse Portfolio sheet (if present) ──
      if (wb.SheetNames.includes("Portfolio")) {
        const wsP = wb.Sheets["Portfolio"];
        const rawP = XLSX.utils.sheet_to_json(wsP, { defval: "" });
        const posizioni = [];
        const erroriP = [];

        rawP.forEach((row, i) => {
          const num = i + 2;
          const ticker = String(row["Ticker"] || "").trim().toUpperCase();
          const nome = String(row["Nome"] || ticker).trim();
          const tipoRaw = String(row["Tipo"] || "").toLowerCase().trim();
          const tipo = tipoRaw === "vendita" ? "sell" : "buy";
          const quantita = parseFloat(String(row["Quantità"] ?? row["Quantita"] ?? "").replace(",", "."));
          const prezzoAcquisto = parseFloat(String(row["Prezzo (€)"] ?? row["Prezzo"] ?? "").replace(",", "."));
          const dataAcquisto = String(row["Data"] || "").trim();
          const note = String(row["Note"] || "").trim();

          if (!ticker) { erroriP.push(`Riga ${num}: ticker mancante`); return; }
          if (isNaN(quantita) || quantita <= 0) { erroriP.push(`Riga ${num}: quantità non valida`); return; }
          if (isNaN(prezzoAcquisto) || prezzoAcquisto < 0) { erroriP.push(`Riga ${num}: prezzo non valido`); return; }

          posizioni.push({ ticker, nome, tipo, quantita, prezzoAcquisto, dataAcquisto, note });
        });

        if (posizioni.length > 0 || erroriP.length > 0) {
          setImportPortfolioPreview({ posizioni, errori: erroriP });
        }
      }

    } catch (err) {
      toast(`${t(lang, "toast.errorParsePrefix")} ${err.message}`, "error");
    } finally {
      setImportando(false);
    }
  }

  async function confermaImport() {
    if (!importPreview?.righe?.length && !importPortfolioPreview?.posizioni?.length) return;
    setImportando(true);
    let okTx = 0, failTx = 0, okPos = 0, failPos = 0;

    // Import transactions
    for (const tx of (importPreview?.righe || [])) {
      try { await onImport(tx); okTx++; }
      catch { failTx++; }
    }
    if (okTx > 0 && onImportComplete) await onImportComplete();

    // Import portfolio positions
    for (const pos of (importPortfolioPreview?.posizioni || [])) {
      try { await onImportPosition(pos); okPos++; }
      catch { failPos++; }
    }
    if (okPos > 0 && onImportPositionComplete) await onImportPositionComplete();

    setImportando(false);
    setImportPreview(null);
    setImportPortfolioPreview(null);
    setImportFile(null);

    const parts = [];
    if (okTx > 0) parts.push(`${okTx} ${t(lang, "export.transactions")}`);
    if (okPos > 0) parts.push(`${okPos} ${t(lang, "export.portfolioPositions")}`);
    const errParts = [];
    if (failTx > 0) errParts.push(`${failTx} ${t(lang, "export.transactions")}`);
    if (failPos > 0) errParts.push(`${failPos} ${t(lang, "export.positions")}`);
    toast(`${t(lang, "toast.importCompletePrefix")} ${parts.join(` ${t(lang, "toast.and")} `)} ${t(lang, "toast.importedSuffix")}${errParts.length ? `, ${t(lang, "toast.errorsSuffix")} ${errParts.join(", ")}` : ""}.`, "success");
  }

  // Filter transactions by month range
  const filtrate = transazioni.filter(t => {
    const mese = t.data?.slice(0, 7); // "YYYY-MM"
    return mese && mese >= meseDa && mese <= meseA;
  });

  // Sort
  const ordinate = [...filtrate].sort((a, b) => {
    const [campo, dir] = ordinamento.split("-");
    let va, vb;
    if (campo === "data") { va = a.data; vb = b.data; }
    else if (campo === "importo") { va = a.importo; vb = b.importo; }
    else if (campo === "categoria") { va = a.categoria; vb = b.categoria; }
    else if (campo === "pagatoDa") { va = a.pagatoDa || ""; vb = b.pagatoDa || ""; }
    else { va = a.data; vb = b.data; }
    if (va < vb) return dir === "asc" ? -1 : 1;
    if (va > vb) return dir === "asc" ? 1 : -1;
    return 0;
  });

  // Shared row-building logic — used by both the XLSX and CSV export paths
  // so the two file formats never drift apart on which columns/values they contain.
  function buildExportRows() {
    return ordinate.map(t => {
      const row = {};
      const p = persone.find(p => p.id === t.pagatoDa);
      if (colonne.includes("data")) row["Data"] = t.data;
      if (colonne.includes("tipo")) row["Tipo"] = t.tipo === "saldo" ? "Saldo" : t.tipo === "trasferimento" ? "Giroconto" : t.tipo === "uscita" ? "Uscita" : "Entrata";
      if (colonne.includes("importo")) row["Importo (€)"] = t.importo;
      if (colonne.includes("categoria")) row["Categoria"] = t.tipo === "saldo" ? "" : (t.categoria || "");
      if (colonne.includes("descrizione")) row["Descrizione"] = t.descrizione || "";
      if (colonne.includes("conto")) {
        if (t.tipo === "trasferimento") {
          const cDa = conti.find(c => c.id === t.contoDa); const cA = conti.find(c => c.id === t.contoA);
          row["Conto"] = `${cDa?.nome || "?"} → ${cA?.nome || "?"}`;
        } else {
          row["Conto"] = conti.find(c => c.id === t.contoId)?.nome || "";
        }
      }
      if (colonne.includes("pagatoDa")) row["Pagato da"] = p?.nome || t.pagatoDa || "";
      if (colonne.includes("ricevutoDa")) {
        const rp = persone.find(x => x.id === t.ricevutoDa);
        row["Ricevuto da"] = rp?.nome || t.ricevutoDa || "";
      }
      if (colonne.includes("partecipanti") && t.tipo !== "saldo") {
        if (t.splits && Array.isArray(t.splits) && t.splits.length > 0) {
          const allP = getAllPersone(transazioni, persone);
          row["Partecipanti"] = t.splits.map(s => {
            const sp = allP.find(x => x.id === s.personaId);
            return `${sp?.nome || s.personaId} ${s.quota}%`;
          }).join(", ");
        } else if (t.splitPagante != null) {
          row["Partecipanti"] = `${p?.nome || ""} ${t.splitPagante}%`;
        } else {
          row["Partecipanti"] = "";
        }
      }
      return row;
    });
  }

  async function esporta() {
    setEsportando(true);
    try {
      const XLSX = await import("xlsx");
      const rows = buildExportRows();

      const ws = XLSX.utils.json_to_sheet(rows);
      const colWidths = Object.keys(rows[0] || {}).map(key => ({
        wch: Math.max(key.length, ...rows.map(r => String(r[key] ?? "").length)) + 2,
      }));
      ws["!cols"] = colWidths;

      const wb = XLSX.utils.book_new();
      const sheetName = meseDa === meseA ? meseDa : `${meseDa}_${meseA}`;
      XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));

      // Optional portfolio sheet
      if (includiPortfolio && positions && positions.length > 0) {
        const pRows = positions.map(p => ({
          "Ticker": p.ticker || "",
          "Nome": p.nome || p.ticker || "",
          "Tipo": p.tipo === "sell" ? "Vendita" : "Acquisto",
          "Quantità": p.quantita,
          "Prezzo (€)": p.prezzoAcquisto,
          "Data": p.dataAcquisto || "",
          "Note": p.note || "",
        }));
        const wsP = XLSX.utils.json_to_sheet(pRows);
        const colWidthsP = Object.keys(pRows[0] || {}).map(key => ({
          wch: Math.max(key.length, ...pRows.map(r => String(r[key] ?? "").length)) + 2,
        }));
        wsP["!cols"] = colWidthsP;
        XLSX.utils.book_append_sheet(wb, wsP, "Portfolio");
      }

      XLSX.writeFile(wb, `finanza_${sheetName}.xlsx`);
    } catch (err) {
      console.error("Export error:", err);
      toast(`${t(lang, "toast.errorExportPrefix")} ${err.message}`, "error");
    } finally {
      setEsportando(false);
    }
  }

  // CSV export — transactions only (a CSV file has no second-sheet concept,
  // so the portfolio-include toggle only ever applies to the XLSX path).
  async function esportaCsv() {
    setEsportando(true);
    try {
      const XLSX = await import("xlsx");
      const rows = buildExportRows();
      const ws = XLSX.utils.json_to_sheet(rows);
      const csv = XLSX.utils.sheet_to_csv(ws);
      const sheetName = meseDa === meseA ? meseDa : `${meseDa}_${meseA}`;
      const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `finanza_${sheetName}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("CSV export error:", err);
      toast(`${t(lang, "toast.errorExportPrefix")} ${err.message}`, "error");
    } finally {
      setEsportando(false);
    }
  }

  // Generate month options (last 24 months)
  const mesiOptions = [];
  for (let i = 0; i < 24; i++) {
    const d = new Date(oggi.getFullYear(), oggi.getMonth() - i, 1);
    const val = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
    const label = `${mese(d.getMonth(), lang)} ${d.getFullYear()}`;
    mesiOptions.push({ val, label });
  }

  const sortOptions = [
    { val: "data-asc", label: t(lang, "export.sortDateAsc") },
    { val: "data-desc", label: t(lang, "export.sortDateDesc") },
    { val: "importo-desc", label: t(lang, "export.sortAmountDesc") },
    { val: "importo-asc", label: t(lang, "export.sortAmountAsc") },
    { val: "categoria-asc", label: t(lang, "export.sortCategoryAsc") },
    { val: "pagatoDa-asc", label: t(lang, "export.sortPaidByAsc") },
  ];

  return (
    <div style={{ padding: "20px 16px" }}>
      {/* ─── IMPORT SECTION ─── */}
      <div style={{ fontSize: 22, fontWeight: 800, color: color.textPrimary, marginBottom: 6 }}>{t(lang, "export.importTitle")}</div>
      <div style={{ fontSize: 13, color: color.textSecondary, marginBottom: 16 }}>
        {t(lang, "export.importHint")}
      </div>

      <label style={{
        display: "block", padding: "18px 16px", borderRadius: 16, cursor: "pointer",
        border: `2px dashed ${color.border}`, background: color.surface, textAlign: "center",
        color: importFile ? color.textSecondary : color.textMuted, fontSize: 13, marginBottom: 12, transition: "all 0.2s",
      }}>
        <span style={{ fontSize: 22, display: "block", marginBottom: 6 }}>📂</span>
        {importFile ? importFile.name : t(lang, "export.chooseFile")}
        <input type="file" accept=".xlsx,.csv" style={{ display: "none" }}
          onChange={e => {
            const f = e.target.files?.[0];
            if (f) { setImportFile(f); parseImportFile(f); }
            e.target.value = "";
          }}
        />
      </label>

      {importando && (
        <div style={{ textAlign: "center", color: color.accent, marginBottom: 12, fontSize: 13, padding: "10px 0" }}>
          {t(lang, "export.analyzing")}
        </div>
      )}

      {importPreview && !importando && (
        <div style={{ background: color.surface, borderRadius: 16, padding: 16, marginBottom: 16, border: `1px solid ${color.border}` }}>
          <div style={{ fontWeight: 700, color: color.textPrimary, marginBottom: 10, fontSize: 14 }}>{t(lang, "export.importPreview")}</div>
          <div style={{ fontSize: 13, color: color.positive, marginBottom: importPreview.errori.length ? 8 : 0 }}>
            ✓ {importPreview.righe.length} {t(lang, "export.validTransactions")}
          </div>
          {importPreview.errori.length > 0 && (
            <div style={{ fontSize: 11, color: color.negative, marginBottom: 8, lineHeight: 1.6 }}>
              {importPreview.errori.map((e, i) => <div key={i}>⚠ {e}</div>)}
            </div>
          )}
          {importPreview.righe.length > 0 && (
            <>
              <div style={{ borderTop: `1px solid ${color.border}`, marginTop: 8, paddingTop: 8 }}>
                {importPreview.righe.slice(0, 3).map((r, i) => (
                  <div key={i} style={{ fontSize: 11, color: color.textMuted, paddingBottom: 5, display: "flex", justifyContent: "space-between" }}>
                    <span>{r.data} · {r.tipo === "saldo" ? "Saldo" : r.categoria}</span>
                    <span style={{ color: r.tipo === "uscita" ? color.negative : r.tipo === "saldo" ? color.accent : color.positive, fontFamily: moneyFont }}>
                      {importoOscurabile(`${r.tipo === "uscita" ? "-" : r.tipo === "saldo" ? "↔" : "+"}€${r.importo.toFixed(2)}`)}
                    </span>
                  </div>
                ))}
                {importPreview.righe.length > 3 && (
                  <div style={{ fontSize: 11, color: color.textMuted, marginTop: 2 }}>+ {t(lang, "export.moreRows")} {importPreview.righe.length - 3} {t(lang, "export.rows")}</div>
                )}
              </div>
              <button onClick={confermaImport} disabled={importando} style={{
                marginTop: 14, width: "100%", padding: "14px", border: "none",
                borderRadius: 14, cursor: "pointer", fontFamily: displayFont,
                fontSize: 15, fontWeight: 700,
                background: color.positive,
                color: color.bg, boxShadow: `0 4px 20px ${alpha(color.positive, 0.2)}`,
              }}>
                {t(lang, "export.importItems")} {(importPreview?.righe?.length || 0) + (importPortfolioPreview?.posizioni?.length || 0)} {t(lang, "export.items")}
              </button>
            </>
          )}
        </div>
      )}

      {/* Portfolio sheet preview */}
      {importPortfolioPreview && !importando && (
        <div style={{ background: color.surface, borderRadius: 16, padding: 16, marginBottom: 16, border: `1px solid ${color.border}` }}>
          <div style={{ fontWeight: 700, color: color.textPrimary, marginBottom: 8, fontSize: 14 }}>{t(lang, "export.portfolioFound")}</div>
          <div style={{ fontSize: 13, color: color.positive, marginBottom: importPortfolioPreview.errori.length ? 8 : 0 }}>
            ✓ {importPortfolioPreview.posizioni.length} {t(lang, "export.validPositions")}
          </div>
          {importPortfolioPreview.errori.length > 0 && (
            <div style={{ fontSize: 11, color: color.negative, marginBottom: 8, lineHeight: 1.6 }}>
              {importPortfolioPreview.errori.map((e, i) => <div key={i}>⚠ {e}</div>)}
            </div>
          )}
          <div style={{ borderTop: `1px solid ${color.border}`, marginTop: 6, paddingTop: 6 }}>
            {importPortfolioPreview.posizioni.slice(0, 3).map((p, i) => (
              <div key={i} style={{ fontSize: 11, color: color.textMuted, paddingBottom: 5, display: "flex", justifyContent: "space-between" }}>
                <span style={{ fontFamily: moneyFont, color: color.textSecondary }}>{p.ticker}</span>
                <span>{p.tipo === "sell" ? t(lang, "export.sell") : t(lang, "export.buy")} {p.quantita} {t(lang, "portfolio.units")} × €{p.prezzoAcquisto}</span>
              </div>
            ))}
            {importPortfolioPreview.posizioni.length > 3 && (
              <div style={{ fontSize: 11, color: color.textMuted, marginTop: 2 }}>+ {t(lang, "export.more")} {importPortfolioPreview.posizioni.length - 3}...</div>
            )}
          </div>
        </div>
      )}

      <div style={{ borderTop: `1px solid ${color.border}`, margin: "24px 0" }} />

      {/* ─── EXPORT SECTION ─── */}
      <div style={{ fontSize: 22, fontWeight: 800, color: color.textPrimary, marginBottom: 6 }}>{t(lang, "export.exportTitle")}</div>
      <div style={{ fontSize: 13, color: color.textSecondary, marginBottom: 20 }}>{t(lang, "export.exportHint")}</div>

      {/* Month range */}
      <div style={{ display: "flex", gap: 10, marginBottom: 18 }}>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>{t(lang, "export.fromMonth")}</label>
          <select value={meseDa} onChange={e => { setMeseDa(e.target.value); if (e.target.value > meseA) setMeseA(e.target.value); }}
            style={{ ...inputStyle, colorScheme: "dark", cursor: "pointer" }}>
            {mesiOptions.map(m => <option key={m.val} value={m.val}>{m.label}</option>)}
          </select>
        </div>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>{t(lang, "export.toMonth")}</label>
          <select value={meseA} onChange={e => setMeseA(e.target.value)}
            style={{ ...inputStyle, colorScheme: "dark", cursor: "pointer" }}>
            {mesiOptions.filter(m => m.val >= meseDa).map(m => <option key={m.val} value={m.val}>{m.label}</option>)}
          </select>
        </div>
      </div>

      {/* Column selector — vertical checkbox rows */}
      <div style={{ background: color.surface, borderRadius: 16, padding: 16, marginBottom: 18, border: `1px solid ${color.border}` }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <label style={{ ...labelStyle, marginBottom: 0 }}>{t(lang, "export.columnsToExport")}</label>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={selezionaTutte} style={{ background: "none", border: "none", color: color.accent, fontSize: 11, cursor: "pointer", fontWeight: 600 }}>{t(lang, "export.all")}</button>
            <button onClick={deselezionaTutte} style={{ background: "none", border: "none", color: color.textMuted, fontSize: 11, cursor: "pointer", fontWeight: 600 }}>{t(lang, "export.minimum")}</button>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          {ALL_COLUMN_IDS.map(id => {
            const active = colonne.includes(id);
            return (
              <button key={id} onClick={() => toggleColonna(id)} style={{
                width: "100%", display: "flex", alignItems: "center", gap: 10,
                background: "none", border: "none", padding: "8px 0", cursor: "pointer", fontFamily: displayFont,
              }}>
                <div style={{
                  width: 18, height: 18, borderRadius: 5, flexShrink: 0,
                  border: `1px solid ${active ? color.accent : color.borderStrong}`,
                  background: active ? color.accentSoft : "transparent",
                  color: color.accent, fontSize: 12, display: "flex", alignItems: "center", justifyContent: "center",
                }}>{active ? "✓" : ""}</div>
                <span style={{ fontSize: 13, color: color.textPrimary }}>{t(lang, `col.${id}`)}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Sort order */}
      <div style={{ marginBottom: 18 }}>
        <label style={labelStyle}>{t(lang, "export.sortOrder")}</label>
        <select value={ordinamento} onChange={e => setOrdinamento(e.target.value)}
          style={{ ...inputStyle, colorScheme: "dark", cursor: "pointer" }}>
          {sortOptions.map(s => <option key={s.val} value={s.val}>{s.label}</option>)}
        </select>
      </div>

      {/* Preview */}
      <div style={{ background: color.surface, borderRadius: 16, padding: "14px 16px", marginBottom: 20, border: `1px solid ${color.border}` }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 13, color: color.textSecondary, fontWeight: 600 }}>{ordinate.length} {t(lang, "export.transactions")}</div>
            <div style={{ fontSize: 11, color: color.textMuted, marginTop: 2 }}>{colonne.length} {t(lang, "export.columnsSelected")}</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: color.negative, fontFamily: moneyFont }}>
              {formattaValuta(ordinate.filter(t => t.tipo === "uscita").reduce((s, t) => s + t.importo, 0))}
            </div>
            <div style={{ fontSize: 10, color: color.textMuted }}>{t(lang, "export.totalExpenses")}</div>
          </div>
        </div>
      </div>

      {/* Portfolio include toggle */}
      {positions?.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, padding: "12px 14px", background: color.surface, borderRadius: 12, border: `1px solid ${color.border}`, cursor: "pointer" }}
          onClick={() => setIncludiPortfolio(v => !v)}>
          <div style={{
            width: 22, height: 22, borderRadius: 6, flexShrink: 0,
            border: includiPortfolio ? `2px solid ${color.accent}` : `2px solid ${color.borderStrong}`,
            background: includiPortfolio ? color.accent : "transparent",
            display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.15s",
          }}>{includiPortfolio && <span style={{ color: "#fff", fontSize: 13, lineHeight: 1 }}>✓</span>}</div>
          <div>
            <div style={{ fontSize: 13, color: color.textSecondary, fontWeight: 600 }}>{t(lang, "export.includePortfolio")}</div>
            <div style={{ fontSize: 11, color: color.textMuted }}>{positions.length} {t(lang, "export.positionsToSheet")}</div>
          </div>
        </div>
      )}

      {/* Export buttons — filled XLSX + outline CSV */}
      <div style={{ display: "flex", gap: 10 }}>
        <button onClick={esporta} disabled={ordinate.length === 0 || esportando} style={{
          flex: 1, padding: "15px", borderRadius: 14, cursor: ordinate.length > 0 ? "pointer" : "default",
          fontFamily: displayFont, fontSize: 14, fontWeight: 700,
          background: ordinate.length > 0 ? color.accentSoft : color.border,
          color: ordinate.length > 0 ? color.accent : color.textMuted,
          border: ordinate.length > 0 ? `1px solid ${color.accent}` : `1px solid ${color.border}`,
          opacity: esportando ? 0.6 : 1,
          transition: "all 0.3s",
        }}>↓ {esportando ? t(lang, "export.generatingFile") : "XLSX"}</button>
        <button onClick={esportaCsv} disabled={ordinate.length === 0 || esportando} style={{
          flex: 1, padding: "15px", border: `1px solid ${color.border}`, borderRadius: 14, cursor: ordinate.length > 0 ? "pointer" : "default",
          fontFamily: displayFont, fontSize: 14, fontWeight: 700,
          background: "none", color: ordinate.length > 0 ? color.textSecondary : color.textMuted,
          opacity: esportando ? 0.6 : 1,
        }}>↓ CSV</button>
      </div>
      <div style={{ fontSize: 11, color: color.textMuted, textAlign: "center", marginTop: 10 }}>
        {ordinate.length === 0 ? t(lang, "export.noTransactionsInPeriod") : `${ordinate.length} ${t(lang, "export.rowsPlain")}`}
      </div>

      {/* ─── BACKUP SECTION ─── */}
      <div style={{ fontSize: 22, fontWeight: 800, color: color.textPrimary, marginTop: 32, marginBottom: 6 }}>{t(lang, "export.backupTitle")}</div>
      <BackupSection lang={lang} />
    </div>
  );
}
