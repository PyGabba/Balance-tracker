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
// Novità: nella card "Questo mese" ora c'è il confronto con il mese scorso
// (stesso periodo) e la prossima scadenza ricorrente, come nella Home dell'app.

const WIDGET_URL = "https://INCOLLA_QUI/api/widget?key=INCOLLA_LA_TUA_CHIAVE";
const SCRIPT_NAME = "Finanza"; // deve combaciare col nome dato allo script al passo 2

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
const GREEN = new Color("#4ECDC4");
const RED = new Color("#FF6B6B");
const AMBER = new Color("#F0A500");
const PURPLE = new Color("#a78bfa");

// ─── Formattazione importi ───
function formatAmount(n) {
  const s = Math.abs(n).toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (n < 0 ? "-" : "") + s;
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
  if (hidden) return bold ? Font.boldSystemFont(size) : Font.semiboldSystemFont(size);
  return new Font(bold ? "Menlo-Bold" : "Menlo", size);
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
  amtText.font = amountFont(size, bold);
  amtText.lineLimit = 1;
  amtText.minimumScaleFactor = 0.6;

  stack.addSpacer(gap);

  const euroText = stack.addText("€");
  euroText.textColor = new Color(color.hex, euroOpacity);
  euroText.font = Font.mediumSystemFont(euroSize || Math.max(9, Math.round(size * 0.75)));
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
// Struttura visiva: barra in alto (identità + azioni) → cifra grande del
// patrimonio → card "Conti" → card "Mese" → riga di pulsanti azione, a
// larghezza uguale. Ogni sezione è raggruppata in un contenitore proprio
// invece di righe sciolte, per leggerla a colpo d'occhio sul widget piccolo.
async function buildWidget(dataOverride) {
  const w = new ListWidget();
  w.backgroundGradient = bgGradient();
  w.setPadding(14, 14, 14, 14);

  if (!WIDGET_URL || WIDGET_URL.includes("INCOLLA_QUI")) {
    const t = w.addText("Configura WIDGET_URL nello script");
    t.textColor = RED; t.font = Font.mediumSystemFont(12);
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
      t.textColor = RED; t.font = Font.mediumSystemFont(12);
      const hint = w.addText("Verifica la chiave in Impostazioni → Widget");
      hint.textColor = MUTED; hint.font = Font.systemFont(10);
      return { widget: w, data: null };
    }
  }

  // ── Barra in alto: identità a sinistra, azioni a destra ──
  const topBar = w.addStack();
  topBar.centerAlignContent();
  const brand = topBar.addText("💰 FINANZA");
  brand.textColor = MUTED; brand.font = Font.boldSystemFont(12);
  topBar.addSpacer(); // spinge il resto a destra

  const ora = topBar.addText(new Date(data.aggiornato).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" }));
  ora.textColor = MUTED; ora.font = Font.systemFont(9);

  topBar.addSpacer(10);
  const eyeStack = topBar.addStack();
  eyeStack.url = RUN_URL("toggle=1");
  const eye = eyeStack.addText(hidden ? "🙈" : "👁");
  eye.font = Font.systemFont(13);

  if (APP_URL) {
    topBar.addSpacer(8);
    const openStack = topBar.addStack();
    openStack.url = APP_URL;
    const open = openStack.addText("↗");
    open.font = Font.boldSystemFont(13);
    open.textColor = PURPLE;
  }

  w.addSpacer(10);

  // ── Cifra principale ──
  const patLabel = w.addText("PATRIMONIO");
  patLabel.textColor = MUTED; patLabel.font = Font.mediumSystemFont(12);
  w.addSpacer(3);
  // Cifra grande + simbolo € più piccolo e attenuato accanto (non più
  // un'unica stringa monospace: risolve il vuoto visibile tra i pallini
  // e l'€ quando gli importi sono nascosti, e dà più gerarchia sempre).
  addAmount(w, data.patrimonio, { color: TEXT, size: 26, bold: true, gap: 6, euroSize: 16, euroOpacity: 0.45 });

  w.addSpacer(10);

  // ── Card "Conti" (conti bancari + investimenti raggruppati) ──
  const conti = data.conti || [];
  if (conti.length > 0 || data.investimenti > 0) {
    const card = w.addStack();
    card.layoutVertically();
    card.backgroundColor = new Color("#ffffff", 0.06);
    card.borderColor = new Color("#ffffff", 0.08);
    card.borderWidth = 1;
    card.cornerRadius = 12;
    card.setPadding(9, 10, 9, 10);

    const cardLabel = card.addText("CONTI");
    cardLabel.textColor = MUTED; cardLabel.font = Font.boldSystemFont(10);
    card.addSpacer(6);

    for (const c of conti.slice(0, 3)) {
      const row = card.addStack();
      row.centerAlignContent();
      const nome = row.addText(`${c.icona} ${c.nome}`);
      nome.textColor = MUTED; nome.font = Font.systemFont(12); nome.lineLimit = 1;
      row.addSpacer();
      addAmount(row, c.saldo, { color: c.saldo >= 0 ? GREEN : RED, size: 15 });
      card.addSpacer(6);
    }

    // Se ci sono più di 3 conti, non spariscono in silenzio: un accenno
    // in piccolo segnala quanti restano fuori dallo spazio del widget.
    if (conti.length > 3) {
      const more = card.addText(`+ ${conti.length - 3} altri conti`);
      more.textColor = MUTED; more.font = Font.italicSystemFont(9);
      card.addSpacer(4);
    }

    if (data.investimenti > 0) {
      const row = card.addStack();
      row.centerAlignContent();
      const nome = row.addText("📈 Investimenti");
      nome.textColor = MUTED; nome.font = Font.systemFont(12);
      row.addSpacer();
      addAmount(row, data.investimenti, { color: PURPLE, size: 15 });
    }

    w.addSpacer(8);
  }

  // ── Card "Mese corrente" ──
  const monthCard = w.addStack();
  monthCard.layoutVertically();
  monthCard.backgroundColor = new Color("#ffffff", 0.06);
  monthCard.borderColor = new Color("#ffffff", 0.08);
  monthCard.borderWidth = 1;
  monthCard.cornerRadius = 12;
  monthCard.setPadding(9, 10, 9, 10);

  // Intestazione: titolo a sinistra, confronto col mese scorso a destra
  // (stesso periodo, come nella Home dell'app). deltaPct è null senza storico
  // e assente con un server più vecchio: in entrambi i casi non si mostra.
  const monthHeader = monthCard.addStack();
  monthHeader.centerAlignContent();
  const monthLabel = monthHeader.addText("QUESTO MESE");
  monthLabel.textColor = MUTED; monthLabel.font = Font.boldSystemFont(10);
  if (typeof data.deltaPct === "number") {
    monthHeader.addSpacer();
    const arrow = data.deltaPct > 0 ? "↑" : data.deltaPct < 0 ? "↓" : "=";
    const delta = monthHeader.addText(`${arrow} ${Math.abs(data.deltaPct)}% vs mese scorso`);
    // Più spesa = ambra (attenzione), meno = verde
    delta.textColor = data.deltaPct > 0 ? AMBER : data.deltaPct < 0 ? GREEN : MUTED;
    delta.font = Font.semiboldSystemFont(9);
    delta.lineLimit = 1;
    delta.minimumScaleFactor = 0.7;
  }
  monthCard.addSpacer(6);

  const monthRow = monthCard.addStack();
  monthRow.centerAlignContent();

  // Uscite del mese, in un chip colorato coerente con il pulsante "Uscita"
  const speseChip = monthRow.addStack();
  speseChip.centerAlignContent();
  speseChip.backgroundColor = new Color("#FF6B6B", 0.12);
  speseChip.borderColor = new Color("#FF6B6B", 0.2);
  speseChip.borderWidth = 1;
  speseChip.cornerRadius = 8;
  speseChip.setPadding(5, 8, 5, 8);
  const speseIcon = speseChip.addText("▼");
  speseIcon.textColor = RED; speseIcon.font = Font.systemFont(10);
  speseChip.addSpacer(4);
  addAmount(speseChip, data.speseMese, { color: RED, size: 11 });

  monthRow.addSpacer();

  // Entrate del mese, chip coerente col pulsante "Entrata"
  const entrataChip = monthRow.addStack();
  entrataChip.centerAlignContent();
  entrataChip.backgroundColor = new Color("#4ECDC4", 0.12);
  entrataChip.borderColor = new Color("#4ECDC4", 0.2);
  entrataChip.borderWidth = 1;
  entrataChip.cornerRadius = 8;
  entrataChip.setPadding(5, 8, 5, 8);
  const entrataIcon = entrataChip.addText("▲");
  entrataIcon.textColor = GREEN; entrataIcon.font = Font.systemFont(10);
  entrataChip.addSpacer(4);
  addAmount(entrataChip, data.entrateMese, { color: GREEN, size: 11 });

  // Prossima scadenza ricorrente (affitto, abbonamenti…), una riga sola:
  // il widget Medio non ha spazio per l'elenco completo dell'app.
  const prossime = data.inArrivo || [];
  if (prossime.length > 0) {
    const b = prossime[0];
    monthCard.addSpacer(7);
    const dueRow = monthCard.addStack();
    dueRow.centerAlignContent();
    const dueName = dueRow.addText(`${b.emoji || "📅"} ${b.descrizione || "Scadenza"} · ${whenLabel(b.days)}`);
    dueName.textColor = b.days <= 1 ? AMBER : MUTED;
    dueName.font = Font.systemFont(10);
    dueName.lineLimit = 1;
    dueRow.addSpacer();
    addAmount(dueRow, b.importo, { color: TEXT, size: 11 });
    const altre = (data.inArrivoTotale || prossime.length) - 1;
    if (altre > 0) {
      dueRow.addSpacer(4);
      const more = dueRow.addText(`+${altre}`);
      more.textColor = MUTED; more.font = Font.systemFont(9);
    }
  }

  w.addSpacer(10);

  // ── Pulsanti di aggiunta rapida, larghezza uguale ──
  const actions = w.addStack();
  actions.spacing = 8;

  // Ogni pulsante contiene uno spacer flessibile (addSpacer senza argomenti):
  // è lo stesso meccanismo che rende piene le card "Conti"/"Mese" sopra (le
  // loro righe interne usano lo stesso trucco per spingere il valore a
  // destra). Uno spacer flessibile rende il contenitore "avido" di spazio;
  // due pulsanti ugualmente avidi, fratelli nella stessa riga, si dividono
  // lo spazio rimanente in parti uguali — a differenza di size=(0,altezza),
  // che invece si limita ad adattarsi al contenuto (da qui i pulsanti
  // striminziti nello screenshot).
  const uscitaStack = actions.addStack();
  uscitaStack.url = RUN_URL("add=uscita");
  uscitaStack.backgroundColor = new Color("#FF6B6B", 0.12);
  uscitaStack.borderColor = new Color("#FF6B6B", 0.25);
  uscitaStack.borderWidth = 1;
  uscitaStack.cornerRadius = 10;
  uscitaStack.setPadding(8, 10, 8, 10);
  uscitaStack.centerAlignContent();
  uscitaStack.addSpacer();
  const uscitaTxt = uscitaStack.addText("➖ Uscita");
  uscitaTxt.textColor = RED; uscitaTxt.font = Font.boldSystemFont(12);
  uscitaStack.addSpacer();

  const entrataStack = actions.addStack();
  entrataStack.url = RUN_URL("add=entrata");
  entrataStack.backgroundColor = new Color("#4ECDC4", 0.12);
  entrataStack.borderColor = new Color("#4ECDC4", 0.25);
  entrataStack.borderWidth = 1;
  entrataStack.cornerRadius = 10;
  entrataStack.setPadding(8, 10, 8, 10);
  entrataStack.centerAlignContent();
  entrataStack.addSpacer();
  const entrataTxt = entrataStack.addText("➕ Entrata");
  entrataTxt.textColor = GREEN; entrataTxt.font = Font.boldSystemFont(12);
  entrataStack.addSpacer();

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
