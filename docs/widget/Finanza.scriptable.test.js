import { it } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

// Runs docs/widget/Finanza.scriptable.js against a small mock of the
// Scriptable runtime (it only exists on iOS, so this is the only place the
// script's logic is exercised): widget rendering with the dashboard fields,
// the quick-add form and its "same as last time" memory, idempotent retries,
// server errors, stale memory and the hide toggle.
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "finanza-widget-"));
const SCRIPT_PATH = fileURLToPath(new URL("./Finanza.scriptable.js", import.meta.url));

const SRC = fs.readFileSync(SCRIPT_PATH, "utf8")
  .replace('"https://INCOLLA_QUI/api/widget?key=INCOLLA_LA_TUA_CHIAVE"', '"https://example.test/api/widget?key=TESTKEY"');
fs.writeFileSync(`${OUT}/script_under_test.mjs`, SRC);

// ── Scriptable runtime mock ──
const files = new Map();
let responses = [], shown = [], requests = [], handler, widgetTexts = [], widgetTextObjs = [], widgetSymbols = [], completed = false;
class Color { constructor(hex, a) { this.hex = hex; this.alpha = a; } }
class LinearGradient {}
class Font { constructor(n, s) { this.n = n; this.s = s; } static boldSystemFont(s) { return new Font("bold", s); } static semiboldSystemFont(s) { return new Font("semibold", s); } static mediumSystemFont(s) { return new Font("medium", s); } static systemFont(s) { return new Font("sys", s); } static italicSystemFont(s) { return new Font("it", s); } }
class Node_ {
  constructor() { this.children = []; }
  addText(t) { const x = { text: t }; widgetTexts.push(t); widgetTextObjs.push(x); this.children.push(x); return x; }
  addStack() { const n = new Node_(); this.children.push(n); return n; }
  addImage(img) { const x = { symbol: img.symbol }; widgetSymbols.push(img.symbol); this.children.push(x); return x; }
  addSpacer() { this.children.push({ spacer: true }); }
  layoutVertically() {} centerAlignContent() {} setPadding() {}
}
class ListWidget extends Node_ { async presentMedium() {} }
class Request {
  constructor(url) { this.url = url; }
  async loadJSON() { requests.push({ url: this.url, method: this.method || "GET", headers: this.headers, body: this.body && JSON.parse(this.body) }); return handler(requests.at(-1)); }
}
class Alert {
  constructor() { this.actions = []; this.fields = []; }
  addAction(a) { this.actions.push(a); } addCancelAction() {} addTextField(p, v) { this.fields.push(v); }
  _next() { const r = responses.shift(); assert.ok(r, `unexpected alert: ${this.title} / ${this.message}`); shown.push({ title: this.title, message: this.message, actions: [...this.actions] }); this._r = r; return r.idx; }
  async presentAlert() { return this._next(); }
  async presentSheet() { return this._next(); }
  textFieldValue(i) { return this._r.fields?.[i] ?? ""; }
}
globalThis.Color = Color; globalThis.LinearGradient = LinearGradient; globalThis.Font = Font; globalThis.ListWidget = ListWidget; globalThis.Request = Request; globalThis.Alert = Alert;
globalThis.FileManager = { local: () => ({ documentsDirectory: () => "/docs", joinPath: (a, b) => `${a}/${b}`, fileExists: p => files.has(p), readString: p => files.get(p), writeString: (p, s) => files.set(p, s) }) };
let uuid = 0; globalThis.UUID = { string: () => `uuid-${++uuid}` };
globalThis.Script = { setWidget() {}, complete() { completed = true; } };
globalThis.Safari = { open() {} };
globalThis.Size = class Size { constructor(w, h) { this.width = w; this.height = h; } };
let missingSymbols = new Set();
globalThis.SFSymbol = { named: (name) => (missingSymbols.has(name) ? null : { image: { symbol: name }, applyFont() {} }) };

