// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: deep-green; icon-glyph: magic;
// ─── Widget Finanza per Scriptable ───
// Istruzioni:
// 1. Installa "Scriptable" dall'App Store (gratis)
// 2. Nell'app: + → incolla questo script → rinominalo ESATTAMENTE "Finanza"
//    (il nome deve corrispondere a SCRIPT_NAME qui sotto, serve per i tocchi)
// 3. Sostituisci WIDGET_URL con l'URL generato in Impostazioni → Widget iPhone
//    (la chiave è come una password: non condividere né incollare lo script
//    con la chiave dentro; se succede, revocala e generane una nuova)
// 4. Home screen: tieni premuto → + → Scriptable → dimensione Media
//    → tocca il widget → Script: "Finanza" (When Interacting: Run Script)
// iOS aggiorna il widget periodicamente (circa ogni 15-30 minuti); dopo
// un'aggiunta rapida l'app mostra subito l'anteprima coi totali freschi,
// ma sulla home screen li vedrai al refresh successivo.
//
// Zone di tocco (un widget Scriptable esegue un'azione diversa per elemento):
//   👁            → nasconde/mostra gli importi
//   ➖ Uscita      → modulo rapido: importo, categoria, chi ha pagato,
//                    divisione (personale o equa), conto. Dalla seconda volta
//                    propone "Come l'ultima volta?" e basta un tocco
//   ➕ Entrata     → modulo rapido: importo, a chi è intestata, conto
//   ↗ (in alto)   → apre l'app completa
//
// Layout (come la Home dell'app): Patrimonio → "Questo mese" (Uscite, Entrate,
// Saldo, confronto col mese scorso, prossima scadenza) → "Conti" (in ordine
// di saldo, totale nel titolo, investimenti in fondo) → Uscita / Entrata.

const WIDGET_URL = "https://INCOLLA_QUI/api/widget?key=INCOLLA_LA_TUA_CHIAVE";
const SCRIPT_NAME = "Finanza"; // deve combaciare col nome dato allo script al passo 2

// Dimensione dei caratteri (e delle icone) di tutto il widget. 1 = misura
// standard; 1.15 = circa il 15% più grandi; 1.3 = molto grandi. Gli importi si
// riducono da soli se non entrano (minimumScaleFactor), ma oltre ~1.3 nel
// widget Medio i pulsanti in basso rischiano di venire tagliati: in quel
// caso usa il widget Grande, o togli la riga Investimenti / la scadenza.
const FONT_SCALE = 1;

// Ingrandimento in più, SOLO per le cifre (patrimonio, uscite/entrate/saldo,
// saldi dei conti, importo della scadenza), sopra FONT_SCALE: così i numeri si
// leggono meglio senza gonfiare anche etichette e nomi. 1 = nessuna differenza
// dalle etichette; 1.2 = cifre il 20% più grandi (consigliato); 1.4 = molto grandi.
const AMOUNT_SCALE = 1.2;

const APP_URL = WIDGET_URL.includes("INCOLLA_QUI") ? null : (WIDGET_URL.match(/^https?:\/\/[^\/]+/) || [null])[0];
const TRANSACTION_URL = WIDGET_URL.includes("INCOLLA_QUI") ? null : WIDGET_URL.replace("/api/widget", "/api/widget/transaction");
const RUN_URL = (params) => `scriptable:///run/${encodeURIComponent(SCRIPT_NAME)}?${params}`;

// ─── Stato persistente tra un aggiornamento e l'altro ───
// hidden: importi nascosti. last: le ultime scelte del modulo rapido
// (chi ha pagato, divisione, conto), per proporle di nuovo la volta dopo.
const fm = FileManager.local();
const STATE_FILE = fm.joinPath(fm.documentsDirectory(), "finanza-widget-state.json");
function loadState() {
  if (!fm.fileExists(STATE_FILE)) return {};
  try { return JSON.parse(fm.readString(STATE_FILE)) || {}; } catch { return {}; }
}
function saveState(patch) {
  try { fm.writeString(STATE_FILE, JSON.stringify({ ...loadState(), ...patch })); } catch (e) { /* non bloccante */ }
}
function isHidden() { return loadState().hidden === true; }
function setHidden(v) { saveState({ hidden: v }); }

