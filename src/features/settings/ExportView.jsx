import { useState } from "react";
import { downloadBackup, restoreBackup } from "../../api.js";
import { t, mese } from "../../lib/i18n.js";
import { formattaValuta, importoOscurabile } from "../../lib/format.js";
import { getAllPersone, COLORI_EXTRA } from "../../lib/appHelpers.js";
import { toast } from "../../components/Toast.jsx";
import { labelStyle, inputStyle } from "../../components/ui/styles.js";
import { parseSplitwiseRows } from "./parseSplitwiseRows.js";

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

  // Backup state
  const [backupBusy, setBackupBusy] = useState(false);
  const [restorePreview, setRestorePreview] = useState(null);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreDone, setRestoreDone] = useState(null);

  async function handleDownloadBackup() {
    setBackupBusy(true);
    try {
      const data = await downloadBackup();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `backup-finanza-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) { toast(`${t(lang, "toast.errorBackupPrefix")} ${e.message}`, "error"); }
    setBackupBusy(false);
  }

  async function handleRestoreFile(file) {
    setRestoreDone(null);
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (data.formato !== "balance-tracker-backup") { toast(t(lang, "toast.notABackupFile"), "error"); return; }
      setRestorePreview({ data, counts: {
        transazioni: (data.transactions || []).length,
        conti: (data.accounts || []).length,
        obiettivi: (data.goals || []).length,
        viaggi: (data.trips || []).length,
        posizioni: (data.positions || []).length,
        prezzi: Object.keys(data.manualPrices || {}).length,
      }});
    } catch (e) { toast(`${t(lang, "toast.fileUnreadablePrefix")} ${e.message}`, "error"); }
  }

  async function handleConfirmRestore() {
    if (!restorePreview) return;
    setRestoreBusy(true);
    try {
      const res = await restoreBackup(restorePreview.data);
      setRestoreDone(res.counts);
      setRestorePreview(null);
      setTimeout(() => window.location.reload(), 2500);
    } catch (e) { toast(`${t(lang, "toast.errorRestorePrefix")} ${e.message}`, "error"); }
    setRestoreBusy(false);
  }

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
          splits = persone.map((p, i) => ({
            personaId: p.id,
            quota: i === persone.length - 1
              ? 100 - Math.floor(100 / persone.length) * (persone.length - 1)
              : Math.floor(100 / persone.length),
          }));
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

  async function esporta() {
    setEsportando(true);
    try {
      const XLSX = await import("xlsx");

      const rows = ordinate.map(t => {
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
      <div style={{ fontSize: 22, fontWeight: 800, color: "#eee", marginBottom: 6 }}>{t(lang, "export.importTitle")}</div>
      <div style={{ fontSize: 13, color: "#888", marginBottom: 16 }}>
        {t(lang, "export.importHint")}
      </div>

      <label style={{
        display: "block", padding: "18px 16px", borderRadius: 16, cursor: "pointer",
        border: "2px dashed #252538", background: "#1a1a28", textAlign: "center",
        color: importFile ? "#ccc" : "#555", fontSize: 13, marginBottom: 12, transition: "all 0.2s",
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
        <div style={{ textAlign: "center", color: "#6C5CE7", marginBottom: 12, fontSize: 13, padding: "10px 0" }}>
          {t(lang, "export.analyzing")}
        </div>
      )}

      {importPreview && !importando && (
        <div style={{ background: "#1a1a28", borderRadius: 16, padding: 16, marginBottom: 16, border: "1px solid #252538" }}>
          <div style={{ fontWeight: 700, color: "#eee", marginBottom: 10, fontSize: 14 }}>{t(lang, "export.importPreview")}</div>
          <div style={{ fontSize: 13, color: "#4ECDC4", marginBottom: importPreview.errori.length ? 8 : 0 }}>
            ✓ {importPreview.righe.length} {t(lang, "export.validTransactions")}
          </div>
          {importPreview.errori.length > 0 && (
            <div style={{ fontSize: 11, color: "#FF6B6B", marginBottom: 8, lineHeight: 1.6 }}>
              {importPreview.errori.map((e, i) => <div key={i}>⚠ {e}</div>)}
            </div>
          )}
          {importPreview.righe.length > 0 && (
            <>
              <div style={{ borderTop: "1px solid #252538", marginTop: 8, paddingTop: 8 }}>
                {importPreview.righe.slice(0, 3).map((r, i) => (
                  <div key={i} style={{ fontSize: 11, color: "#888", paddingBottom: 5, display: "flex", justifyContent: "space-between" }}>
                    <span>{r.data} · {r.tipo === "saldo" ? "Saldo" : r.categoria}</span>
                    <span style={{ color: r.tipo === "uscita" ? "#FF6B6B" : r.tipo === "saldo" ? "#a78bfa" : "#4ECDC4", fontFamily: "'Space Mono',monospace" }}>
                      {importoOscurabile(`${r.tipo === "uscita" ? "-" : r.tipo === "saldo" ? "↔" : "+"}€${r.importo.toFixed(2)}`)}
                    </span>
                  </div>
                ))}
                {importPreview.righe.length > 3 && (
                  <div style={{ fontSize: 11, color: "#555", marginTop: 2 }}>+ {t(lang, "export.moreRows")} {importPreview.righe.length - 3} {t(lang, "export.rows")}</div>
                )}
              </div>
              <button onClick={confermaImport} disabled={importando} style={{
                marginTop: 14, width: "100%", padding: "14px", border: "none",
                borderRadius: 14, cursor: "pointer", fontFamily: "'DM Sans',sans-serif",
                fontSize: 15, fontWeight: 700,
                background: "linear-gradient(135deg, #4ECDC4, #26a69a)",
                color: "#fff", boxShadow: "0 4px 20px #4ECDC433",
              }}>
                {t(lang, "export.importItems")} {(importPreview?.righe?.length || 0) + (importPortfolioPreview?.posizioni?.length || 0)} {t(lang, "export.items")}
              </button>
            </>
          )}
        </div>
      )}

      {/* Portfolio sheet preview */}
      {importPortfolioPreview && !importando && (
        <div style={{ background: "#1a1a28", borderRadius: 16, padding: 16, marginBottom: 16, border: "1px solid #252538" }}>
          <div style={{ fontWeight: 700, color: "#eee", marginBottom: 8, fontSize: 14 }}>{t(lang, "export.portfolioFound")}</div>
          <div style={{ fontSize: 13, color: "#4ECDC4", marginBottom: importPortfolioPreview.errori.length ? 8 : 0 }}>
            ✓ {importPortfolioPreview.posizioni.length} {t(lang, "export.validPositions")}
          </div>
          {importPortfolioPreview.errori.length > 0 && (
            <div style={{ fontSize: 11, color: "#FF6B6B", marginBottom: 8, lineHeight: 1.6 }}>
              {importPortfolioPreview.errori.map((e, i) => <div key={i}>⚠ {e}</div>)}
            </div>
          )}
          <div style={{ borderTop: "1px solid #252538", marginTop: 6, paddingTop: 6 }}>
            {importPortfolioPreview.posizioni.slice(0, 3).map((p, i) => (
              <div key={i} style={{ fontSize: 11, color: "#888", paddingBottom: 5, display: "flex", justifyContent: "space-between" }}>
                <span style={{ fontFamily: "'Space Mono',monospace", color: "#ccc" }}>{p.ticker}</span>
                <span>{p.tipo === "sell" ? t(lang, "export.sell") : t(lang, "export.buy")} {p.quantita} {t(lang, "portfolio.units")} × €{p.prezzoAcquisto}</span>
              </div>
            ))}
            {importPortfolioPreview.posizioni.length > 3 && (
              <div style={{ fontSize: 11, color: "#555", marginTop: 2 }}>+ {t(lang, "export.more")} {importPortfolioPreview.posizioni.length - 3}...</div>
            )}
          </div>
        </div>
      )}

      <div style={{ borderTop: "1px solid #1e1e2e", margin: "24px 0" }} />

      {/* ─── EXPORT SECTION ─── */}
      <div style={{ fontSize: 22, fontWeight: 800, color: "#eee", marginBottom: 6 }}>{t(lang, "export.exportTitle")}</div>
      <div style={{ fontSize: 13, color: "#888", marginBottom: 20 }}>{t(lang, "export.exportHint")}</div>

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

      {/* Column selector */}
      <div style={{ marginBottom: 18 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <label style={{ ...labelStyle, marginBottom: 0 }}>{t(lang, "export.columnsToExport")}</label>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={selezionaTutte} style={{ background: "none", border: "none", color: "#6C5CE7", fontSize: 11, cursor: "pointer", fontWeight: 600 }}>{t(lang, "export.all")}</button>
            <button onClick={deselezionaTutte} style={{ background: "none", border: "none", color: "#888", fontSize: 11, cursor: "pointer", fontWeight: 600 }}>{t(lang, "export.minimum")}</button>
          </div>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {ALL_COLUMN_IDS.map(id => {
            const active = colonne.includes(id);
            return (
              <button key={id} onClick={() => toggleColonna(id)} style={{
                padding: "7px 12px", borderRadius: 10, cursor: "pointer",
                fontSize: 12, fontWeight: 600, fontFamily: "'DM Sans',sans-serif",
                background: active ? "#6C5CE722" : "#1a1a28",
                border: active ? "2px solid #6C5CE7" : "2px solid #252538",
                color: active ? "#6C5CE7" : "#888",
                transition: "all 0.2s",
              }}>{t(lang, `col.${id}`)}</button>
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
      <div style={{ background: "#1a1a28", borderRadius: 16, padding: "14px 16px", marginBottom: 20, border: "1px solid #252538" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 13, color: "#ccc", fontWeight: 600 }}>{ordinate.length} {t(lang, "export.transactions")}</div>
            <div style={{ fontSize: 11, color: "#888", marginTop: 2 }}>{colonne.length} {t(lang, "export.columnsSelected")}</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: "#FF6B6B", fontFamily: "'Space Mono',monospace" }}>
              {formattaValuta(ordinate.filter(t => t.tipo === "uscita").reduce((s, t) => s + t.importo, 0))}
            </div>
            <div style={{ fontSize: 10, color: "#888" }}>{t(lang, "export.totalExpenses")}</div>
          </div>
        </div>
      </div>

      {/* Portfolio include toggle */}
      {positions?.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, padding: "12px 14px", background: "#1a1a28", borderRadius: 12, border: "1px solid #252538", cursor: "pointer" }}
          onClick={() => setIncludiPortfolio(v => !v)}>
          <div style={{
            width: 22, height: 22, borderRadius: 6, flexShrink: 0,
            border: includiPortfolio ? "2px solid #6C5CE7" : "2px solid #333",
            background: includiPortfolio ? "#6C5CE7" : "transparent",
            display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.15s",
          }}>{includiPortfolio && <span style={{ color: "#fff", fontSize: 13, lineHeight: 1 }}>✓</span>}</div>
          <div>
            <div style={{ fontSize: 13, color: "#ccc", fontWeight: 600 }}>{t(lang, "export.includePortfolio")}</div>
            <div style={{ fontSize: 11, color: "#555" }}>{positions.length} {t(lang, "export.positionsToSheet")}</div>
          </div>
        </div>
      )}

      {/* Export button */}
      <button onClick={esporta} disabled={ordinate.length === 0 || esportando} style={{
        width: "100%", padding: "16px", border: "none", borderRadius: 16, cursor: ordinate.length > 0 ? "pointer" : "default",
        fontFamily: "'DM Sans',sans-serif", fontSize: 16, fontWeight: 700,
        background: ordinate.length > 0 ? "linear-gradient(135deg, #6C5CE7, #a855f7)" : "#252538",
        color: ordinate.length > 0 ? "#fff" : "#666",
        boxShadow: ordinate.length > 0 ? "0 4px 20px #6C5CE744" : "none",
        opacity: esportando ? 0.6 : 1,
        transition: "all 0.3s",
      }}>
        {esportando ? t(lang, "export.generatingFile") : ordinate.length === 0 ? t(lang, "export.noTransactionsInPeriod") : `${t(lang, "export.downloadXlsx")} (${ordinate.length} ${t(lang, "export.rowsPlain")})`}
      </button>

      {/* ─── BACKUP SECTION ─── */}
      <div style={{ fontSize: 22, fontWeight: 800, color: "#eee", marginTop: 32, marginBottom: 6 }}>{t(lang, "export.backupTitle")}</div>
      <div style={{ fontSize: 13, color: "#888", marginBottom: 16 }}>
        {t(lang, "export.backupHint")}
      </div>
      <button onClick={handleDownloadBackup} disabled={backupBusy} style={{
        width: "100%", padding: "14px", border: "1px solid #4ECDC455", borderRadius: 14, cursor: "pointer",
        fontSize: 14, fontWeight: 700, background: "#4ECDC411", color: "#4ECDC4",
        fontFamily: "'DM Sans',sans-serif", marginBottom: 12, opacity: backupBusy ? 0.6 : 1,
      }}>{backupBusy ? t(lang, "export.preparing") : t(lang, "export.downloadBackup")}</button>

      <label style={{
        display: "block", padding: "14px 16px", borderRadius: 14, cursor: "pointer",
        border: "1px dashed #252538", background: "#1a1a28", textAlign: "center",
        color: "#888", fontSize: 13, marginBottom: 12,
      }}>
        {t(lang, "export.restoreFromBackup")}
        <input type="file" accept=".json,application/json" style={{ display: "none" }}
          onChange={e => { const f = e.target.files?.[0]; if (f) handleRestoreFile(f); e.target.value = ""; }} />
      </label>

      {restorePreview && (
        <div style={{ background: "#1a1a28", borderRadius: 16, padding: 16, marginBottom: 16, border: "1px solid #F0A50055" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#F0A500", marginBottom: 8 }}>{t(lang, "export.backupContents")}{restorePreview.data.creato ? ` (${restorePreview.data.creato.slice(0, 10)})` : ""}</div>
          <div style={{ fontSize: 12, color: "#aaa", lineHeight: 1.7 }}>
            {restorePreview.counts.transazioni} {t(lang, "export.transactions")} · {restorePreview.counts.conti} {t(lang, "export.accounts")} · {restorePreview.counts.obiettivi} {t(lang, "export.goals")} · {restorePreview.counts.viaggi} {t(lang, "export.trips")} · {restorePreview.counts.posizioni} {t(lang, "export.portfolioTrades")} · {restorePreview.counts.prezzi} {t(lang, "export.manualPrices")}
          </div>
          <div style={{ fontSize: 11, color: "#F0A500", marginTop: 10 }}>
            {t(lang, "export.restoreWarning")}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button onClick={() => setRestorePreview(null)} style={{ padding: "10px 14px", background: "none", border: "1px solid #333", borderRadius: 10, color: "#888", fontSize: 13, cursor: "pointer" }}>{t(lang, "common.cancel")}</button>
            <button onClick={handleConfirmRestore} disabled={restoreBusy} style={{ flex: 1, padding: "10px", background: "linear-gradient(135deg,#F0A500,#e08e00)", border: "none", borderRadius: 10, color: "#111", fontSize: 13, fontWeight: 700, cursor: "pointer", opacity: restoreBusy ? 0.6 : 1 }}>
              {restoreBusy ? t(lang, "export.restoring") : t(lang, "export.confirmRestore")}
            </button>
          </div>
        </div>
      )}

      {restoreDone && (
        <div style={{ background: "#4ECDC411", borderRadius: 16, padding: 16, marginBottom: 16, border: "1px solid #4ECDC455", fontSize: 13, color: "#4ECDC4" }}>
          {t(lang, "export.restoreComplete")}: {restoreDone.transactions} {t(lang, "export.transactions")}, {restoreDone.accounts} {t(lang, "export.accounts")}, {restoreDone.goals} {t(lang, "export.goals")}, {restoreDone.trips} {t(lang, "export.trips")}, {restoreDone.positions} {t(lang, "export.trades")}. {t(lang, "export.reloadingApp")}
        </div>
      )}
    </div>
  );
}