const data = {
  aggiornato: new Date().toISOString(), patrimonio: 110694.31, investimenti: 80979.23,
  conti: [
    { nome: "UniCredit", icona: "bank", saldo: 271.26 }, { nome: "BBVA", icona: "bank", saldo: 28980.17 },
    { nome: "Trade Republic", icona: "card", saldo: 59.58 }, { nome: "Revolut", icona: "📱", saldo: 404.07 },
  ],
  contiCompleti: [{ id: "c1", nome: "Banca", icona: "🏦" }, { id: "c2", nome: "Contanti", icona: "💶" }],
  persone: [{ id: "g", nome: "Gabriele", emoji: "🧔" }, { id: "l", nome: "Laura", emoji: "👩" }],
  categorie: [{ id: "cibo", nome: "Cibo", emoji: "🍕" }, { id: "casa", nome: "Casa", emoji: "🏠" }],
  speseMese: 886.05, entrateMese: 152.5, speseMesePrec: 279.2, deltaPct: 217,
  inArrivo: [{ descrizione: "Affitto", categoria: "casa", emoji: "🏠", days: 1, importo: 800, variabile: false }], inArrivoTotale: 3,
};
let n = 0;
async function run({ mode, query = {}, resp = [], h }) {
  responses = [...resp]; shown = []; requests = []; widgetTexts = []; widgetTextObjs = []; widgetSymbols = []; completed = false;
  handler = h || ((r) => (r.method === "POST" ? { ok: true } : data));
  globalThis.config = { runsInWidget: mode === "widget", runsInApp: mode !== "widget" };
  globalThis.args = { queryParameters: query };
  await import(pathToFileURL(`${OUT}/script_under_test.mjs`).href + `?n=${++n}`);
  assert.ok(completed, "Script.complete() not reached");
  assert.equal(responses.length, 0, `unused scripted responses: ${JSON.stringify(responses)}`);
}
const ok = () => {};