// Parametri passati quando il tocco arriva da uno scriptable:///run/... URL
const qp = (typeof args !== "undefined" && args.queryParameters) || {};

let hidden = isHidden();
if (qp.toggle === "1") { hidden = !hidden; setHidden(hidden); }

// Palette allineata all'app
// Stesso gradiente della card "Saldo" nella Home dell'app (#1e1e30 → #2a1f4e)
function bgGradient() {
  const g = new LinearGradient();
  g.colors = [new Color("#1e1e30"), new Color("#2a1f4e")];
  g.locations = [0, 1];
  return g;
}
const TEXT = new Color("#eeeeee");
// Grigio con una punta di lavanda, per "rimare" col gradiente viola/blu
// invece di un grigio neutro che stona leggermente sullo sfondo.
const MUTED = new Color("#9a9ab5");
// Testo secondario più chiaro del MUTED, per i nomi dei conti.
const TEXT_SOFT = new Color("#d4d4e4");
const GREEN = new Color("#4ECDC4");
const RED = new Color("#FF6B6B");
const AMBER = new Color("#F0A500");
const PURPLE = new Color("#a78bfa");

// ─── Font scalati con FONT_SCALE ───
const px = (n) => Math.round(n * FONT_SCALE * 10) / 10;
const F = {
  regular: (s) => Font.systemFont(px(s)),
  medium: (s) => Font.mediumSystemFont(px(s)),
  semibold: (s) => Font.semiboldSystemFont(px(s)),
  bold: (s) => Font.boldSystemFont(px(s)),
  italic: (s) => Font.italicSystemFont(px(s)),
  mono: (s, bold = false) => new Font(bold ? "Menlo-Bold" : "Menlo", px(s)),
};

// ─── Formattazione importi ───
function formatAmount(n) {
  const s = Math.abs(n).toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (n < 0 ? "−" : "") + s;
}

// Data di oggi nel fuso del telefono (YYYY-MM-DD). Va mandata al server:
// se la lasciamo decidere a lui usa la data UTC, e un'uscita registrata
// dopo mezzanotte in Italia finirebbe sul giorno prima.
function localDateStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Font della cifra/maschera. In stato nascosto NON usiamo Menlo: in un
// font monospace ogni carattere occupa una cella a larghezza fissa, e i
// pallini "•" (glifi stretti) finiscono isolati con vuoti evidenti tra
// loro — è quello che si vede nello screenshot. Il font di sistema li
// raggruppa in modo compatto, come i puntini di un codice di sblocco.
function amountFont(size, bold = false) {
  if (hidden) return bold ? F.bold(size) : F.semibold(size);
  return F.mono(size, bold);
}

// Costruisce un importo come mini-stack orizzontale: cifra (o maschera) +
// simbolo € leggermente più piccolo e attenuato affiancato, invece di
// un'unica stringa "1.234,56 €" — dà più gerarchia e risolve il problema
// del vuoto tra maschera e simbolo.
function addAmount(container, n, { color = TEXT, size = 11, bold = false, gap = 3, euroSize, euroOpacity = 0.55 } = {}) {
  const stack = container.addStack();
  stack.centerAlignContent();

  const amtText = stack.addText(hidden ? "••••" : formatAmount(n));
  amtText.textColor = color;
  amtText.font = amountFont(size * AMOUNT_SCALE, bold);
  amtText.lineLimit = 1;
  // Se la cifra non entra, iOS la rimpicciolisce fino a questo fattore invece
  // di troncarla: tienilo alto, altrimenti annulla l'ingrandimento.
  amtText.minimumScaleFactor = 0.8;

  stack.addSpacer(gap);

  const euroText = stack.addText("€");
  euroText.textColor = new Color(color.hex, euroOpacity);
  euroText.font = F.medium((euroSize || Math.max(9, Math.round(size * 0.75))) * AMOUNT_SCALE);
  euroText.lineLimit = 1;

  return stack;
}

async function fetchData() {
  const req = new Request(WIDGET_URL);
  req.timeoutInterval = 15;
  return await req.loadJSON();
}

// Il server risponde agli errori con { error: { code, message } }: estrae il
// testo invece di mostrare "[object Object]".
function errorMessage(res) {
  const e = res && res.error;
  if (!e) return null;
  return typeof e === "string" ? e : (e.message || e.code || "Errore");
}

// ─── Testo "tra quanto" e riga "in arrivo" (come la card della Home) ───
function whenLabel(days) {
  if (days <= 0) return "oggi";
  if (days === 1) return "domani";
  return `tra ${days} giorni`;
}

// ─── Piccoli helper per i picker a schermata (action sheet) ───
// Ritorna l'elemento scelto da `items` (oggetti con .label), o null se
// annullato / "Nessuno". `items` può essere vuoto: in quel caso si salta.
async function pickOne(title, items, { allowNone = true, noneLabel = "Nessuno" } = {}) {
  if (items.length === 0) return null;
  const a = new Alert();
  a.title = title;
  for (const it of items) a.addAction(it.label);
  if (allowNone) a.addAction(noneLabel);
  a.addCancelAction("Annulla");
  const idx = await a.presentSheet();
  if (idx === -1) return "CANCEL";
  if (allowNone && idx === items.length) return null; // "Nessuno"
  return items[idx];
}

// ─── Divisione equa, con l'ultima quota che assorbe l'arrotondamento ───
function equalSplits(persone) {
  const quota = Math.round((100 / persone.length) * 100) / 100;
  return persone.map((p, i) => ({
    personaId: p.id,
    quota: i === persone.length - 1 ? Math.round((100 - quota * (persone.length - 1)) * 100) / 100 : quota,
  }));
}

// ─── "Come l'ultima volta?" ───
// Ricostruisce dalle ultime scelte salvate quelle ancora valide (una persona
// o un conto cancellati nel frattempo non vanno riproposti). Ritorna null se
// non c'è niente da riproporre, altrimenti { choice, summary }.
function rememberedChoice(tipo, last, meta) {
  const memo = last && last[tipo];
  if (!memo) return null;
  const persone = meta.persone || [];
  const conti = meta.contiCompleti || [];
  const persona = (id) => persone.find(p => p.id === id);
  const conto = memo.contoId ? conti.find(c => c.id === memo.contoId) : null;
  const choice = { contoId: conto ? conto.id : null };
  const parts = [];

  if (tipo === "uscita") {
    const pagante = memo.pagatoDa ? persona(memo.pagatoDa) : null;
    if (pagante) {
      choice.pagatoDa = pagante.id;
      parts.push(`Paga: ${pagante.emoji || "👤"} ${pagante.nome}`);
      if (memo.split === "equa" && persone.length > 1) {
        choice.split = "equa";
        parts.push(`Divisa equamente tra tutti (${persone.length})`);
      } else {
        parts.push("Solo sua");
      }
    } else {
      parts.push("Personale");
    }
  } else {
    const intestatario = memo.intestataA ? persona(memo.intestataA) : null;
    if (intestatario) {
      choice.intestataA = intestatario.id;
      parts.push(`Intestata a: ${intestatario.emoji || "👤"} ${intestatario.nome}`);
    }
  }
  if (conto) parts.push(`Conto: ${conto.icona || "🏦"} ${conto.nome}`);
  else if (conti.length > 0) parts.push("Nessun conto");
  if (parts.length === 0) return null;
  return { choice, summary: parts.join("\n") };
}