it("quick-add widget script: every flow", async () => {
// 1) widget render: the new layout
await run({ mode: "widget" });
const at = (t) => { const i = widgetTexts.indexOf(t); assert.ok(i >= 0, `missing text: ${t}`); return i; };
// order: header → patrimonio → month card → accounts card
assert.ok(at("FINANZA") < at("PATRIMONIO") && at("PATRIMONIO") < at("110.694,31") && at("110.694,31") < at("QUESTO MESE") && at("QUESTO MESE") < at("CONTI"));
// month card: delta pill, then three columns Uscite / Entrate / Saldo (saldo = entrate − uscite)
assert.ok(at("QUESTO MESE") < at("↑ 217% vs mese scorso") && at("↑ 217% vs mese scorso") < at("USCITE"));
assert.ok(at("USCITE") < at("886,05") && at("886,05") < at("ENTRATE") && at("ENTRATE") < at("152,50") && at("152,50") < at("SALDO") && at("SALDO") < at("−733,55"));
assert.ok(!widgetTexts.includes("▼") && !widgetTexts.includes("▲"), "old chips are gone");
// next bill sits under the stats, inside the month card, before the accounts card
assert.ok(at("−733,55") < at("Affitto") && at("Affitto") < at("· domani") && at("· domani") < at("+2 altre") && at("+2 altre") < at("CONTI"));
// accounts: total in the header, biggest first, the rest in one row, investments last
// sorted by balance: BBVA 28.980,17 and Revolut 404,07 are the top two; UniCredit 271,26 + Trade Republic 59,58 fold into one row
assert.ok(at("CONTI") < at("29.715,08") && at("29.715,08") < at("BBVA") && at("BBVA") < at("Revolut") && at("Revolut") < at("Altri 2 conti") && at("Altri 2 conti") < at("330,84") && at("330,84") < at("Investimenti") && at("Investimenti") < at("80.979,23"));
assert.ok(!widgetTexts.includes("Trade Republic") && !widgetTexts.includes("UniCredit"), "the smaller accounts are folded into 'Altri 2 conti'");
// the totals tie out: patrimonio = conti + investimenti
assert.equal(Math.round((29715.08 + 80979.23) * 100), Math.round(110694.31 * 100));
// SF Symbols instead of emoji
for (const sym of ["eurosign.circle", "eye", "arrow.up.right", "calendar", "building.columns", "square.stack.3d.up", "chart.line.uptrend.xyaxis", "minus", "plus"]) assert.ok(widgetSymbols.includes(sym), `symbol ${sym}`);
assert.ok(!widgetTexts.some(t => /[\u{1F300}-\u{1FAFF}]/u.test(t)), "no emoji in the rendered text");
ok("widget: new layout — order, three month columns, folded accounts, SF Symbols");

// 1-bis) FONT_SCALE scales every font in the widget together
const fontSizeOf = (text) => widgetTextObjs.find(t => t.text === text).font.s;
const baseSizes = Object.fromEntries(["110.694,31", "PATRIMONIO", "USCITE", "886,05", "BBVA", "FINANZA", "Uscita"].map(t => [t, fontSizeOf(t)]));
assert.equal(baseSizes["110.694,31"], 28);
const scaledSrc = SRC.replace("const FONT_SCALE = 1;", "const FONT_SCALE = 1.25;");
assert.notEqual(scaledSrc, SRC, "FONT_SCALE constant present");
fs.writeFileSync(`${OUT}/script_under_test.mjs`, scaledSrc);
await run({ mode: "widget" });
for (const [text, base] of Object.entries(baseSizes)) assert.equal(fontSizeOf(text), Math.round(base * 1.25 * 10) / 10, `${text} scales`);
fs.writeFileSync(`${OUT}/script_under_test.mjs`, SRC);
ok("FONT_SCALE 1.25 scales every text size by 25%");

// 1a) up to 3 accounts: all shown, no 'Altri' row
await run({ mode: "widget", h: () => ({ ...data, conti: data.conti.slice(0, 3) }) });
assert.ok(widgetTexts.includes("Trade Republic") && !widgetTexts.some(t => t.startsWith("Altri")));
// legacy emoji and unknown icons map to symbols; a symbol missing on this iOS just drops the icon
await run({ mode: "widget", h: () => ({ ...data, conti: [{ nome: "X", icona: "📱", saldo: 1 }, { nome: "Y", icona: "???", saldo: 2 }] }) });
assert.ok(widgetSymbols.includes("iphone") && widgetSymbols.includes("building.columns"));
missingSymbols = new Set(["banknote", "calendar"]);
await run({ mode: "widget" });
assert.ok(widgetTexts.includes("Affitto"), "still renders with unavailable symbols");
missingSymbols = new Set();
ok("widget: ≤3 accounts shown in full; legacy emoji/unknown icons map; missing symbols degrade");

// 1d) no investments → no divider row; no accounts and no investments → no accounts card
await run({ mode: "widget", h: () => ({ ...data, investimenti: 0 }) });
assert.ok(!widgetTexts.includes("Investimenti"));
await run({ mode: "widget", h: () => ({ ...data, investimenti: 0, conti: [] }) });
assert.ok(!widgetTexts.includes("CONTI"));
ok("widget: investments row and accounts card only when there's something to show");

// 1e) negative saldo vs positive
await run({ mode: "widget", h: () => ({ ...data, speseMese: 100, entrateMese: 300 }) });
assert.ok(widgetTexts.includes("200,00"));
ok("widget: positive month saldo");

// 1b) older server (no new fields) still renders, without the new lines
const old = { ...data }; delete old.deltaPct; delete old.inArrivo; delete old.inArrivoTotale; delete old.speseMesePrec;
await run({ mode: "widget", h: () => old });
assert.ok(!widgetTexts.some(t => t.includes("vs mese scorso")) && !widgetTexts.some(t => t.includes("Affitto")));
ok("widget: older API response (no new fields) still renders");

// 1c) negative delta and null delta
await run({ mode: "widget", h: () => ({ ...data, deltaPct: -12 }) });
assert.ok(widgetTexts.includes("↓ 12% vs mese scorso"));
await run({ mode: "widget", h: () => ({ ...data, deltaPct: null }) });
assert.ok(!widgetTexts.some(t => t.includes("vs mese scorso")));
ok("widget: ↓ for savings, nothing when there's no comparison");

// 2) first expense, no memory: full questions, payload checked
const today = (() => { const d = new Date(), p = x => String(x).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; })();
await run({ mode: "app", query: { add: "uscita" }, resp: [
  { idx: 0, fields: ["12,50", "Pizza"] },  // form
  { idx: 0 },                               // category: Cibo
  { idx: 1 },                               // who paid: Laura
  { idx: 1 },                               // split: equally
  { idx: 0 },                               // account: Banca
  { idx: 0 },                               // "Registrata" OK
] });
let post = requests.find(r => r.method === "POST");
assert.equal(post.url, "https://example.test/api/widget/transaction?key=TESTKEY");
assert.equal(post.headers["Idempotency-Key"], "uuid-1");
assert.deepEqual(post.body, { tipo: "uscita", importo: 12.5, descrizione: "Pizza", data: today, categoria: "cibo", pagatoDa: "l", splits: [{ personaId: "g", quota: 50 }, { personaId: "l", quota: 50 }], contoId: "c1" });
ok("first expense: all questions asked, local date + Idempotency-Key sent, splits sum to 100");
const saved = JSON.parse(files.get("/docs/finanza-widget-state.json"));
assert.deepEqual(saved.last.uscita, { pagatoDa: "l", split: "equa", contoId: "c1" });
ok("choices remembered after a successful save");

// 3) second expense: one-tap "same as last time"
await run({ mode: "app", query: { add: "uscita" }, resp: [
  { idx: 0, fields: ["8", ""] },
  { idx: 1 },                  // category: Casa
  { idx: 0 },                  // "Come l'ultima volta?" → Salva così
  { idx: 0 },                  // Registrata OK
] });
assert.equal(shown[2].title, "Come l'ultima volta?");
assert.equal(shown[2].message, "Paga: 👩 Laura\nDivisa equamente tra tutti (2)\nConto: 🏦 Banca");
post = requests.find(r => r.method === "POST");
assert.deepEqual(post.body, { tipo: "uscita", importo: 8, descrizione: "", data: today, categoria: "casa", pagatoDa: "l", splits: [{ personaId: "g", quota: 50 }, { personaId: "l", quota: 50 }], contoId: "c1" });
ok("second expense: amount + category + ONE tap, same payer/split/account");

// 3b) "Cambia" goes back to the full questions
await run({ mode: "app", query: { add: "uscita" }, resp: [
  { idx: 0, fields: ["5", ""] }, { idx: 0 },
  { idx: 1 },                  // Cambia
  { idx: 2 },                  // payer: Nessuno (personale)
  { idx: 2 },                  // account: Nessuno
  { idx: 0 },
] });
post = requests.find(r => r.method === "POST");
assert.equal(post.body.pagatoDa, undefined); assert.equal(post.body.splits, undefined); assert.equal(post.body.contoId, undefined);
ok("'Cambia' re-asks everything; personal expense has no payer/splits/account");

// 3c) a remembered account that no longer exists is not offered again
files.set("/docs/finanza-widget-state.json", JSON.stringify({ last: { uscita: { pagatoDa: "x-deleted", split: "equa", contoId: "c-deleted" } } }));
await run({ mode: "app", query: { add: "uscita" }, resp: [
  { idx: 0, fields: ["3", ""] }, { idx: 0 },
  { idx: 0 },                  // "Come l'ultima volta?" (personale, nessun conto)
  { idx: 0 },
] });
assert.equal(shown[2].message, "Personale\nNessun conto");
post = requests.find(r => r.method === "POST");
assert.equal(post.body.pagatoDa, undefined); assert.equal(post.body.contoId, undefined);
ok("stale memory (deleted person/account) is dropped, not resent");

// 4) income: remembered "intestata a" + account
await run({ mode: "app", query: { add: "entrata" }, resp: [
  { idx: 0, fields: ["1000", "Stipendio"] }, { idx: 1 }, { idx: 1 }, { idx: 0 },
] });
post = requests.find(r => r.method === "POST");
assert.deepEqual(post.body, { tipo: "entrata", importo: 1000, descrizione: "Stipendio", data: today, intestataA: "l", contoId: "c2" });
await run({ mode: "app", query: { add: "entrata" }, resp: [{ idx: 0, fields: ["50", ""] }, { idx: 0 }, { idx: 0 }] });
assert.equal(shown[1].message, "Intestata a: 👩 Laura\nConto: 💶 Contanti");
ok("income: asked once, then one tap");

// 5) server rejection shows its message, not [object Object]
await run({ mode: "app", query: { add: "entrata" }, resp: [{ idx: 0, fields: ["10", ""] }, { idx: 0 }, { idx: 0 }],
  h: (r) => r.method === "POST" ? { error: { code: "INVALID_AMOUNT", message: "Importo non valido" } } : data });
const err = shown.find(s => s.title === "Errore di salvataggio");
assert.equal(err.message, "Importo non valido");
ok("server error text is shown (not [object Object]); rejection isn't retried");

// 6) network failure → retry with the SAME Idempotency-Key
let calls = 0;
await run({ mode: "app", query: { add: "entrata" }, resp: [{ idx: 0, fields: ["10", ""] }, { idx: 0 /* come l'ultima volta */ }, { idx: 0 /* Riprova */ }, { idx: 0 /* Registrata */ }],
  h: (r) => { if (r.method !== "POST") return data; if (++calls === 1) throw new Error("The Internet connection appears to be offline"); return { ok: true }; } });
const posts = requests.filter(r => r.method === "POST");
assert.equal(posts.length, 2);
assert.equal(posts[0].headers["Idempotency-Key"], posts[1].headers["Idempotency-Key"]);
assert.ok(shown.some(s => s.title === "Connessione assente"));
ok("network drop: asks to retry, retry reuses the Idempotency-Key (no duplicate)");

// 6b) declining the retry ends with an error alert, one POST only
calls = 0;
await run({ mode: "app", query: { add: "entrata" }, resp: [{ idx: 0, fields: ["10", ""] }, { idx: 0 }, { idx: -1 /* declina il retry */ }, { idx: 0 /* errore */ }],
  h: (r) => { if (r.method !== "POST") return data; throw new Error("offline"); } });
assert.equal(requests.filter(r => r.method === "POST").length, 1);
ok("declining the retry stops after one attempt");

// 7) validation + cancel paths
await run({ mode: "app", query: { add: "uscita" }, resp: [{ idx: 0, fields: ["abc", ""] }, { idx: 0 }] });
assert.equal(shown[1].title, "Importo non valido");
await run({ mode: "app", query: { add: "uscita" }, resp: [{ idx: -1 }] });
assert.equal(requests.filter(r => r.method === "POST").length, 0);
ok("invalid amount rejected; cancel sends nothing");

// 8) eye toggle keeps the remembered choices
files.set("/docs/finanza-widget-state.json", JSON.stringify({ hidden: false, last: { uscita: { pagatoDa: "g", split: null, contoId: null } } }));
await run({ mode: "app", query: { toggle: "1" } });
const st = JSON.parse(files.get("/docs/finanza-widget-state.json"));
assert.equal(st.hidden, true); assert.equal(st.last.uscita.pagatoDa, "g");
assert.ok(widgetTexts.includes("••••"));
ok("hide toggle persists and keeps 'last' choices; amounts masked");
// hidden mode: every amount (incl. the accounts total in the card title and the saldo) is masked,
// names, the percentage and the due date stay readable
for (const amount of ["110.694,31", "886,05", "152,50", "−733,55", "29.715,08", "330,84", "80.979,23", "800,00"]) assert.ok(!widgetTexts.includes(amount), `amount still visible when hidden: ${amount}`);
for (const kept of ["BBVA", "Revolut", "Altri 2 conti", "Investimenti", "↑ 217% vs mese scorso", "Affitto", "· domani", "USCITE", "ENTRATE", "SALDO"]) assert.ok(widgetTexts.includes(kept), `missing when hidden: ${kept}`);
assert.ok(widgetSymbols.includes("eye.slash"), "eye.slash while hidden");
ok("hidden mode: all amounts masked, labels/percent/due date stay");

// 9) unconfigured placeholder
fs.writeFileSync(`${OUT}/script_under_test.mjs`, fs.readFileSync(SCRIPT_PATH, "utf8"));
await run({ mode: "widget" });
assert.ok(widgetTexts.includes("Configura WIDGET_URL nello script"));
ok("placeholder URL → 'Configura WIDGET_URL' message, no network call");


});