// Domande dettagliate: chi ha pagato / divisione / conto (o intestatario / conto).
// Ritorna { pagatoDa, split, intestataA, contoId } oppure "CANCEL".
async function askDetails(tipo, meta) {
  const choice = { contoId: null };
  const persone = meta.persone || [];

  if (tipo === "uscita") {
    const pagante = await pickOne("Chi ha pagato?", persone.map(p => ({ label: `${p.emoji || "👤"} ${p.nome}`, id: p.id })), { allowNone: true, noneLabel: "Nessuno (personale)" });
    if (pagante === "CANCEL") return "CANCEL";
    if (pagante) {
      choice.pagatoDa = pagante.id;
      // Divisione, solo se c'è più di una persona in casa
      if (persone.length > 1) {
        const divisione = await pickOne("Dividere la spesa?", [
          { label: "No, è solo mia", tipo: "solo" },
          { label: `Sì, equamente tra tutti (${persone.length})`, tipo: "equa" },
        ], { allowNone: false });
        if (divisione === "CANCEL") return "CANCEL";
        if (divisione && divisione.tipo === "equa") choice.split = "equa";
      }
    }
  } else {
    const intestatario = await pickOne("Intestata a chi?", persone.map(p => ({ label: `${p.emoji || "👤"} ${p.nome}`, id: p.id })), { allowNone: true, noneLabel: "Nessuno" });
    if (intestatario === "CANCEL") return "CANCEL";
    if (intestatario) choice.intestataA = intestatario.id;
  }

  // Conto (comune a entrambi i tipi)
  const conti = meta.contiCompleti || [];
  if (conti.length > 0) {
    const conto = await pickOne("Su quale conto?", conti.map(c => ({ label: `${c.icona || "🏦"} ${c.nome}`, id: c.id })), { allowNone: true, noneLabel: "Nessuno" });
    if (conto === "CANCEL") return "CANCEL";
    if (conto) choice.contoId = conto.id;
  }
  return choice;
}

// Invio con Idempotency-Key: se la rete cade dopo che il server ha già
// registrato la transazione, il tentativo successivo con la STESSA chiave
// riceve la risposta originale invece di creare un doppione. Alla prima
// caduta di rete chiede se riprovare.
async function submitTransaction(payload) {
  const idemKey = UUID.string();
  for (;;) {
    try {
      const req = new Request(TRANSACTION_URL);
      req.method = "POST";
      req.timeoutInterval = 15;
      req.headers = { "Content-Type": "application/json", "Idempotency-Key": idemKey };
      req.body = JSON.stringify(payload);
      const res = await req.loadJSON();
      const msg = errorMessage(res);
      if (msg) throw Object.assign(new Error(msg), { fromServer: true });
      return;
    } catch (e) {
      if (e.fromServer) throw e; // rifiutata dal server: riprovare non cambia nulla
      const retry = new Alert();
      retry.title = "Connessione assente";
      retry.message = "Non so se è stata registrata. Riprovare? (Non verrà duplicata.)";
      retry.addAction("Riprova");
      retry.addCancelAction("Annulla");
      if ((await retry.presentAlert()) === -1) throw e;
    }
  }
}

// ─── Modulo rapido: importo + descrizione, poi dettagli in base al tipo ───
async function promptAndSubmit(tipo, meta) {
  const a = new Alert();
  a.title = tipo === "uscita" ? "➖ Nuova uscita" : "➕ Nuova entrata";
  a.message = "Importo in euro (usa la virgola o il punto)";
  a.addTextField("Es. 12,50", "");
  a.addTextField("Descrizione (opzionale)", "");
  a.addAction("Continua");
  a.addCancelAction("Annulla");
  const idx = await a.presentAlert();
  if (idx === -1) return;

  const raw = a.textFieldValue(0);
  const importo = parseFloat(String(raw).replace(",", "."));
  if (!isFinite(importo) || importo <= 0) {
    const err = new Alert();
    err.title = "Importo non valido";
    err.message = "Inserisci un numero maggiore di zero.";
    err.addAction("OK");
    await err.presentAlert();
    return;
  }
  const descrizione = a.textFieldValue(1) || "";

  const payload = { tipo, importo, descrizione, data: localDateStr() };

  // Categoria (solo uscite): sempre chiesta — come nell'app, non la si
  // ripropone di default perché una categoria sbagliata passa inosservata.
  if (tipo === "uscita") {
    const cat = await pickOne("Categoria", (meta.categorie || []).map(c => ({ label: `${c.emoji || "📦"} ${c.nome}`, id: c.id })), { allowNone: true, noneLabel: "Altro" });
    if (cat === "CANCEL") return;
    if (cat) payload.categoria = cat.id;
  }

  // Chi / divisione / conto: se ci sono scelte salvate valide, un tocco.
  let choice = null;
  const remembered = rememberedChoice(tipo, loadState().last, meta);
  if (remembered) {
    const ask = new Alert();
    ask.title = "Come l'ultima volta?";
    ask.message = remembered.summary;
    ask.addAction("Salva così");
    ask.addAction("Cambia");
    ask.addCancelAction("Annulla");
    const r = await ask.presentAlert();
    if (r === -1) return;
    if (r === 0) choice = remembered.choice;
  }
  if (!choice) {
    choice = await askDetails(tipo, meta);
    if (choice === "CANCEL") return;
  }

  if (choice.pagatoDa) {
    payload.pagatoDa = choice.pagatoDa;
    if (choice.split === "equa") payload.splits = equalSplits(meta.persone || []);
  }
  if (choice.intestataA) payload.intestataA = choice.intestataA;
  if (choice.contoId) payload.contoId = choice.contoId;

  try {
    await submitTransaction(payload);
    // Ricorda le scelte solo dopo un salvataggio riuscito
    const last = { ...(loadState().last || {}) };
    last[tipo] = tipo === "uscita"
      ? { pagatoDa: choice.pagatoDa || null, split: choice.split || null, contoId: choice.contoId || null }
      : { intestataA: choice.intestataA || null, contoId: choice.contoId || null };
    saveState({ last });

    const ok = new Alert();
    ok.title = "✅ Registrata";
    ok.message = `${tipo === "uscita" ? "Uscita" : "Entrata"} di ${importo.toLocaleString("it-IT", { minimumFractionDigits: 2 })} €${descrizione ? " — " + descrizione : ""}`;
    ok.addAction("OK");
    await ok.presentAlert();
  } catch (e) {
    const err = new Alert();
    err.title = "Errore di salvataggio";
    err.message = e.message || "Controlla la connessione e riprova.";
    err.addAction("OK");
    await err.presentAlert();
  }
}

// ─── Layout ───
// Stessa struttura della Home dell'app, in blocchi che si ripetono uguali:
//   barra in alto → PATRIMONIO (cifra grande) → card "Questo mese" →
//   card "Conti" → pulsanti. Ogni card ha un titolo a sinistra, un dato a
//   destra, e al massimo tre righe/colonne allineate; le sezioni dentro una
//   card sono separate da un filetto. Scale dei testi: 28 (patrimonio),
//   15 (cifre del mese), 13 (righe conti), 9-12 (etichette e note).

// Icone SF Symbols (incluse in iOS) al posto delle emoji: stessa famiglia,
// colorabili. Se un simbolo non esiste su quella versione di iOS, l'icona
// semplicemente non appare (il testo resta).
function addIcon(container, symbolName, color, size = 13) {
  const sym = SFSymbol.named(symbolName);
  if (!sym) return null;
  sym.applyFont(F.regular(size));
  const img = container.addImage(sym.image);
  img.tintColor = color;
  img.imageSize = new Size(px(size), px(size));
  return img;
}

// L'app salva l'icona del conto come chiave ("bank", "cash"...) oppure,
// per i conti più vecchi, come emoji: si accettano entrambe.
const ACCOUNT_SYMBOLS = {
  bank: "building.columns", "🏦": "building.columns",
  card: "creditcard", "💳": "creditcard",
  cash: "banknote", "💵": "banknote", "💶": "banknote", "💰": "banknote",
  piggy: "dollarsign.circle", "🐷": "dollarsign.circle",
  mobile: "iphone", "📱": "iphone",
  wallet: "wallet.pass", "👛": "wallet.pass",
};
const accountSymbol = (icona) => ACCOUNT_SYMBOLS[icona] || "building.columns";

// Filetto orizzontale tra due sezioni di una card. Lo spacer lo rende
// "avido" in larghezza (stesso meccanismo dei pulsanti più sotto).
function addHairline(container) {
  const line = container.addStack();
  line.size = new Size(0, 1);
  line.backgroundColor = new Color("#ffffff", 0.08);
  line.addSpacer();
}

function addCard(parent) {
  const card = parent.addStack();
  card.layoutVertically();
  card.backgroundColor = new Color("#ffffff", 0.06);
  card.borderColor = new Color("#ffffff", 0.08);
  card.borderWidth = 1;
  card.cornerRadius = 12;
  card.setPadding(8, 10, 8, 10);
  return card;
}

// Intestazione di card: titolo a sinistra, un dato a destra (aggiunto dal
// chiamante nello stack restituito, dopo lo spacer).
function addCardHeader(card, title) {
  const row = card.addStack();
  row.centerAlignContent();
  const t = row.addText(title);
  t.textColor = MUTED; t.font = F.bold(10);
  row.addSpacer();
  return row;
}

// Una colonna dei tre dati del mese: etichetta piccola sopra, cifra sotto.
function addStat(parent, label, n, color) {
  const col = parent.addStack();
  col.layoutVertically();
  const labelRow = col.addStack();
  const l = labelRow.addText(label);
  l.textColor = MUTED; l.font = F.semibold(9);
  labelRow.addSpacer(); // rende la colonna "avida": le tre colonne si dividono lo spazio in parti uguali
  col.addSpacer(2);
  addAmount(col, n, { color, size: 15, bold: true, gap: 3, euroSize: 10, euroOpacity: 0.55 });
  return col;
}

// Riga di un conto: icona, nome, saldo allineato a destra.
function addAccountRow(card, { symbol, nome, saldo, nomeColor = TEXT_SOFT, amountColor }) {
  const row = card.addStack();
  row.centerAlignContent();
  addIcon(row, symbol, MUTED, 13);
  row.addSpacer(7);
  const t = row.addText(nome);
  t.textColor = nomeColor; t.font = F.regular(12); t.lineLimit = 1;
  row.addSpacer();
  addAmount(row, saldo, { color: amountColor, size: 13, gap: 3, euroSize: 10 });
  return row;
}

// Conti in ordine di saldo; con più di 3 si mostrano i primi 2 e il resto in
// una riga sola "Altri N conti" col totale, così nessun conto sparisce in
// silenzio e la card non cresce.
function summarizeAccounts(conti) {
  const sorted = [...conti].sort((a, b) => b.saldo - a.saldo);
  const total = Math.round(sorted.reduce((s, c) => s + c.saldo, 0) * 100) / 100;
  if (sorted.length <= 3) return { rows: sorted, rest: null, total };
  const rest = sorted.slice(2);
  return {
    rows: sorted.slice(0, 2),
    rest: { count: rest.length, saldo: Math.round(rest.reduce((s, c) => s + c.saldo, 0) * 100) / 100 },
    total,
  };
}

async function buildWidget(dataOverride) {
  const w = new ListWidget();
  w.backgroundGradient = bgGradient();
  w.setPadding(14, 14, 14, 14);

  if (!WIDGET_URL || WIDGET_URL.includes("INCOLLA_QUI")) {
    const t = w.addText("Configura WIDGET_URL nello script");
    t.textColor = RED; t.font = F.medium(12);
    return { widget: w, data: null };
  }

  let data = dataOverride;
  if (!data) {
    try {
      data = await fetchData();
      const msg = errorMessage(data);
      if (msg) throw new Error(msg);
    } catch (e) {
      const t = w.addText("⚠️ " + (e.message || "Errore rete"));
      t.textColor = RED; t.font = F.medium(12);
      const hint = w.addText("Verifica la chiave in Impostazioni → Widget");
      hint.textColor = MUTED; hint.font = F.regular(10);
      return { widget: w, data: null };
    }
  }

  // ── Barra in alto: identità a sinistra, ora + azioni a destra ──
  const topBar = w.addStack();
  topBar.centerAlignContent();
  addIcon(topBar, "eurosign.circle", MUTED, 14);
  topBar.addSpacer(8);
  const brand = topBar.addText("FINANZA");
  brand.textColor = MUTED; brand.font = F.bold(12);
  topBar.addSpacer(); // spinge il resto a destra

  const ora = topBar.addText(new Date(data.aggiornato).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" }));
  ora.textColor = MUTED; ora.font = F.regular(9);

  topBar.addSpacer(10);
  const eyeStack = topBar.addStack();
  eyeStack.url = RUN_URL("toggle=1");
  addIcon(eyeStack, hidden ? "eye.slash" : "eye", MUTED, 15);

  if (APP_URL) {
    topBar.addSpacer(8);
    const openStack = topBar.addStack();
    openStack.url = APP_URL;
    addIcon(openStack, "arrow.up.right", PURPLE, 15);
  }

  w.addSpacer(7);

  // ── Cifra principale ──
  const patLabel = w.addText("PATRIMONIO");
  patLabel.textColor = MUTED; patLabel.font = F.semibold(11);
  w.addSpacer(2);
  addAmount(w, data.patrimonio, { color: TEXT, size: 28, bold: true, gap: 6, euroSize: 16, euroOpacity: 0.45 });

  w.addSpacer(7);

  // ── Card "Questo mese": Uscite / Entrate / Saldo + prossima scadenza ──
  const monthCard = addCard(w);

  // Titolo a sinistra; a destra il confronto col mese scorso (stesso periodo,
  // come nella Home). deltaPct è null senza storico e assente con un server
  // più vecchio: in entrambi i casi la pillola non c'è.
  const monthHeader = addCardHeader(monthCard, "QUESTO MESE");
  if (typeof data.deltaPct === "number") {
    const tone = data.deltaPct > 0 ? AMBER : data.deltaPct < 0 ? GREEN : MUTED; // più spesa = attenzione
    const pill = monthHeader.addStack();
    pill.backgroundColor = new Color(tone.hex, 0.14);
    pill.cornerRadius = 10;
    pill.setPadding(2, 7, 2, 7);
    const arrow = data.deltaPct > 0 ? "↑" : data.deltaPct < 0 ? "↓" : "=";
    const delta = pill.addText(`${arrow} ${Math.abs(data.deltaPct)}% vs mese scorso`);
    delta.textColor = tone; delta.font = F.semibold(9);
    delta.lineLimit = 1; delta.minimumScaleFactor = 0.7;
  }
  monthCard.addSpacer(6);

  const saldoMese = Math.round((data.entrateMese - data.speseMese) * 100) / 100;
  const stats = monthCard.addStack();
  addStat(stats, "USCITE", data.speseMese, RED);
  for (const [label, n, tone] of [["ENTRATE", data.entrateMese, GREEN], ["SALDO", saldoMese, saldoMese < 0 ? RED : GREEN]]) {
    stats.addSpacer(6);
    const divider = stats.addStack(); // filetto verticale tra le colonne
    divider.size = new Size(1, px(30 * AMOUNT_SCALE));
    divider.backgroundColor = new Color("#ffffff", 0.08);
    stats.addSpacer(6);
    addStat(stats, label, n, tone);
  }

  // Prossima scadenza ricorrente, sotto un filetto: una riga sola, il widget
  // non ha spazio per l'elenco completo dell'app.
  const prossime = data.inArrivo || [];
  if (prossime.length > 0) {
    const b = prossime[0];
    monthCard.addSpacer(7);
    addHairline(monthCard);
    monthCard.addSpacer(7);
    const dueRow = monthCard.addStack();
    dueRow.centerAlignContent();
    addIcon(dueRow, "calendar", b.days <= 1 ? AMBER : MUTED, 12);
    dueRow.addSpacer(6);
    const dueName = dueRow.addText(b.descrizione || "Scadenza");
    dueName.textColor = TEXT; dueName.font = F.regular(11); dueName.lineLimit = 1;
    dueRow.addSpacer(4);
    const dueWhen = dueRow.addText(`· ${whenLabel(b.days)}`);
    dueWhen.textColor = b.days <= 1 ? AMBER : MUTED; dueWhen.font = F.regular(10);
    dueRow.addSpacer();
    addAmount(dueRow, b.importo, { color: TEXT, size: 12, euroSize: 9 });
    const altre = (data.inArrivoTotale || prossime.length) - 1;
    if (altre > 0) {
      dueRow.addSpacer(4);
      const more = dueRow.addText(`+${altre} altre`);
      more.textColor = MUTED; more.font = F.regular(9);
    }
  }

  w.addSpacer(7);

  // ── Card "Conti": totale nel titolo (Patrimonio = Conti + Investimenti) ──
  const conti = data.conti || [];
  if (conti.length > 0 || data.investimenti > 0) {
    const card = addCard(w);
    const summary = summarizeAccounts(conti);

    const header = addCardHeader(card, "CONTI");
    if (conti.length > 0) addAmount(header, summary.total, { color: MUTED, size: 10.5, gap: 2, euroSize: 9, euroOpacity: 0.7 });
    card.addSpacer(6);

    summary.rows.forEach((c, i) => {
      if (i > 0) card.addSpacer(4);
      addAccountRow(card, { symbol: accountSymbol(c.icona), nome: c.nome, saldo: c.saldo, amountColor: c.saldo >= 0 ? GREEN : RED });
    });
    if (summary.rest) {
      card.addSpacer(4);
      addAccountRow(card, {
        symbol: "square.stack.3d.up", nome: `Altri ${summary.rest.count} conti`, saldo: summary.rest.saldo,
        nomeColor: MUTED, amountColor: summary.rest.saldo >= 0 ? new Color(GREEN.hex, 0.8) : RED,
      });
    }

    if (data.investimenti > 0) {
      card.addSpacer(6);
      addHairline(card);
      card.addSpacer(6);
      addAccountRow(card, { symbol: "chart.line.uptrend.xyaxis", nome: "Investimenti", saldo: data.investimenti, amountColor: PURPLE });
    }
  }

  w.addSpacer(); // lo spazio che avanza va qui: i pulsanti restano sempre in fondo

  // ── Pulsanti di aggiunta rapida, larghezza uguale ──
  const actions = w.addStack();
  actions.spacing = 8;

  // Ogni pulsante contiene uno spacer flessibile (addSpacer senza argomenti):
  // rende il contenitore "avido" di spazio, e due pulsanti ugualmente avidi,
  // fratelli nella stessa riga, si dividono lo spazio rimanente in parti
  // uguali — a differenza di size=(0,altezza), che si limita ad adattarsi al
  // contenuto (da cui i pulsanti striminziti di una versione precedente).
  function addActionButton(label, symbol, tone, runParams) {
    const s = actions.addStack();
    s.url = RUN_URL(runParams);
    s.backgroundColor = new Color(tone.hex, 0.12);
    s.borderColor = new Color(tone.hex, 0.25);
    s.borderWidth = 1;
    s.cornerRadius = 10;
    s.setPadding(8, 10, 8, 10);
    s.centerAlignContent();
    s.addSpacer();
    addIcon(s, symbol, tone, 12);
    s.addSpacer(6);
    const txt = s.addText(label);
    txt.textColor = tone; txt.font = F.bold(12);
    s.addSpacer();
  }
  addActionButton("Uscita", "minus", RED, "add=uscita");
  addActionButton("Entrata", "plus", GREEN, "add=entrata");

  return { widget: w, data };
}


const { widget, data } = await buildWidget();

if (config.runsInWidget) {
  Script.setWidget(widget);
} else if (qp.add === "uscita" || qp.add === "entrata") {
  if (!TRANSACTION_URL || !data) {
    const err = new Alert(); err.title = "Impossibile procedere"; err.message = "Configura WIDGET_URL o verifica la connessione."; err.addAction("OK"); await err.presentAlert();
  } else {
    await promptAndSubmit(qp.add, data); // data include già persone, categorie, contiCompleti
    const refreshed = await buildWidget(); // ricarica per mostrare i totali aggiornati
    await refreshed.widget.presentMedium();
  }
} else if (config.runsInApp) {
  // Tocco sull'occhio, o esecuzione manuale dall'editor: anteprima aggiornata
  await widget.presentMedium();
} else if (APP_URL) {
  Safari.open(APP_URL);
}
Script.complete();
